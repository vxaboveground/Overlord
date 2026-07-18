import type { ServerWebSocket } from "bun";
import { v4 as uuidv4 } from "uuid";
import { existsSync, readFileSync } from "fs";
import path from "path";
import * as clientManager from "../clientManager";
import { logger } from "../logger";
import { negotiateDesktopCodec } from "./desktop-codec-negotiation";
import { metrics } from "../metrics";
import { encodeMessage } from "../protocol";
import { resolveRuntimeRoot } from "./runtime-paths";
import * as sessionManager from "../sessions/sessionManager";
import type { ConsoleSession, RemoteDesktopViewer, SocketData } from "../sessions/types";
import type { ClientInfo } from "../types";
import { canUserAccessClient } from "../users";
import { setClientWebcamInfo } from "../db";
import { issueWebrtcPublishToken, webrtcStreamPathFor } from "./routes/webrtc-routes";
import { issueTurnIceServers } from "./turn-credentials";
import {
  buildViewerFrameBuffer,
  decodeViewerPayload,
  safeSendViewer,
} from "./ws-viewer-utils";
import {
  clearP2PSessionForViewer,
  createP2PSession,
  getP2PSessionIdForViewer,
  lookupP2PSession,
  type P2PSession,
} from "./webrtc-p2p-sessions";
import {
  getRemoteDesktopRecordingStatus,
  recordRemoteDesktopFrame,
  startRemoteDesktopRecording,
  stopRemoteDesktopRecording,
} from "./rd-recording";

let _cachedInjectionDll: Uint8Array | null = null;
let _dllCachePath: string | null = null;
let _dllCacheMtimeMs: number = 0;

let _cachedCaptureDll: Uint8Array | null = null;
let _captureDllCachePath: string | null = null;
let _captureDllCacheMtimeMs: number = 0;

function getInjectionDllBytes(): Uint8Array | null {
  const runtimeRoot = resolveRuntimeRoot();
  const candidates = [
    path.resolve(runtimeRoot, "dist-clients", "BackstageInjection.x64.dll"),
    path.resolve(process.cwd(), "dist-clients", "BackstageInjection.x64.dll"),
    path.resolve(import.meta.dir, "../../dist-clients/BackstageInjection.x64.dll"),
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
      logger.info(`[backstage] reloaded injection DLL from ${_dllCachePath} (${_cachedInjectionDll.length} bytes)`);
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
      logger.info(`[backstage] loaded injection DLL from ${dllPath} (${_cachedInjectionDll.length} bytes)`);
      return _cachedInjectionDll;
    } catch {
      continue;
    }
  }

  logger.warn(`[backstage] injection DLL not found. Checked: ${candidates.join(", ")}`);
  return null;
}

function getCaptureDllBytes(): Uint8Array | null {
  const runtimeRoot = resolveRuntimeRoot();
  const candidates = [
    path.resolve(runtimeRoot, "dist-clients", "BackstageCapture.x64.dll"),
    path.resolve(process.cwd(), "dist-clients", "BackstageCapture.x64.dll"),
    path.resolve(import.meta.dir, "../../dist-clients/BackstageCapture.x64.dll"),
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
      logger.info(`[backstage] reloaded capture DLL from ${_captureDllCachePath} (${_cachedCaptureDll.length} bytes)`);
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
      logger.info(`[backstage] loaded capture DLL from ${dllPath} (${_cachedCaptureDll.length} bytes)`);
      return _cachedCaptureDll;
    } catch {
      continue;
    }
  }

  return null;
}

const VIEWER_BACKPRESSURE_BYTES = Math.max(
  64 * 1024,
  Number(process.env.OVERLORD_MEDIA_VIEWER_BACKPRESSURE_BYTES || 512 * 1024),
);

type FrameBroadcastResult = {
  sent: boolean;
  dropped: boolean;
  viewers: number;
};

