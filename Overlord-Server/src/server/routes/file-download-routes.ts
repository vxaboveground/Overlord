import fs from "fs/promises";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { authenticateRequest } from "../../auth";
import { AuditAction, logAudit } from "../../auditLog";
import * as clientManager from "../../clientManager";
import { logger } from "../../logger";
import { encodeMessage } from "../../protocol";
import { getConfig } from "../../config";
import { isAuthorizedAgentRequest } from "../agent-auth";

type RequestIpProvider = {
  requestIP: (req: Request) => { address?: string } | null | undefined;
};

type PendingHttpDownload = {
  commandId: string;
  clientId: string;
  path: string;
  fileName: string;
  total: number;
  receivedBytes: number;
  receivedOffsets: Set<number>;
  receivedChunks: Set<number>;
  chunkSize: number;
  expectedChunks: number;
  loggedTotal?: boolean;
  loggedFirstChunk?: boolean;
  tmpPath: string;
  fileHandle: any;
  resolve: (entry: PendingHttpDownload) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type DownloadIntent = {
  id: string;
  userId: string;
  clientId: string;
  path: string;
  expiresAt: number;
  timeout: ReturnType<typeof setTimeout>;
};

type UploadIntent = {
  id: string;
  userId: string;
  clientId: string;
  path: string;
  fileName: string;
  expiresAt: number;
  timeout: ReturnType<typeof setTimeout>;
};

type UploadPull = {
  id: string;
  clientId: string;
  path: string;
  fileName: string;
  tmpPath: string;
  size: number;
  expiresAt: number;
  timeout: ReturnType<typeof setTimeout>;
};

type FileDownloadRouteDeps = {
  DATA_DIR: string;
  secureHeaders: (contentType?: string) => Record<string, string>;
  sanitizeOutputName: (name: string) => string;
  pendingHttpDownloads: Map<string, PendingHttpDownload>;
  downloadIntents: Map<string, DownloadIntent>;
};

export async function cleanupFileTransferTempFiles(dataDir: string): Promise<void> {
  const uploadsDir = path.join(dataDir, "uploads");
  const downloadsDir = path.join(dataDir, "downloads");
  await fs.rm(uploadsDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(downloadsDir, { recursive: true, force: true }).catch(() => {});
}

function streamFileAndDelete(tmpPath: string): ReadableStream<Uint8Array> {
  const reader = Bun.file(tmpPath).stream().getReader();
  let cleaned = false;

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await fs.unlink(tmpPath).catch(() => {});
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          await cleanup();
          return;
        }
        if (value) {
          controller.enqueue(value);
        }
      } catch (err) {
        controller.error(err);
        await cleanup();
      }
    },
    async cancel() {
      try {
        await reader.cancel();
      } catch {}
      await cleanup();
    },
  });
}

const UUID_TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uploadIntents = new Map<string, UploadIntent>();
const uploadPulls = new Map<string, UploadPull>();

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

// WAN uploads can be significantly slower than LAN transfers.
const FILE_UPLOAD_INTENT_TTL_MS = parsePositiveIntEnv(
  "OVERLORD_FILE_UPLOAD_INTENT_TTL_MS",
  30 * 60_000,
);
const FILE_UPLOAD_PULL_TTL_MS = parsePositiveIntEnv(
  "OVERLORD_FILE_UPLOAD_PULL_TTL_MS",
  30 * 60_000,
);

function isSafeRemotePath(value: string): boolean {
  if (!value || value.length > 4096) return false;
  return !/[\x00-\x1F\x7F]/.test(value);
}

