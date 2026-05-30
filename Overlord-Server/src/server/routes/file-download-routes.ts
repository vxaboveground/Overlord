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
import { requireClientAccess, requireFeatureAccess, requirePermission } from "../../rbac";
import {
  FILE_UPLOAD_INTENT_TTL_MS,
  FILE_UPLOAD_PULL_TTL_MS,
  UUID_TOKEN_RE,
  isSafeRemotePath,
  makeIncrementalPullStream,
  notifyPullWaiters,
  streamFileRangeWithCleanup,
  uploadIntents,
  uploadPulls,
  waitForPullProgress,
  type DownloadIntent,
  type PendingHttpDownload,
  type StreamingPullState,
} from "../file-transfer-state";

type RequestIpProvider = {
  requestIP: (req: Request) => { address?: string } | null | undefined;
};

type FileDownloadRouteDeps = {
  DATA_DIR: string;
  secureHeaders: (contentType?: string) => Record<string, string>;
  sanitizeOutputName: (name: string) => string;
  pendingHttpDownloads: Map<string, PendingHttpDownload>;
  downloadIntents: Map<string, DownloadIntent>;
};

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
  try {
    requirePermission(user, "clients:control");
  } catch (error) {
    if (error instanceof Response) return error;
    return new Response("Forbidden", { status: 403 });
  }

  try {
    requireFeatureAccess(user, "file_browser");
  } catch (error) {
    if (error instanceof Response) return error;
    return new Response("Forbidden", { status: 403 });
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

  let fileName = path.basename(downloadPath) || "download.bin";
  try {
    fileName = deps.sanitizeOutputName(fileName);
  } catch {
    fileName = "download.bin";
  }

  logger.debug("[filebrowser] http download start", {
    commandId,
    clientId,
    path: downloadPath,
    mode: "stream",
  });

  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
    cancel() {
      const p = deps.pendingHttpDownloads.get(commandId);
      if (p) {
        clearTimeout(p.timeout);
        deps.pendingHttpDownloads.delete(commandId);
      }
      try {
        target.ws.send(encodeMessage({ type: "command_abort", commandId } as any));
      } catch {}
    },
  });

  let firstChunkResolve!: () => void;
  let firstChunkReject!: (err: Error) => void;
  const firstChunkPromise = new Promise<void>((resolve, reject) => {
    firstChunkResolve = resolve;
    firstChunkReject = reject;
  });

  const downloadPromise = new Promise<PendingHttpDownload>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const p = deps.pendingHttpDownloads.get(commandId);
      if (!p) return;
      deps.pendingHttpDownloads.delete(commandId);
      if (p.streamController && !p.streamErrored) {
        p.streamErrored = true;
        try { p.streamController.error(new Error("Download timed out")); } catch {}
      }
      firstChunkReject(new Error("Download timed out"));
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
      tmpPath: "",
      fileHandle: null,
      resolve,
      reject,
      timeout,
      streamController,
      reorderBuffer: new Map(),
      nextExpectedOffset: 0,
      onFirstChunk: () => firstChunkResolve(),
    });
  });

  downloadPromise
    .then((completed) => {
      logger.debug("[filebrowser] http download complete", {
        commandId,
        clientId,
        path: downloadPath,
        total: completed.total,
        receivedBytes: completed.receivedBytes,
        expectedChunks: completed.expectedChunks,
        receivedChunks: completed.receivedChunks.size,
        streamErrored: !!completed.streamErrored,
      });
    })
    .catch((err) => {
      logger.debug("[filebrowser] http download failed", {
        commandId,
        clientId,
        path: downloadPath,
        error: (err as Error)?.message || String(err),
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

  try {
    await firstChunkPromise;
  } catch (err) {
    return new Response((err as Error).message || "Download failed", { status: 500 });
  }

  const installed = deps.pendingHttpDownloads.get(commandId);
  if (installed?.streamErrored) {
    return new Response("Download failed", { status: 500 });
  }

  const headers: Record<string, string> = {
    ...deps.secureHeaders("application/octet-stream"),
    "Content-Disposition": `attachment; filename="${fileName}"`,
    "Cache-Control": "no-store, private",
  };
  const total = installed?.total ?? 0;
  if (total > 0) {
    headers["Content-Length"] = String(total);
  }

  return new Response(stream, { headers });
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
    try {
      requirePermission(user, "clients:control");
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

    const clientId = typeof body?.clientId === "string" ? body.clientId.trim() : "";
    const uploadPath = typeof body?.path === "string" ? body.path.trim() : "";
    const fileName = typeof body?.fileName === "string" ? body.fileName.trim() : "upload.bin";
    if (!clientId || !uploadPath || !isSafeRemotePath(uploadPath)) {
      return new Response("Bad request", { status: 400 });
    }

    try {
      requireClientAccess(user, clientId);
      requireFeatureAccess(user, "file_browser");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
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
    try {
      requirePermission(user, "clients:control");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    try {
      requireFeatureAccess(user, "file_browser");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
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

    const pullId = uuidv4();
    const tmpPath = path.join(uploadDir, `${pullId}.bin`);

    const contentLength = Number(req.headers.get("content-length") || 0);
    const expectedTotal = Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : 0;
    const canStream = !!req.body && expectedTotal > 0;

    const pullExpiresAt = Date.now() + FILE_UPLOAD_PULL_TTL_MS;
    const pullTimeout = setTimeout(() => {
      const stale = uploadPulls.get(pullId);
      uploadPulls.delete(pullId);
      if (stale && stale.deleteFile) {
        void fs.unlink(stale.tmpPath).catch(() => {});
      }
    }, FILE_UPLOAD_PULL_TTL_MS);

    const state: StreamingPullState | undefined = canStream
      ? { size: 0, done: false, error: null, waiters: [] }
      : undefined;

    uploadPulls.set(pullId, {
      id: pullId,
      clientId: intent.clientId,
      path: intent.path,
      fileName: intent.fileName,
      tmpPath,
      size: expectedTotal,
      expiresAt: pullExpiresAt,
      timeout: pullTimeout,
      deleteFile: true,
      state,
      expectedTotal,
    });

    uploadIntents.delete(uploadId);
    clearTimeout(intent.timeout);

    let agentCommandId: string | null = null;
    if (canStream) {
      const target = clientManager.getClient(intent.clientId);
      if (target) {
        agentCommandId = uuidv4();
        try {
          target.ws.send(
            encodeMessage({
              type: "command",
              commandType: "file_upload_http",
              id: agentCommandId,
              payload: {
                path: intent.path,
                url: `${url.origin}/api/file/upload/pull/${encodeURIComponent(pullId)}`,
                total: expectedTotal,
              },
            } as any),
          );
          logger.debug("[filebrowser] http upload eagerly notified agent", {
            uploadId,
            pullId,
            clientId: intent.clientId,
            total: expectedTotal,
            commandId: agentCommandId,
          });
        } catch (err) {
          logger.debug("[filebrowser] http upload eager notify failed", {
            uploadId,
            error: (err as Error)?.message || String(err),
          });
          agentCommandId = null;
        }
      }
    }

    let stagedSize = 0;
    const fileHandle = await fs.open(tmpPath, "w");
    try {
      if (req.body) {
        const reader = req.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          await fileHandle.write(value, 0, value.byteLength, stagedSize);
          stagedSize += value.byteLength;
          if (state) {
            state.size = stagedSize;
            notifyPullWaiters(state);
          }
        }
      } else {
        const bytes = new Uint8Array(await req.arrayBuffer());
        if (bytes.byteLength > 0) {
          await fileHandle.write(bytes, 0, bytes.byteLength, 0);
          stagedSize = bytes.byteLength;
          if (state) {
            state.size = stagedSize;
            notifyPullWaiters(state);
          }
        }
      }
    } catch (err) {
      logger.debug("[filebrowser] http upload stage error", {
        uploadId,
        error: (err as Error)?.message || String(err),
      });
      if (state) {
        state.error = err as Error;
        state.done = true;
        notifyPullWaiters(state);
      }
      await fileHandle.close();
      await fs.unlink(tmpPath).catch(() => {});
      uploadPulls.delete(pullId);
      clearTimeout(pullTimeout);
      return new Response("Upload staging failed", { status: 500 });
    }
    await fileHandle.close();

    if (state) {
      state.done = true;
      notifyPullWaiters(state);
    }
    const finalPull = uploadPulls.get(pullId);
    if (finalPull) {
      finalPull.size = stagedSize;
    }

    logger.debug("[filebrowser] http upload staged bytes", {
      uploadId,
      pullId,
      bytes: stagedSize,
      clientId: intent.clientId,
      path: intent.path,
      streamed: canStream,
    });

    return Response.json({
      ok: true,
      size: stagedSize,
      path: intent.path,
      pullUrl: `${url.origin}/api/file/upload/pull/${encodeURIComponent(pullId)}`,
      agentCommandId,
      agentNotified: !!agentCommandId,
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

    const rangeHeader = req.headers.get("range") || req.headers.get("Range") || "";

    logger.debug("[filebrowser] http upload pull", {
      pullId,
      clientId: pull.clientId,
      path: pull.path,
      bytes: pull.size,
      range: rangeHeader,
      ip: server.requestIP(req)?.address || "unknown",
    });

    const fileName = deps.sanitizeOutputName(path.basename(pull.fileName) || "upload.bin");
    const baseHeaders = {
      ...deps.secureHeaders("application/octet-stream"),
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store, private",
      "Accept-Ranges": "bytes",
    };

    if (pull.deleteFile) {
      const cleanupPull = async () => {
        const current = uploadPulls.get(pullId);
        if (current === pull) {
          uploadPulls.delete(pullId);
          clearTimeout(pull.timeout);
        }
        await fs.unlink(pull.tmpPath).catch(() => {});
      };

      if (pull.state && !rangeHeader) {
        const expected = pull.expectedTotal ?? pull.size;
        const stream = makeIncrementalPullStream(pull);
        const cleanupOnDone = stream.pipeThrough(new TransformStream({
          flush: async () => {
            await cleanupPull();
          },
        }));
        return new Response(cleanupOnDone, {
          headers: { ...baseHeaders, "Content-Length": String(expected) },
        });
      }

      if (pull.state && rangeHeader) {
        while (!pull.state.done && !pull.state.error) {
          await waitForPullProgress(pull.state);
        }
        if (pull.state.error) {
          await cleanupPull();
          return new Response("Upload streaming failed", { status: 500 });
        }
      }

      if (rangeHeader) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
        if (!match) {
          return new Response("Range Not Satisfiable", {
            status: 416,
            headers: { ...baseHeaders, "Content-Range": `bytes */${pull.size}` },
          });
        }
        const start = Number(match[1]);
        const end = match[2] === "" ? pull.size - 1 : Number(match[2]);
        if (
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          start < 0 ||
          end >= pull.size ||
          start > end
        ) {
          return new Response("Range Not Satisfiable", {
            status: 416,
            headers: { ...baseHeaders, "Content-Range": `bytes */${pull.size}` },
          });
        }
        const length = end - start + 1;
        return new Response(
          streamFileRangeWithCleanup(pull.tmpPath, start, end, cleanupPull),
          {
            status: 206,
            headers: {
              ...baseHeaders,
              "Content-Range": `bytes ${start}-${end}/${pull.size}`,
              "Content-Length": String(length),
            },
          },
        );
      }

      return new Response(
        streamFileRangeWithCleanup(pull.tmpPath, 0, Math.max(0, pull.size - 1), cleanupPull),
        {
          headers: { ...baseHeaders, "Content-Length": String(pull.size) },
        },
      );
    }

    if (rangeHeader) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
      if (!match) {
        return new Response("Range Not Satisfiable", {
          status: 416,
          headers: { ...baseHeaders, "Content-Range": `bytes */${pull.size}` },
        });
      }
      const start = Number(match[1]);
      const end = match[2] === "" ? pull.size - 1 : Number(match[2]);
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        end >= pull.size ||
        start > end
      ) {
        return new Response("Range Not Satisfiable", {
          status: 416,
          headers: { ...baseHeaders, "Content-Range": `bytes */${pull.size}` },
        });
      }
      const length = end - start + 1;
      const sliceStream = (Bun.file(pull.tmpPath) as any)
        .slice(start, end + 1)
        .stream();
      return new Response(sliceStream, {
        status: 206,
        headers: {
          ...baseHeaders,
          "Content-Range": `bytes ${start}-${end}/${pull.size}`,
          "Content-Length": String(length),
        },
      });
    }

    return new Response(Bun.file(pull.tmpPath).stream(), {
      headers: { ...baseHeaders, "Content-Length": String(pull.size) },
    });
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
    try {
      requirePermission(user, "clients:control");
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

    const clientId = typeof body?.clientId === "string" ? body.clientId.trim() : "";
    const downloadPath = typeof body?.path === "string" ? body.path.trim() : "";
    if (!clientId || !downloadPath || !isSafeRemotePath(downloadPath)) {
      return new Response("Bad request", { status: 400 });
    }

    try {
      requireClientAccess(user, clientId);
      requireFeatureAccess(user, "file_browser");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
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
