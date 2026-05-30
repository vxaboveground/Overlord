import type { ServerWebSocket } from "bun";
import { v4 as uuidv4 } from "uuid";
import * as clientManager from "../clientManager";
import { encodeMessage } from "../protocol";
import * as sessionManager from "../sessions/sessionManager";
import type { DesktopAudioViewer, SocketData } from "../sessions/types";
import { canUserAccessClient } from "../users";
import { issueWebrtcPublishToken, webrtcStreamPathFor } from "./routes/webrtc-routes";
import {
  clearP2PSessionForViewer,
  createP2PSession,
  getP2PSessionIdForViewer,
} from "./webrtc-p2p-sessions";
import {
  cleanupViewerP2P,
} from "./ws-console-rd-hvnc";

function sendDesktopAudioCommand(
  clientId: string,
  commandType: "desktop_audio_start" | "desktop_audio_stop" | "webrtc_publish" | "webrtc_stop" | "webrtc_p2p_offer" | "webrtc_p2p_ice" | "webrtc_p2p_stop",
  payload: Record<string, unknown>,
) {
  const target = clientManager.getClient(clientId);
  if (!target) return false;
  try {
    target.ws.send(
      encodeMessage({
        type: "command",
        commandType: commandType as any,
        id: uuidv4(),
        payload,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

function safeJson(ws: ServerWebSocket<SocketData>, payload: Record<string, unknown>) {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
  }
}

export function handleDesktopAudioViewerOpen(ws: ServerWebSocket<SocketData>) {
  const { clientId, userId, userRole } = ws.data;
  if (userId !== undefined && userRole && !canUserAccessClient(userId, userRole as any, clientId)) {
    ws.close(1008, "Forbidden: client access denied");
    return;
  }
  const sessionId = uuidv4();
  ws.data.sessionId = sessionId;
  const target = clientManager.getClient(clientId);
  const session: DesktopAudioViewer = { id: sessionId, clientId, viewer: ws, createdAt: Date.now() };
  sessionManager.addDesktopAudioSession(session);

  safeJson(ws, { type: "ready", sessionId, clientId, clientOnline: !!target });
  if (!target) {
    safeJson(ws, { type: "status", status: "offline", reason: "Client is offline" });
    return;
  }

  safeJson(ws, { type: "status", status: "ready" });
}

export function handleDesktopAudioViewerMessage(ws: ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) {
  const { clientId } = ws.data;
  if (typeof raw !== "string") return;
  let message: any;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (!message || typeof message.type !== "string") return;

  switch (message.type) {
    case "start": {
      const source = typeof message.source === "string" ? message.source : "system";
      const started = sendDesktopAudioCommand(clientId, "desktop_audio_start", {
        source,
        sessionId: ws.data.sessionId,
      });
      if (message.webrtc === true && started) {
        const streamPath = webrtcStreamPathFor(clientId, "audio");
        const token = issueWebrtcPublishToken(clientId);
        sendDesktopAudioCommand(clientId, "webrtc_publish", {
          streamPath,
          whipPath: `/api/webrtc/${streamPath}/whip`,
          token,
          kind: "audio",
          hasVideo: false,
          hasAudio: true,
        });
        safeJson(ws, {
          type: "webrtc_ready",
          streamPath,
          whepPath: `/api/webrtc/${streamPath}/whep`,
        });
      }
      safeJson(ws, { type: "status", status: started ? "connected" : "error" });
      return;
    }
    case "stop": {
      sendDesktopAudioCommand(clientId, "desktop_audio_stop", {});
      sendDesktopAudioCommand(clientId, "webrtc_stop", { kind: "audio" });
      safeJson(ws, { type: "status", status: "disconnected" });
      return;
    }
    case "webrtc_p2p_offer": {
      const sdp = typeof message.sdp === "string" ? message.sdp : "";
      if (!sdp) return;
      const sessionId = createP2PSession(ws, clientId, "audio");
      sendDesktopAudioCommand(clientId, "webrtc_p2p_offer", {
        sessionId,
        sdp,
        kind: "audio",
        hasVideo: false,
        hasAudio: true,
      });
      return;
    }
    case "webrtc_p2p_ice": {
      const sessionId = getP2PSessionIdForViewer(ws);
      if (!sessionId) return;
      const candidate = typeof message.candidate === "string" ? message.candidate : "";
      if (!candidate) return;
      sendDesktopAudioCommand(clientId, "webrtc_p2p_ice", {
        sessionId,
        kind: "audio",
        candidate,
        sdpMid: typeof message.sdpMid === "string" ? message.sdpMid : "",
        sdpMLineIndex: Number(message.sdpMLineIndex) || 0,
      });
      return;
    }
    case "webrtc_p2p_stop": {
      const cleared = clearP2PSessionForViewer(ws);
      if (cleared) {
        sendDesktopAudioCommand(clientId, "webrtc_p2p_stop", {
          sessionId: cleared.sessionId,
          kind: cleared.kind,
        });
      }
      return;
    }
  }
}

export function handleDesktopAudioUplink(clientId: string, payload: any) {
  const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
  const bytes = payload?.data instanceof Uint8Array
    ? payload.data
    : payload?.data instanceof ArrayBuffer
      ? new Uint8Array(payload.data)
      : ArrayBuffer.isView(payload?.data)
        ? new Uint8Array(payload.data.buffer)
        : null;
  if (!bytes || bytes.byteLength === 0) return;

  for (const session of sessionManager.getDesktopAudioSessionsByClient(clientId)) {
    if (sessionId && session.id !== sessionId) continue;
    try {
      session.viewer.send(bytes);
    } catch {
    }
  }
}

export function cleanupDesktopAudioViewer(ws: ServerWebSocket<SocketData>) {
  cleanupViewerP2P(ws);
  let removedClientId = ws.data.clientId;
  for (const [sid, session] of sessionManager.getAllDesktopAudioSessions().entries()) {
    if (session.viewer === ws) {
      removedClientId = session.clientId;
      sessionManager.deleteDesktopAudioSession(sid);
      break;
    }
  }

  const hasViewers = sessionManager.getDesktopAudioSessionsByClient(removedClientId).length > 0;
  if (!hasViewers) {
    sendDesktopAudioCommand(removedClientId, "desktop_audio_stop", {});
    sendDesktopAudioCommand(removedClientId, "webrtc_stop", { kind: "audio" });
  }
}