async function serveDownloadById(
  req: Request,
  downloadId: string,
  server: RequestIpProvider,
  deps: FileDownloadRouteDeps,
): Promise<Response> {
  const user = await authenticateRequest(req);
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (user.role !== "admin" && user.role !== "operator") {
    return new Response("Forbidden: Admin or operator access required", { status: 403 });
  }

  logger.debug("[filebrowser] http download request", {
    downloadId,
    userId: user.userId,
    ip: server.requestIP(req)?.address || "unknown",
  });

  if (!UUID_TOKEN_RE.test(downloadId)) {
    return new Response("Bad request", { status: 400 });
  }

  const intent = deps.downloadIntents.get(downloadId);
  if (!intent || intent.userId !== user.userId || intent.expiresAt < Date.now()) {
    logger.debug("[filebrowser] http download intent missing", {
      downloadId,
      userId: user.userId,
      intentUserId: intent?.userId,
      expiresAt: intent?.expiresAt,
    });
    return new Response("Not found", { status: 404 });
  }

  deps.downloadIntents.delete(downloadId);
  clearTimeout(intent.timeout);

  const clientId = intent.clientId;
  const downloadPath = intent.path;

  const target = clientManager.getClient(clientId);
  if (!target) {
    logger.debug("[filebrowser] http download target offline", {
      downloadId,
      clientId,
    });
    return new Response("Client offline", { status: 404 });
  }

  const commandId = uuidv4();
  const downloadDir = path.join(deps.DATA_DIR, "downloads");
  await fs.mkdir(downloadDir, { recursive: true });
  const tmpPath = path.join(downloadDir, `${commandId}.bin`);

  let fileName = path.basename(downloadPath) || "download.bin";
  try {
    fileName = deps.sanitizeOutputName(fileName);
  } catch {
    fileName = "download.bin";
  }

  const fileHandle = await fs.open(tmpPath, "w+");

  logger.debug("[filebrowser] http download start", {
    commandId,
    clientId,
    path: downloadPath,
    tmpPath,
  });

  const downloadPromise = new Promise<PendingHttpDownload>((resolve, reject) => {
    const timeout = setTimeout(() => {
      deps.pendingHttpDownloads.delete(commandId);
      void fileHandle.close();
      void fs.unlink(tmpPath).catch(() => {});
      reject(new Error("Download timed out"));
    }, 5 * 60_000);

    deps.pendingHttpDownloads.set(commandId, {
      commandId,
      clientId,
      path: downloadPath,
      fileName,
      total: 0,
      receivedBytes: 0,
      receivedOffsets: new Set(),
      receivedChunks: new Set(),
      chunkSize: 0,
      expectedChunks: 0,
      loggedTotal: false,
      loggedFirstChunk: false,
      tmpPath,
      fileHandle,
      resolve,
      reject,
      timeout,
    });
  });

  target.ws.send(
    encodeMessage({
      type: "command",
      commandType: "file_download",
      id: commandId,
      payload: { path: downloadPath },
    }),
  );

  logger.debug("[filebrowser] http download command sent", {
    commandId,
    clientId,
    path: downloadPath,
  });

  logAudit({
    timestamp: Date.now(),
    username: user.username,
    ip: server.requestIP(req)?.address || "unknown",
    action: AuditAction.FILE_DOWNLOAD,
    targetClientId: clientId,
    details: JSON.stringify({ path: downloadPath, via: "http" }),
    success: true,
  });

  let completed: PendingHttpDownload;
  try {
    completed = await downloadPromise;
  } catch (err) {
    logger.debug("[filebrowser] http download failed", {
      commandId,
      clientId,
      path: downloadPath,
      error: (err as Error)?.message || String(err),
    });
    return new Response((err as Error).message || "Download failed", { status: 500 });
  }

  logger.debug("[filebrowser] http download complete", {
    commandId,
    clientId,
    path: downloadPath,
    total: completed.total,
    receivedBytes: completed.receivedBytes,
    expectedChunks: completed.expectedChunks,
    receivedChunks: completed.receivedChunks.size,
  });

  const headers = {
    ...deps.secureHeaders("application/octet-stream"),
    "Content-Disposition": `attachment; filename="${completed.fileName}"`,
    "Cache-Control": "no-store, private",
  };

  return new Response(streamFileAndDelete(completed.tmpPath), { headers });
}