function broadcastFrameToViewers(
  sessions: Iterable<{ viewer: ServerWebSocket<SocketData> }>,
  buf: Uint8Array,
  header?: any,
): FrameBroadcastResult {
  let sent = false;
  let dropped = false;
  let viewers = 0;
  const t0 = performance.now();
  const byteLen = buf.length;
  for (const session of sessions) {
    viewers += 1;
    try {
      const buffered = session.viewer.getBufferedAmount?.() ?? 0;
      if (buffered > VIEWER_BACKPRESSURE_BYTES) {
        dropped = true;
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
  return { sent, dropped, viewers };
}

const rdSendStats = { lastLog: 0, frames: 0, sendMs: 0, bytes: 0 };
const rdDebugFrameLogAt = new Map<string, number>();
const rdCanvasFrameAckPending = new Map<string, string>();
export const rdStreamingState = new Map<string, {
  isStreaming: boolean;
  display: number;
  quality: number;
  codec: string;
  softwareH264: boolean;
  duplication: boolean;
  maxHeight: number;
  maxFps: number;
  bitrateMbps: number;
  bitrateAdaptive: boolean;
  lastFps: number;
  lastFrameAt: number;
  startedAt: number;
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

function defaultRdStreamingState() {
  return {
    isStreaming: false,
    display: 0,
    quality: 90,
    codec: "",
    softwareH264: false,
    duplication: false,
    maxHeight: 0,
    maxFps: 120,
    bitrateMbps: 0,
    bitrateAdaptive: false,
    lastFps: 0,
    lastFrameAt: 0,
    startedAt: 0,
  };
}

function clampDesktopFps(value: unknown): number {
  const fps = Math.floor(Number(value) || 120);
  return Math.max(1, Math.min(240, fps));
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
  if (!target) {
    logger.warn(`[rd-debug] send command skipped, target missing command=${commandType} id=${commandId}`);
    return false;
  }
  try {
    logger.debug(`[rd-debug] send command command=${commandType} client=${target.id} id=${commandId} payload=${JSON.stringify(payload || {})}`);
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
  const session: ConsoleSession = { id: effectiveSessionId, clientId, viewer: ws, createdAt: Date.now(), started: false };
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
  safeSendViewer(ws, { type: "ready", sessionId, clientId, clientOnline: !!target, os: target?.os ?? "", isAdmin: !!target?.isAdmin });
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

  const state = rdStreamingState.get(clientId) || defaultRdStreamingState();

  if (payload.type !== "desktop_decode_pressure") {
    logger.debug(`[rd] inbound viewer msg type=${payload.type} client=${clientId}`);
  }
  switch (payload.type) {
    case "desktop_encoder_capabilities":
      ws.data.rdDecoderCodecs = Array.isArray((payload as any).decoderCodecs)
        ? (payload as any).decoderCodecs.map((codec: unknown) => String(codec || "").trim().toLowerCase()).filter(Boolean).slice(0, 8)
        : ["h264", "jpeg", "raw"];
      ws.data.rdPreferredCodecs = Array.isArray((payload as any).preferredCodecs)
        ? (payload as any).preferredCodecs.map((codec: unknown) => String(codec || "").trim().toLowerCase()).filter(Boolean).slice(0, 8)
        : ["h264", "jpeg", "raw"];
      ws.data.rdCodecTransport = ["webrtc", "relayed", "p2p"].includes(String((payload as any).transport || "").toLowerCase())
        ? "webrtc"
        : "websocket";
      sendDesktopCommand(target, "desktop_encoder_capabilities", {
        display: Number((payload as any).display) || 0,
      });
      break;
    case "desktop_start":
      (ws.data as any).rdCanvasFlowControl = (payload as any).canvasFlowControl === true && (payload as any).webrtc !== true;
      (ws.data as any).rdCanvasBackpressure = false;
      releaseCanvasFrameAck(clientId);
      logger.debug(`[rd-debug] desktop_start requested client=${clientId} session=${ws.data.sessionId || ""} state=${JSON.stringify(state)} viewers=${sessionManager.getRdSessionsForClient(clientId).length} webrtc=${(payload as any).webrtc === true}`);
      if (!state.isStreaming) {
        const targetOs = String(target.os || "").toLowerCase();
        if ((targetOs.includes("darwin") || targetOs.includes("mac")) && target.permissions) {
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
        if ((payload as any).webrtc === true) {
          const streamPath = webrtcStreamPathFor(clientId, "desktop");
          const token = issueWebrtcPublishToken(clientId);
          const whipPath = `/api/webrtc/${streamPath}/whip`;
          sendDesktopCommand(target, "webrtc_publish", {
            streamPath,
            whipPath,
            token,
            kind: "desktop",
            hasVideo: true,
            hasAudio: false,
            iceServers: issueTurnIceServers(`${clientId}:desktop:whip`),
          });
          safeSendViewer(ws, {
            type: "webrtc_ready",
            streamPath,
            whepPath: `/api/webrtc/${streamPath}/whep`,
          });
        }
        safeSendViewer(ws, { type: "status", status: "starting" });
        sendDesktopCommand(target, "desktop_set_fps", { fps: clampDesktopFps(state.maxFps) });
        sendDesktopCommand(target, "desktop_set_bitrate", { bitrateMbps: state.bitrateMbps || 0, adaptive: state.bitrateAdaptive });
        sendDesktopCommand(target, "desktop_start", {});
        state.isStreaming = true;
        state.startedAt = Date.now();
        rdStreamingState.set(clientId, state);
        logger.debug(`[rd-debug] desktop_start forwarded client=${clientId} nextState=${JSON.stringify(state)} webrtc=${(payload as any).webrtc === true}`);
      } else {
        const lastFrameAgeMs = state.lastFrameAt ? Date.now() - state.lastFrameAt : Number.POSITIVE_INFINITY;
        const startAgeMs = state.startedAt ? Date.now() - state.startedAt : Number.POSITIVE_INFINITY;
        if (lastFrameAgeMs > 3000 && startAgeMs > 3000) {
          logger.info(`[rd-debug] desktop_start reasserting stale stream client=${clientId} lastFrameAgeMs=${Number.isFinite(lastFrameAgeMs) ? lastFrameAgeMs : -1} state=${JSON.stringify(state)} viewers=${sessionManager.getRdSessionsForClient(clientId).length}`);
          sendDesktopCommand(target, "desktop_set_fps", { fps: clampDesktopFps(state.maxFps) });
          sendDesktopCommand(target, "desktop_set_bitrate", { bitrateMbps: state.bitrateMbps || 0, adaptive: state.bitrateAdaptive });
          sendDesktopCommand(target, "desktop_start", {});
          safeSendViewer(ws, { type: "status", status: "starting" });
          state.isStreaming = true;
          state.startedAt = Date.now();
          rdStreamingState.set(clientId, state);
        } else {
          logger.debug(`[rd-debug] desktop_start already active client=${clientId} lastFrameAgeMs=${lastFrameAgeMs} startAgeMs=${startAgeMs} state=${JSON.stringify(state)} viewers=${sessionManager.getRdSessionsForClient(clientId).length}`);
          if (String(state.codec || "").toLowerCase() === "h264") {
            sendDesktopCommand(target, "desktop_request_keyframe", {
              reason: "viewer_start_existing_stream",
            });
          }
        }
      }
      break;
    case "desktop_stop": {
      (ws.data as any).rdCanvasFlowControl = false;
      (ws.data as any).rdCanvasBackpressure = false;
      releaseCanvasFrameAck(clientId);
      const otherViewers = sessionManager.getRdSessionsForClient(clientId)
        .filter(s => s.id !== ws.data.sessionId);
      logger.debug(`[rd-debug] desktop_stop requested client=${clientId} session=${ws.data.sessionId || ""} otherViewers=${otherViewers.length} state=${JSON.stringify(state)}`);
      if (otherViewers.length === 0) {
        stopRemoteDesktopRecording(clientId, "desktop stopped");
        sendDesktopCommand(target, "desktop_stop", {});
        sendDesktopCommand(target, "webrtc_stop", { kind: "desktop" });
        if (state.isStreaming) {
          state.isStreaming = false;
          state.startedAt = 0;
          state.lastFrameAt = 0;
          rdStreamingState.set(clientId, state);
          logger.debug(`[rd] stopped streaming for client ${clientId}`);
        } else {
          rdStreamingState.set(clientId, { ...state, isStreaming: false, startedAt: 0, lastFrameAt: 0 });
          logger.debug(`[rd] stop requested while not streaming for client ${clientId}`);
        }
      } else {
        logger.debug(`[rd] ignoring desktop_stop for client ${clientId} - ${otherViewers.length} other viewer(s) still active`);
      }
      safeSendViewer(ws, { type: "status", status: "stopped" });
      break;
    }
    case "desktop_record_start": {
      if (!state.isStreaming) {
        safeSendViewer(ws, {
          type: "recording_status",
          recording: null,
          error: "Start the remote desktop stream before recording.",
        });
        break;
      }
      if (String(state.codec || "").toLowerCase() === "hevc") {
        safeSendViewer(ws, {
          type: "recording_status",
          recording: null,
          error: "HEVC stream recording is not supported yet. Switch the stream codec to H.264 or JPEG first.",
        });
        break;
      }
      const inputCodec = String(state.codec || "").toLowerCase() === "h264" ? "h264" : "mjpeg";
      const compact = !!(payload as any).compact;
      const requestedFps = Number((payload as any).fps) || 0;
      logger.debug(`[rd] recording start requested client=${clientId} current_quality=${state.quality || 90} current_codec=${state.codec || "(default)"} current_duplication=${!!state.duplication} recorder_input=${inputCodec} compact=${compact} requested_fps=${requestedFps || "source"} source_fps=${state.lastFps || 0} stream_unchanged=true`);
      if (inputCodec === "h264") {
        sendDesktopCommand(target, "desktop_request_keyframe", {
          reason: "server_recording",
        });
      }
      const recording = startRemoteDesktopRecording({
        clientId,
        requestedByUserId: ws.data.userId,
        requestedByUsername: (ws.data as any).username,
        fps: requestedFps || undefined,
        sourceFps: inputCodec === "h264" ? (state.lastFps || undefined) : undefined,
        inputCodec,
        compact,
      });
      safeSendViewer(ws, { type: "recording_status", recording });
      break;
    }
    case "desktop_record_stop": {
      logger.debug(`[rd] recording stop requested client=${clientId} current_quality=${state.quality || 90} current_codec=${state.codec || "(default)"} current_duplication=${!!state.duplication}`);
      const recording = stopRemoteDesktopRecording(clientId, "stopped");
      safeSendViewer(ws, { type: "recording_status", recording: recording || getRemoteDesktopRecordingStatus(clientId) });
      break;
    }
    case "desktop_record_status": {
      safeSendViewer(ws, { type: "recording_status", recording: getRemoteDesktopRecordingStatus(clientId) });
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
      const newSoftwareH264 = newCodec === "h264" && !!(payload as any).softwareH264;
      const reason = typeof payload.reason === "string"
        ? payload.reason.slice(0, 512)
        : "";
      const source = typeof payload.source === "string"
        ? payload.source.slice(0, 128)
        : "";
      if (state.quality !== newQuality || state.codec !== newCodec || state.softwareH264 !== newSoftwareH264) {
        sendDesktopCommand(target, "desktop_set_quality", {
          quality: newQuality,
          codec: newCodec,
          softwareH264: newSoftwareH264,
          ...(reason ? { reason } : {}),
          ...(source ? { source } : {}),
        });
        state.quality = newQuality;
        state.codec = newCodec;
        state.softwareH264 = newSoftwareH264;
        rdStreamingState.set(clientId, state);
        logger.debug(`[rd] set quality=${newQuality} codec=${newCodec || "(default)"} software_h264=${newSoftwareH264}${source ? ` source=${source}` : ""}${reason ? ` reason=${reason}` : ""}`);
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
    case "desktop_set_profile": {
      const newMaxHeight = Number((payload as any).maxHeight) || 0;
      const newMaxFps = clampDesktopFps((payload as any).fps);
      if (state.maxHeight !== newMaxHeight || state.maxFps !== newMaxFps) {
        sendDesktopCommand(target, "desktop_set_profile", { maxHeight: newMaxHeight, fps: newMaxFps });
        state.maxHeight = newMaxHeight;
        state.maxFps = newMaxFps;
        rdStreamingState.set(clientId, state);
        logger.debug(`[rd] set stream profile max_height=${newMaxHeight} fps=${newMaxFps}`);
      }
      break;
    }
    case "desktop_set_fps": {
      const newMaxFps = clampDesktopFps((payload as any).fps);
      if (state.maxFps !== newMaxFps) {
        sendDesktopCommand(target, "desktop_set_fps", { fps: newMaxFps });
        state.maxFps = newMaxFps;
        rdStreamingState.set(clientId, state);
        logger.debug(`[rd] set target fps=${newMaxFps}`);
      }
      break;
    }
    case "desktop_decode_pressure": {
      if (!(ws.data as any).rdCanvasFlowControl) break;
      const active = (payload as any).active === true;
      (ws.data as any).rdCanvasBackpressure = active;
      if (!active) releaseCanvasFrameAck(clientId, ws.data.sessionId);
      break;
    }
    case "desktop_set_bitrate": {
      const newBitrateMbps = Math.max(0, Math.min(50, Math.floor(Number((payload as any).bitrateMbps) || 0)));
      const adaptive = (payload as any).adaptive === true;
      if (state.bitrateMbps !== newBitrateMbps || state.bitrateAdaptive !== adaptive) {
        sendDesktopCommand(target, "desktop_set_bitrate", { bitrateMbps: newBitrateMbps, adaptive });
        state.bitrateMbps = newBitrateMbps;
        state.bitrateAdaptive = adaptive;
        rdStreamingState.set(clientId, state);
        logger.debug(`[rd] set target bitrate=${newBitrateMbps || "auto"} Mbps adaptive=${adaptive}`);
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
    case "privacy_start":
      sendDesktopCommand(target, "privacy_start", {});
      break;
    case "privacy_stop":
      sendDesktopCommand(target, "privacy_stop", {});
      break;
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
    case "mouse_wheel": {
      if (!state.isStreaming) break;
      const commandId = uuidv4();
      recordRdInput(commandId, clientId, "mouse_wheel");
      sendDesktopCommandWithId(target, "desktop_mouse_wheel", { delta: Number(payload.delta) || 0, x: Number((payload as any).x) || 0, y: Number((payload as any).y) || 0 }, commandId);
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
    case "webrtc_p2p_offer": {
      const sdp = typeof (payload as any).sdp === "string" ? (payload as any).sdp : "";
      if (!sdp) break;
      const sessionId = createP2PSession(ws, clientId, "desktop");
      sendDesktopCommand(target, "webrtc_p2p_offer", { sessionId, sdp, kind: "desktop", hasVideo: true, hasAudio: false, iceServers: issueTurnIceServers(`${clientId}:desktop:${sessionId}`) });
      break;
    }
    case "webrtc_p2p_ice": {
      const sessionId = getP2PSessionIdForViewer(ws);
      if (!sessionId) break;
      const candidate = typeof (payload as any).candidate === "string" ? (payload as any).candidate : "";
      if (!candidate) break;
      sendDesktopCommand(target, "webrtc_p2p_ice", {
        sessionId,
        kind: "desktop",
        candidate,
        sdpMid: typeof (payload as any).sdpMid === "string" ? (payload as any).sdpMid : "",
        sdpMLineIndex: Number((payload as any).sdpMLineIndex) || 0,
      });
      break;
    }
    case "webrtc_p2p_stop": {
      const cleared = clearP2PSessionForViewer(ws);
      if (cleared) {
        sendDesktopCommand(target, "webrtc_p2p_stop", { sessionId: cleared.sessionId, kind: cleared.kind });
      }
      break;
    }
    default:
      break;
  }
}

function sendP2PSignalingToViewer(session: P2PSession, msg: Record<string, unknown>) {
  if (session.kind === "audio") {
    try { session.viewer.send(JSON.stringify(msg)); } catch (err) {
      logger.error("[audio] p2p signaling send failed", err);
    }
    return;
  }
  safeSendViewer(session.viewer, msg);
}

export function handleWebrtcP2PAnswer(_clientId: string, payload: any) {
  const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
  const sdp = typeof payload?.sdp === "string" ? payload.sdp : "";
  if (!sessionId || !sdp) return;
  const session = lookupP2PSession(sessionId);
  if (!session) return;
  sendP2PSignalingToViewer(session, { type: "webrtc_p2p_answer", sdp });
}

export function handleWebrtcP2PIce(_clientId: string, payload: any) {
  const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
  const candidate = typeof payload?.candidate === "string" ? payload.candidate : "";
  if (!sessionId || !candidate) return;
  const session = lookupP2PSession(sessionId);
  if (!session) return;
  sendP2PSignalingToViewer(session, {
    type: "webrtc_p2p_ice",
    candidate,
    sdpMid: typeof payload?.sdpMid === "string" ? payload.sdpMid : "",
    sdpMLineIndex: Number(payload?.sdpMLineIndex) || 0,
  });
}

export function cleanupViewerP2P(ws: ServerWebSocket<SocketData>) {
  if (ws.data.role === "rd_viewer") {
    (ws.data as any).rdCanvasFlowControl = false;
    (ws.data as any).rdCanvasBackpressure = false;
    releaseCanvasFrameAck(ws.data.clientId, ws.data.sessionId);
  }
  const cleared = clearP2PSessionForViewer(ws);
  if (!cleared) return;
  const target = clientManager.getClient(cleared.clientId);
  if (target) {
    sendDesktopCommand(target, "webrtc_p2p_stop", { sessionId: cleared.sessionId, kind: cleared.kind });
  }
}

export const cleanupRdViewerP2P = cleanupViewerP2P;

function handleRemoteDesktopFrame(payload: any) {
  const clientId = payload.clientId as string;
  const header = payload.header;
  const bytes = payload.data as Uint8Array;
  const state = rdStreamingState.get(clientId) || defaultRdStreamingState();
  if (!state.isStreaming) {
    state.isStreaming = true;
    state.startedAt = Date.now();
  }
  const frameFps = Number(header?.fps) || 0;
  if (frameFps > 0) state.lastFps = frameFps;
  state.lastFrameAt = Date.now();
  rdStreamingState.set(clientId, state);
  const now = Date.now();
  const lastDebugFrameLog = rdDebugFrameLogAt.get(clientId) || 0;
  if (!lastDebugFrameLog || now - lastDebugFrameLog >= 2000) {
    rdDebugFrameLogAt.set(clientId, now);
    logger.debug(`[rd-debug] frame received client=${clientId} bytes=${bytes?.byteLength || 0} fps=${frameFps || 0} viewers=${sessionManager.getRdSessionsForClient(clientId).length} header=${JSON.stringify(header || {})}`);
  }
  broadcastRemoteDesktopFrame(clientId, bytes, header);
}

function broadcastRemoteDesktopFrame(clientId: string, bytes: Uint8Array, header?: any): boolean {
  const frameFps = Number(header?.fps) || 0;
  if (frameFps > 0) {
    const state = rdStreamingState.get(clientId) || { ...defaultRdStreamingState(), isStreaming: true };
    state.lastFps = frameFps;
    state.lastFrameAt = Date.now();
    rdStreamingState.set(clientId, state);
  }
  recordRemoteDesktopFrame(clientId, header, bytes);
  const buf = buildViewerFrameBuffer(bytes, header);
  const sessions = sessionManager.getRdSessionsForClient(clientId);
  const result = broadcastFrameToViewers(sessions, buf, header);
  if (result.sent) {
    const controller = sessions.find((session) =>
      (session.viewer.data as any).rdCanvasFlowControl === true &&
      (session.viewer.data as any).rdCanvasBackpressure === true
    );
    if (controller?.viewer.data.sessionId) {
      rdCanvasFrameAckPending.set(clientId, controller.viewer.data.sessionId);
    }
  }
  if (result.dropped) {
    const target = clientManager.getClient(clientId);
    if (target) {
      sendDesktopCommand(target, "desktop_request_keyframe", {
        reason: "viewer_backpressure",
        format: String(header?.format || ""),
      });
    }
  }
  return (result.sent && !rdCanvasFrameAckPending.has(clientId)) || result.viewers === 0;
}

(globalThis as any).__rdBroadcast = (clientId: string, bytes: Uint8Array, header?: any): boolean => {
  return broadcastRemoteDesktopFrame(clientId, bytes, header);
};

type backstageStreamingState = {
  isStreaming: boolean;
  virtualMode: boolean;
  display: number;
  quality: number;
  codec: string;
  maxFps: number;
  lastFps: number;
};

function defaultbackstageStreamingState(): backstageStreamingState {
  return { isStreaming: false, virtualMode: false, display: 0, quality: 90, codec: "", maxFps: 120, lastFps: 0 };
}

export const backstageStreamingState = new Map<string, backstageStreamingState>();
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
  safeSendViewer(ws, { type: "ready", sessionId, clientId, clientOnline: !!target, os: target?.os ?? "", isAdmin: !!target?.isAdmin });
  if (!target) {
    safeSendViewer(ws, { type: "status", status: "offline", reason: "Client is offline", sessionId });
    return;
  }
  safeSendViewer(ws, { type: "status", status: "online", sessionId });
  sendDesktopCommand(target, "webcam_list", {});
}

export function handleWebcamDevices(clientId: string, payload: any) {
  const devices = Array.isArray(payload?.devices)
    ? payload.devices.slice(0, 32).map((device: any, index: number) => ({
      index: Number.isFinite(Number(device?.index)) ? Number(device.index) : index,
      name: String(device?.name || `Camera ${index + 1}`).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").slice(0, 160),
      ...(Number.isFinite(Number(device?.maxFps)) && Number(device.maxFps) > 0
        ? { maxFps: Math.min(240, Math.round(Number(device.maxFps))) }
        : {}),
    }))
    : [];
  const target = clientManager.getClient(clientId);
  if (target) {
    target.webcamAvailable = devices.length > 0;
    target.webcamDevices = devices;
  }
  setClientWebcamInfo(clientId, devices.length > 0, devices);
  for (const session of sessionManager.getWebcamSessionsForClient(clientId)) {
    safeSendViewer(session.viewer, { ...payload, devices });
  }
}

export function handlebackstageCloneProgress(clientId: string, payload: any) {
  for (const session of sessionManager.getbackstageSessionsForClient(clientId)) {
    safeSendViewer(session.viewer, {
      type: "backstage_clone_progress",
      browser: String(payload.browser || ""),
      percent: Number(payload.percent) || 0,
      copiedBytes: Number(payload.copiedBytes) || 0,
      totalBytes: Number(payload.totalBytes) || 0,
      status: String(payload.status || ""),
    });
  }
}

export function handlebackstageLookupResult(clientId: string, payload: any) {
  for (const session of sessionManager.getbackstageSessionsForClient(clientId)) {
    safeSendViewer(session.viewer, {
      type: "backstage_lookup_result",
      exe: String(payload.exe || ""),
      path: String(payload.path || ""),
      done: !!payload.done,
    });
  }
}

export function handlebackstageBrowserCheckResult(clientId: string, payload: any) {
  const browsers: Record<string, boolean> = {};
  if (payload.browsers && typeof payload.browsers === "object") {
    for (const [key, val] of Object.entries(payload.browsers)) {
      browsers[key] = !!val;
    }
  }
  for (const session of sessionManager.getbackstageSessionsForClient(clientId)) {
    safeSendViewer(session.viewer, {
      type: "backstage_browser_check_result",
      browsers,
    });
  }
}

export function handlebackstageInstalledAppsResult(clientId: string, payload: any) {
  const apps: Array<{ name: string; exePath: string; icon: string }> = [];
  if (Array.isArray(payload.apps)) {
    for (const app of payload.apps) {
      apps.push({
        name: String(app.name || ""),
        exePath: String(app.exePath || ""),
        icon: String(app.icon || ""),
      });
    }
  }
  for (const session of sessionManager.getbackstageSessionsForClient(clientId)) {
    safeSendViewer(session.viewer, {
      type: "backstage_installed_apps_result",
      apps,
      done: !!payload.done,
    });
  }
}

export function handlebackstageDXGIStatus(clientId: string, payload: any) {
  for (const session of sessionManager.getbackstageSessionsForClient(clientId)) {
    safeSendViewer(session.viewer, {
      type: "backstage_dxgi_status",
      success: !!payload.success,
      gpuPid: Number(payload.gpuPid) || 0,
      message: String(payload.message || ""),
    });
  }
}

export function handlebackstageBrowserLaunchStatus(clientId: string, payload: any) {
  for (const session of sessionManager.getbackstageSessionsForClient(clientId)) {
    safeSendViewer(session.viewer, {
      type: "backstage_browser_launch_status",
      browser: String(payload.browser || ""),
      step: String(payload.step || ""),
      success: !!payload.success,
      detail: String(payload.detail || ""),
    });
  }
}

export function handlebackstageWindowListResult(clientId: string, payload: any) {
  const windows: Array<{
    title: string; x: number; y: number; width: number; height: number;
    pid: number; processName: string; monitor: number;
  }> = [];
  if (Array.isArray(payload.windows)) {
    for (const w of payload.windows) {
      windows.push({
        title: String(w.title || ""),
        x: Number(w.x) || 0,
        y: Number(w.y) || 0,
        width: Number(w.width) || 0,
        height: Number(w.height) || 0,
        pid: Number(w.pid) || 0,
        processName: String(w.processName || ""),
        monitor: Number(w.monitor ?? -1),
      });
    }
  }
  const monitors: Array<{
    index: number; name: string; x: number; y: number;
    width: number; height: number; primary: boolean;
  }> = [];
  if (Array.isArray(payload.monitors)) {
    for (const m of payload.monitors) {
      monitors.push({
        index: Number(m.index) || 0,
        name: String(m.name || ""),
        x: Number(m.x) || 0,
        y: Number(m.y) || 0,
        width: Number(m.width) || 0,
        height: Number(m.height) || 0,
        primary: !!m.primary,
      });
    }
  }
  for (const session of sessionManager.getbackstageSessionsForClient(clientId)) {
    safeSendViewer(session.viewer, { type: "backstage_window_list_result", windows, monitors });
  }
}

export function handleClipboardContent(clientId: string, payload: any) {
  const text = String(payload.text || "");
  const source = String(payload.source || "");
  if (!text) return;
  if (source === "backstage") {
    for (const session of sessionManager.getbackstageSessionsForClient(clientId)) {
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
        if ((payload as any).webrtc === true) {
          const streamPath = webrtcStreamPathFor(clientId, "webcam");
          const token = issueWebrtcPublishToken(clientId);
          sendDesktopCommand(target, "webrtc_publish", {
            streamPath,
            whipPath: `/api/webrtc/${streamPath}/whip`,
            token,
            kind: "webcam",
            hasVideo: true,
            hasAudio: false,
            iceServers: issueTurnIceServers(`${clientId}:webcam:whip`),
          });
          safeSendViewer(ws, {
            type: "webrtc_ready",
            streamPath,
            whepPath: `/api/webrtc/${streamPath}/whep`,
          });
        }
        safeSendViewer(ws, { type: "status", status: "starting" });
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
        sendDesktopCommand(target, "webrtc_stop", { kind: "webcam" });
        state.isStreaming = false;
        webcamStreamingState.set(clientId, state);
      } else {
        logger.debug(`[webcam] ignoring webcam_stop for client ${clientId} - ${otherWebcamViewers.length} other viewer(s) still active`);
      }
      safeSendViewer(ws, { type: "status", status: "stopped" });
      break;
    }
    case "webrtc_p2p_offer": {
      const sdp = typeof (payload as any).sdp === "string" ? (payload as any).sdp : "";
      if (!sdp) break;
      const sessionId = createP2PSession(ws, clientId, "webcam");
      sendDesktopCommand(target, "webrtc_p2p_offer", { sessionId, sdp, kind: "webcam", hasVideo: true, hasAudio: false, iceServers: issueTurnIceServers(`${clientId}:webcam:${sessionId}`) });
      break;
    }
    case "webrtc_p2p_ice": {
      const sessionId = getP2PSessionIdForViewer(ws);
      if (!sessionId) break;
      const candidate = typeof (payload as any).candidate === "string" ? (payload as any).candidate : "";
      if (!candidate) break;
      sendDesktopCommand(target, "webrtc_p2p_ice", {
        sessionId,
        kind: "webcam",
        candidate,
        sdpMid: typeof (payload as any).sdpMid === "string" ? (payload as any).sdpMid : "",
        sdpMLineIndex: Number((payload as any).sdpMLineIndex) || 0,
      });
      break;
    }
    case "webrtc_p2p_stop": {
      const cleared = clearP2PSessionForViewer(ws);
      if (cleared) {
        sendDesktopCommand(target, "webrtc_p2p_stop", { sessionId: cleared.sessionId, kind: cleared.kind });
      }
      break;
    }
    default:
      break;
  }
}

export function handlebackstageViewerOpen(ws: ServerWebSocket<SocketData>) {
  const { clientId, userId, userRole } = ws.data;
  if (userId !== undefined && userRole && !canUserAccessClient(userId, userRole as any, clientId)) {
    ws.close(1008, "Forbidden: client access denied");
    return;
  }
  const sessionId = uuidv4();
  ws.data.sessionId = sessionId;
  const target = clientManager.getClient(clientId);
  const session: RemoteDesktopViewer = { id: sessionId, clientId, viewer: ws, createdAt: Date.now() };
  sessionManager.addbackstageSession(session);
  safeSendViewer(ws, { type: "ready", sessionId, clientId, clientOnline: !!target });
  if (!target) {
    safeSendViewer(ws, { type: "status", status: "offline", reason: "Client is offline", sessionId });
    return;
  }
  safeSendViewer(ws, { type: "status", status: "connecting", sessionId });
}

function notifybackstageStatus(clientId: string, status: string, reason?: string) {
  for (const session of sessionManager.getbackstageSessionsForClient(clientId)) {
    safeSendViewer(session.viewer, {
      type: "status",
      status,
      reason,
      sessionId: session.id,
    });
  }
}

export function handlebackstageViewerMessage(ws: ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) {
  const payload = decodeViewerPayload(raw);
  if (!payload) return;
  if (!payload || typeof payload.type !== "string") return;
  const { clientId } = ws.data;
  const target = clientManager.getClient(clientId);
  if (!target) {
    safeSendViewer(ws, { type: "status", status: "offline" });
    return;
  }

  const state = backstageStreamingState.get(clientId) || defaultbackstageStreamingState();

  logger.debug(`[backstage] inbound viewer msg type=${payload.type} client=${clientId}`);
  switch (payload.type) {
    case "backstage_start":
      {
        const virtualMode = (payload as any).virtual_mode === true || (payload as any).hidden_mode === true;
        if (state.isStreaming && state.virtualMode !== virtualMode) {
          sendbackstageCommand(target, "backstage_stop", {});
          state.isStreaming = false;
          logger.debug(`[backstage] restarting stream to change virtual_mode=${state.virtualMode} -> ${virtualMode}`);
        }
      if (!state.isStreaming) {
        if ((payload as any).webrtc === true) {
          const streamPath = webrtcStreamPathFor(clientId, "backstage");
          const token = issueWebrtcPublishToken(clientId);
          sendbackstageCommand(target, "webrtc_publish", {
            streamPath,
            whipPath: `/api/webrtc/${streamPath}/whip`,
            token,
            kind: "backstage",
            hasVideo: true,
            hasAudio: false,
            iceServers: issueTurnIceServers(`${clientId}:backstage:whip`),
          });
          safeSendViewer(ws, {
            type: "webrtc_ready",
            streamPath,
            whepPath: `/api/webrtc/${streamPath}/whep`,
          });
        }
        sendbackstageCommand(target, "backstage_set_fps", { fps: clampDesktopFps(state.maxFps) });
        sendbackstageCommand(target, "backstage_start", {
          autoStartExplorer: false,
          ...(virtualMode ? { virtual_mode: true } : {}),
        });
        state.isStreaming = true;
        state.virtualMode = virtualMode;
        backstageStreamingState.set(clientId, state);
        logger.debug(`[backstage] started streaming for client ${clientId} (virtual_mode=${virtualMode})`);
      } else {
        logger.debug(`[backstage] ignoring duplicate backstage_start for client ${clientId}`);
      }
      }
      break;
    case "backstage_stop": {
      const otherbackstageViewers = sessionManager.getbackstageSessionsForClient(clientId)
        .filter(s => s.id !== ws.data.sessionId);
      if (otherbackstageViewers.length === 0) {
        sendbackstageCommand(target, "backstage_stop", {});
        sendbackstageCommand(target, "webrtc_stop", { kind: "backstage" });
        state.isStreaming = false;
        backstageStreamingState.set(clientId, state);
        logger.debug(`[backstage] stopped streaming for client ${clientId}`);
      } else {
        logger.debug(`[backstage] ignoring backstage_stop for client ${clientId} - ${otherbackstageViewers.length} other viewer(s) still active`);
      }
      break;
    }
    case "backstage_select_display": {
      const newDisplay = Number(payload.display) || 0;
      if (state.display !== newDisplay) {
        logger.debug(`[backstage] changing display from ${state.display} to ${newDisplay}`);
        sendbackstageCommand(target, "backstage_select_display", { display: newDisplay });
        state.display = newDisplay;
        backstageStreamingState.set(clientId, state);
      } else {
        logger.debug(`[backstage] ignoring duplicate display select ${newDisplay}`);
      }
      break;
    }
    case "backstage_set_quality": {
      const newQuality = Number(payload.quality) || 90;
      const newCodec = String(payload.codec || "").toLowerCase();
		sendbackstageCommand(target, "backstage_set_quality", { quality: newQuality, codec: newCodec });
		if (state.quality !== newQuality || state.codec !== newCodec) {
        state.quality = newQuality;
        state.codec = newCodec;
        backstageStreamingState.set(clientId, state);
        logger.debug(`[backstage] set quality=${newQuality} codec=${newCodec || "(default)"}`);
      }
      break;
    }
    case "backstage_request_keyframe":
      if (state.isStreaming) {
        sendbackstageCommand(target, "backstage_request_keyframe", {
          reason: String((payload as any).reason || "viewer_request"),
        });
      }
      break;
    case "backstage_set_fps": {
      const newMaxFps = clampDesktopFps((payload as any).fps);
	  sendbackstageCommand(target, "backstage_set_fps", { fps: newMaxFps });
      if (state.maxFps !== newMaxFps) {
        state.maxFps = newMaxFps;
        backstageStreamingState.set(clientId, state);
        logger.debug(`[backstage] set target fps=${newMaxFps}`);
      }
      break;
    }
    case "backstage_enable_mouse":
      if (state.isStreaming) sendbackstageCommand(target, "backstage_enable_mouse", { enabled: !!payload.enabled });
      break;
    case "backstage_enable_keyboard":
      if (state.isStreaming) sendbackstageCommand(target, "backstage_enable_keyboard", { enabled: !!payload.enabled });
      break;
    case "backstage_enable_cursor":
      if (state.isStreaming) sendbackstageCommand(target, "backstage_enable_cursor", { enabled: !!payload.enabled });
      break;
    case "backstage_enable_dxgi":
      if (state.isStreaming) sendbackstageCommand(target, "backstage_enable_dxgi", { enabled: !!payload.enabled });
      break;
    case "backstage_enable_uia":
      if (state.isStreaming) sendbackstageCommand(target, "backstage_enable_uia", { enabled: !!payload.enabled });
      break;
    case "backstage_set_resolution": {
      const maxHeight = Number(payload.maxHeight) || 0;
      if (state.isStreaming) sendbackstageCommand(target, "backstage_set_resolution", { maxHeight });
      break;
    }
    case "backstage_mouse_move":
      if (state.isStreaming) sendbackstageCommand(target, "backstage_mouse_move", { x: Number(payload.x) || 0, y: Number(payload.y) || 0 });
      break;
    case "backstage_mouse_down":
      if (state.isStreaming) sendbackstageCommand(target, "backstage_mouse_down", {
        button: Number(payload.button) || 0,
        x: Number(payload.x) || 0,
        y: Number(payload.y) || 0,
      });
      break;
    case "backstage_mouse_up":
      if (state.isStreaming) sendbackstageCommand(target, "backstage_mouse_up", {
        button: Number(payload.button) || 0,
        x: Number(payload.x) || 0,
        y: Number(payload.y) || 0,
      });
      break;
    case "backstage_mouse_wheel":
      if (state.isStreaming) sendbackstageCommand(target, "backstage_mouse_wheel", { delta: Number(payload.delta) || 0, x: Number(payload.x) || 0, y: Number(payload.y) || 0 });
      break;
    case "backstage_key_down":
      if (state.isStreaming) sendbackstageCommand(target, "backstage_key_down", { key: payload.key || "", code: payload.code || "" });
      break;
    case "backstage_key_up":
      if (state.isStreaming) sendbackstageCommand(target, "backstage_key_up", { key: payload.key || "", code: payload.code || "" });
      break;
    case "backstage_lookup":
      sendbackstageCommand(target, "backstage_lookup", { exe: String(payload.exe || "") });
      break;
    case "backstage_browser_check":
      sendbackstageCommand(target, "backstage_browser_check", {});
      break;
    case "backstage_installed_apps":
      sendbackstageCommand(target, "backstage_installed_apps", {});
      break;
    case "backstage_window_list":
      sendbackstageCommand(target, "backstage_window_list", {});
      break;
    case "backstage_start_process":
      sendbackstageCommand(target, "backstage_start_process", {
        path: String(payload.path || ""),
        kill_exe: String(payload.kill_exe || ""),
        opera_patch: Boolean(payload.opera_patch),
        display: state.display ?? 0,
      });
      break;
    case "backstage_kill_all":
      sendbackstageCommand(target, "backstage_kill_all", {});
      break;
    case "backstage_start_process_injected": {
      const dllData = getInjectionDllBytes();
      if (!dllData) {
        logger.warn("[backstage] injection DLL not available, cannot send backstage_start_process_injected");
        safeSendViewer(ws, { type: "backstage_error", error: "backstage injection DLL not found on the server. Browser cloning requires the DLL to be built and placed in the server directory.", critical: true });
        break;
      }
      const captureDll = getCaptureDllBytes();
      const cmdPayload: Record<string, any> = {
        path: String(payload.path || ""),
        search_path: String(payload.search_path || ""),
        replace_path: String(payload.replace_path || ""),
        dll: dllData,
        display: state.display ?? 0,
      };
      if (captureDll) cmdPayload.capture_dll = captureDll;
      sendbackstageCommand(target, "backstage_start_process_injected", cmdPayload);
      break;
    }
    case "backstage_start_chrome_injected": {
      const dllData = getInjectionDllBytes();
      if (!dllData) {
        logger.warn("[backstage] injection DLL not available, cannot send backstage_start_chrome_injected");
        safeSendViewer(ws, { type: "backstage_error", error: "backstage injection DLL not found on the server. Browser cloning requires the DLL to be built and placed in the server directory.", critical: true });
        break;
      }
      const captureDllChrome = getCaptureDllBytes();
      const chromeCmdPayload: Record<string, any> = {
        path: String(payload.path || ""),
        dll: dllData,
        display: state.display ?? 0,
      };
      if (captureDllChrome) chromeCmdPayload.capture_dll = captureDllChrome;
      sendbackstageCommand(target, "backstage_start_chrome_injected", chromeCmdPayload);
      break;
    }
    case "backstage_start_browser_injected": {
      const dllData = getInjectionDllBytes();
      if (!dllData) {
        logger.warn("[backstage] injection DLL not available, cannot send backstage_start_browser_injected");
        safeSendViewer(ws, { type: "backstage_error", error: "backstage injection DLL not found on the server. Browser cloning requires the DLL to be built and placed in the server directory.", critical: true });
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
        display: state.display ?? 0,
      };
      if (captureDllBrowser) browserCmdPayload.capture_dll = captureDllBrowser;
      sendbackstageCommand(target, "backstage_start_browser_injected", browserCmdPayload);
      break;
    }
    case "clipboard_sync": {
      if (!state.isStreaming) break;
      const text = String(payload.text || "");
      if (text) {
        sendbackstageCommand(target, "clipboard_set", { text });
      }
      break;
    }
    case "clipboard_sync_start": {
      if (!state.isStreaming) break;
      sendDesktopCommand(target, "clipboard_sync_start", { source: "backstage" });
      break;
    }
    case "clipboard_sync_stop": {
      sendDesktopCommand(target, "clipboard_sync_stop", {});
      break;
    }
    case "webrtc_p2p_offer": {
      const sdp = typeof (payload as any).sdp === "string" ? (payload as any).sdp : "";
      if (!sdp) break;
      const sessionId = createP2PSession(ws, clientId, "backstage");
      sendbackstageCommand(target, "webrtc_p2p_offer", { sessionId, sdp, kind: "backstage", hasVideo: true, hasAudio: false, iceServers: issueTurnIceServers(`${clientId}:backstage:${sessionId}`) });
      break;
    }
    case "webrtc_p2p_ice": {
      const sessionId = getP2PSessionIdForViewer(ws);
      if (!sessionId) break;
      const candidate = typeof (payload as any).candidate === "string" ? (payload as any).candidate : "";
      if (!candidate) break;
      sendbackstageCommand(target, "webrtc_p2p_ice", {
        sessionId,
        kind: "backstage",
        candidate,
        sdpMid: typeof (payload as any).sdpMid === "string" ? (payload as any).sdpMid : "",
        sdpMLineIndex: Number((payload as any).sdpMLineIndex) || 0,
      });
      break;
    }
    case "webrtc_p2p_stop": {
      const cleared = clearP2PSessionForViewer(ws);
      if (cleared) {
        sendbackstageCommand(target, "webrtc_p2p_stop", { sessionId: cleared.sessionId, kind: cleared.kind });
      }
      break;
    }
    default:
      break;
  }
}

export function sendbackstageCommand(target: ClientInfo | undefined, commandType: string, payload: any) {
  if (!target) {
    logger.warn(`[backstage] send command skipped, target missing command=${commandType}`);
    return false;
  }
  try {
    logger.debug(`[backstage] send command command=${commandType} client=${target.id} payload=${JSON.stringify(payload || {})}`);
    target.ws.send(encodeMessage({ type: "command", commandType: commandType as any, id: uuidv4(), payload }));
    metrics.recordCommand(commandType);
    return true;
  } catch (err) {
    logger.error("[backstage] send command failed", err);
    return false;
  }
}

export function handleDesktopEncoderCapabilities(clientId: string, payload: any) {
  const encoderCodecs = Array.isArray(payload?.codecs) && payload.codecs.length > 0
    ? payload.codecs
    : [
        { codec: "h264", transports: ["websocket", "webrtc"] },
        { codec: "jpeg", transports: ["websocket"] },
        { codec: "raw", transports: ["websocket"] },
      ];
  const sessions = sessionManager.getRdSessionsForClient(clientId);
  const negotiations = sessions.map((session) => negotiateDesktopCodec({
      encoderCodecs,
      decoderCodecs: session.viewer.data.rdDecoderCodecs || ["h264", "jpeg", "raw"],
      preferredCodecs: session.viewer.data.rdPreferredCodecs,
      transport: session.viewer.data.rdCodecTransport,
    }));
  const sharedFallbackCodecs = negotiations.length > 0
    ? negotiations[0].fallbackCodecs.filter((codec) =>
        negotiations.every((negotiation) => negotiation.fallbackCodecs.includes(codec)),
      )
    : [];
  const selectedCodec = sharedFallbackCodecs[0] || "";

  for (let index = 0; index < sessions.length; index++) {
    const session = sessions[index];
    const negotiation = {
      ...negotiations[index],
      selectedCodec,
      fallbackCodecs: sharedFallbackCodecs,
    };
    session.viewer.data.rdSelectedCodec = selectedCodec;
    safeSendViewer(session.viewer, {
      ...payload,
      codecs: encoderCodecs,
      negotiation,
      selectedCodec,
      fallbackCodecs: sharedFallbackCodecs,
      transport: negotiation.transport,
    });
  }
}

function releaseCanvasFrameAck(clientId: string, sessionId?: string): boolean {
  const controllerSessionId = rdCanvasFrameAckPending.get(clientId);
  if (!controllerSessionId || (sessionId && controllerSessionId !== sessionId)) return false;
  rdCanvasFrameAckPending.delete(clientId);
  const target = clientManager.getClient(clientId);
  if (!target) return false;
  try {
    target.ws.send(encodeMessage({ type: "frame_ack" }));
    return true;
  } catch (err) {
    logger.debug(`[rd] canvas frame ack failed client=${clientId}: ${(err as Error).message}`);
    return false;
  }
}

export function handleDesktopStreamStats(clientId: string, payload: any) {
  const stats = {
    type: "desktop_stream_stats",
    fps: Math.max(0, Number(payload?.fps) || 0),
    format: String(payload?.format || ""),
    bytes: Math.max(0, Number(payload?.bytes) || 0),
    width: Math.max(0, Number(payload?.width) || 0),
    height: Math.max(0, Number(payload?.height) || 0),
    captureMs: Math.max(0, Number(payload?.captureMs) || 0),
    encodeMs: Math.max(0, Number(payload?.encodeMs) || 0),
    sendMs: Math.max(0, Number(payload?.sendMs) || 0),
    totalMs: Math.max(0, Number(payload?.totalMs) || 0),
    transport: String(payload?.transport || ""),
  };
  for (const session of sessionManager.getRdSessionsForClient(clientId)) {
    safeSendViewer(session.viewer, stats, "rd-stats");
  }
}

(globalThis as any).__backstageBroadcast = (clientId: string, bytes: Uint8Array, header?: any): boolean => {
  const state = backstageStreamingState.get(clientId) || defaultbackstageStreamingState();
  if (!state.isStreaming) {
    state.isStreaming = true;
  }
  const frameFps = Number(header?.fps) || 0;
  if (frameFps > 0) {
    state.lastFps = frameFps;
  }
  backstageStreamingState.set(clientId, state);
  const buf = buildViewerFrameBuffer(bytes, header);
  const result = broadcastFrameToViewers(sessionManager.getbackstageSessionsForClient(clientId), buf, header);
  if (result.dropped) {
    const target = clientManager.getClient(clientId);
    if (target) {
      sendbackstageCommand(target, "backstage_request_keyframe", {
        reason: "viewer_backpressure",
        format: String(header?.format || ""),
      });
    }
  }
  return result.sent || result.viewers === 0;
};

(globalThis as any).__webcamBroadcast = (clientId: string, bytes: Uint8Array, header?: any): boolean => {
  const buf = buildViewerFrameBuffer(bytes, header);
  const result = broadcastFrameToViewers(sessionManager.getWebcamSessionsForClient(clientId), buf, header);
  return result.sent || result.viewers === 0;
};

export function handleConsoleViewerMessage(ws: ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) {
  const payload = decodeViewerPayload(raw);
  if (!payload) return;
  if (!payload || typeof payload.type !== "string") {
    return;
  }

  const { clientId, sessionId } = ws.data;
  const target = clientManager.getClient(clientId);
  if (!target) {
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
      const session = sessionId ? sessionManager.getConsoleSession(sessionId) : undefined;
      if (session && !session.started) {
        session.started = true;
        startConsoleForViewer(target, sessionId!, cols, rows);
      } else {
        sendConsoleCommand(target, "console_resize", { sessionId, cols, rows });
      }
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
  safeSendViewer(session.viewer, {
    type: "output",
    sessionId,
    data: payload.data ?? null,
    exitCode: payload.exitCode,
    error: payload.error,
  });
  if (payload.exitCode !== undefined || payload.error) {
    const reason = payload.error ? payload.error : `Process exited (${payload.exitCode ?? ""})`;
    safeSendViewer(session.viewer, { type: "status", status: "closed", reason, sessionId });
    sessionManager.deleteConsoleSession(sessionId);
  }
}