export async function handleFileDownloadRoutes(
  req: Request,
  url: URL,
  server: RequestIpProvider,
  deps: FileDownloadRouteDeps,
): Promise<Response | null> {
  if (req.method === "POST" && url.pathname === "/api/file/upload/request") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (user.role !== "admin" && user.role !== "operator") {
      return new Response("Forbidden: Admin or operator access required", { status: 403 });
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    const clientId = typeof body?.clientId === "string" ? body.clientId.trim() : "";
    const uploadPath = typeof body?.path === "string" ? body.path.trim() : "";
    const fileName = typeof body?.fileName === "string" ? body.fileName.trim() : "upload.bin";
    if (!clientId || !uploadPath || !isSafeRemotePath(uploadPath)) {
      return new Response("Bad request", { status: 400 });
    }

    logger.debug("[filebrowser] http upload request", {
      userId: user.userId,
      clientId,
      path: uploadPath,
      fileName,
      ip: server.requestIP(req)?.address || "unknown",
    });

    const target = clientManager.getClient(clientId);
    if (!target) {
      return new Response("Client offline", { status: 404 });
    }

    const uploadId = uuidv4();
    const expiresAt = Date.now() + FILE_UPLOAD_INTENT_TTL_MS;
    const timeout = setTimeout(() => {
      uploadIntents.delete(uploadId);
    }, FILE_UPLOAD_INTENT_TTL_MS);

    uploadIntents.set(uploadId, {
      id: uploadId,
      userId: user.userId,
      clientId,
      path: uploadPath,
      fileName,
      expiresAt,
      timeout,
    });

    return Response.json({
      ok: true,
      uploadId,
      uploadUrl: `/api/file/upload/${encodeURIComponent(uploadId)}`,
    });
  }

  if ((req.method === "PUT" || req.method === "POST") && url.pathname.startsWith("/api/file/upload/")) {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (user.role !== "admin" && user.role !== "operator") {
      return new Response("Forbidden: Admin or operator access required", { status: 403 });
    }

    let uploadId = "";
    try {
      uploadId = decodeURIComponent(url.pathname.slice("/api/file/upload/".length));
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    if (!UUID_TOKEN_RE.test(uploadId)) {
      return new Response("Bad request", { status: 400 });
    }

    logger.debug("[filebrowser] http upload stage", {
      method: req.method,
      uploadId,
      userId: user.userId,
      ip: server.requestIP(req)?.address || "unknown",
    });

    const intent = uploadIntents.get(uploadId);
    if (!intent || intent.userId !== user.userId || intent.expiresAt < Date.now()) {
      return new Response("Not found", { status: 404 });
    }

    const uploadDir = path.join(deps.DATA_DIR, "uploads");
    await fs.mkdir(uploadDir, { recursive: true });
    const tmpPath = path.join(uploadDir, `${uploadId}.bin`);

    let stagedSize = 0;
    const fileHandle = await fs.open(tmpPath, "w");
    try {
      if (req.body) {
        const reader = req.body.getReader();
        let position = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          await fileHandle.write(value, 0, value.byteLength, position);
          position += value.byteLength;
          stagedSize += value.byteLength;
        }
      } else {
        const bytes = new Uint8Array(await req.arrayBuffer());
        if (bytes.byteLength > 0) {
          await fileHandle.write(bytes, 0, bytes.byteLength, 0);
          stagedSize = bytes.byteLength;
        }
      }
    } catch (err) {
      logger.debug("[filebrowser] http upload stage error", {
        uploadId,
        error: (err as Error)?.message || String(err),
      });
      await fileHandle.close();
      await fs.unlink(tmpPath).catch(() => {});
      return new Response("Upload staging failed", { status: 500 });
    }
    await fileHandle.close();

    logger.debug("[filebrowser] http upload staged bytes", {
      uploadId,
      bytes: stagedSize,
      clientId: intent.clientId,
      path: intent.path,
    });

    uploadIntents.delete(uploadId);
    clearTimeout(intent.timeout);

    const pullId = uuidv4();
    const pullExpiresAt = Date.now() + FILE_UPLOAD_PULL_TTL_MS;
    const pullTimeout = setTimeout(() => {
      const pull = uploadPulls.get(pullId);
      uploadPulls.delete(pullId);
      if (pull) {
        void fs.unlink(pull.tmpPath).catch(() => {});
      }
    }, FILE_UPLOAD_PULL_TTL_MS);

    uploadPulls.set(pullId, {
      id: pullId,
      clientId: intent.clientId,
      path: intent.path,
      fileName: intent.fileName,
      tmpPath,
      size: stagedSize,
      expiresAt: pullExpiresAt,
      timeout: pullTimeout,
    });

    return Response.json({
      ok: true,
      size: stagedSize,
      path: intent.path,
      pullUrl: `${url.origin}/api/file/upload/pull/${encodeURIComponent(pullId)}`,
    });
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/file/upload/pull/")) {
    const agentToken = getConfig().auth.agentToken;
    if (!isAuthorizedAgentRequest(req, url, agentToken)) {
      return new Response("Unauthorized", { status: 401 });
    }

    let pullId = "";
    try {
      pullId = decodeURIComponent(url.pathname.slice("/api/file/upload/pull/".length));
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    if (!UUID_TOKEN_RE.test(pullId)) {
      return new Response("Bad request", { status: 400 });
    }

    const pull = uploadPulls.get(pullId);
    if (!pull || pull.expiresAt < Date.now()) {
      return new Response("Not found", { status: 404 });
    }

    const requesterClientId = req.headers.get("x-overlord-client-id") || "";
    if (!requesterClientId || requesterClientId !== pull.clientId) {
      return new Response("Forbidden", { status: 403 });
    }

    logger.debug("[filebrowser] http upload pull", {
      pullId,
      clientId: pull.clientId,
      path: pull.path,
      bytes: pull.size,
      ip: server.requestIP(req)?.address || "unknown",
    });

    uploadPulls.delete(pullId);
    clearTimeout(pull.timeout);

    const headers = {
      ...deps.secureHeaders("application/octet-stream"),
      "Content-Disposition": `attachment; filename="${deps.sanitizeOutputName(path.basename(pull.fileName) || "upload.bin")}"`,
      "Cache-Control": "no-store, private",
      "Content-Length": String(pull.size),
    };

    return new Response(streamFileAndDelete(pull.tmpPath), { headers });
  }

  if (!url.pathname.startsWith("/api/file/download")) {
    return null;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/file/download/")) {
    let downloadId = "";
    try {
      downloadId = decodeURIComponent(url.pathname.slice("/api/file/download/".length));
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    return serveDownloadById(req, downloadId, server, deps);
  }

  if (req.method === "POST" && url.pathname === "/api/file/download") {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    const downloadId = typeof body?.downloadId === "string" ? body.downloadId : "";
    return serveDownloadById(req, downloadId, server, deps);
  }

  if (req.method === "POST" && url.pathname === "/api/file/download/request") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (user.role !== "admin" && user.role !== "operator") {
      return new Response("Forbidden: Admin or operator access required", { status: 403 });
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    const clientId = typeof body?.clientId === "string" ? body.clientId.trim() : "";
    const downloadPath = typeof body?.path === "string" ? body.path.trim() : "";
    if (!clientId || !downloadPath || !isSafeRemotePath(downloadPath)) {
      return new Response("Bad request", { status: 400 });
    }

    const target = clientManager.getClient(clientId);
    if (!target) {
      return new Response("Client offline", { status: 404 });
    }

    const downloadId = uuidv4();
    const expiresAt = Date.now() + 2 * 60_000;
    const timeout = setTimeout(() => {
      deps.downloadIntents.delete(downloadId);
    }, 2 * 60_000);

    deps.downloadIntents.set(downloadId, {
      id: downloadId,
      userId: user.userId,
      clientId,
      path: downloadPath,
      expiresAt,
      timeout,
    });

    return Response.json({
      ok: true,
      downloadId,
      downloadUrl: `/api/file/download/${encodeURIComponent(downloadId)}`,
    });
  }

  return null;
}
