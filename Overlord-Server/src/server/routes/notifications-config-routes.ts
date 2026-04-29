import { authenticateRequest } from "../../auth";
import { AuditAction, logAudit } from "../../auditLog";
import * as clientManager from "../../clientManager";
import { getConfig, updateNotificationsConfig } from "../../config";
import { savePushSubscription, deletePushSubscription, getPushSubscriptionsByUser } from "../../db";
import { encodeMessage } from "../../protocol";
import {
  getUserNotificationSettings,
  updateUserNotificationSettings,
} from "../../users";
import {
  DEFAULT_WEBHOOK_TEMPLATE,
  DEFAULT_TELEGRAM_TEMPLATE,
  renderNotificationTemplate,
} from "../notification-delivery";
import { getVapidPublicKey } from "../web-push";

type RequestIpProvider = {
  requestIP: (req: Request) => { address?: string } | null | undefined;
};

type NotificationsRouteDeps = {
  getNotificationScreenshot: (notificationId: string) => { format?: string; bytes: Uint8Array } | null;
  secureHeaders: (contentType?: string) => HeadersInit;
};

export async function handleNotificationsConfigRoutes(
  req: Request,
  url: URL,
  server: RequestIpProvider,
  deps: NotificationsRouteDeps,
): Promise<Response | null> {
  const screenshotMatch = url.pathname.match(/^\/api\/notifications\/([^/]+)\/screenshot$/);
  if (req.method === "GET" && screenshotMatch) {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    const notificationId = decodeURIComponent(screenshotMatch[1]);
    const screenshot = deps.getNotificationScreenshot(notificationId);
    if (!screenshot) {
      return new Response("Not found", { status: 404 });
    }

    const format = (screenshot.format || "jpeg").toLowerCase();
    const contentType = format === "jpg" || format === "jpeg"
      ? "image/jpeg"
      : format === "png"
        ? "image/png"
        : format === "webp"
          ? "image/webp"
          : "application/octet-stream";

    return new Response(screenshot.bytes as unknown as BodyInit, {
      headers: deps.secureHeaders(contentType),
    });
  }

  if (req.method === "GET" && url.pathname === "/api/notifications/config") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (user.role === "viewer") {
      return new Response("Forbidden: Viewer access denied", { status: 403 });
    }
    return Response.json({ notifications: getConfig().notifications });
  }

  if (req.method === "PUT" && url.pathname === "/api/notifications/config") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (user.role !== "admin") {
      return new Response("Forbidden: Admin access required", {
        status: 403,
      });
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const currentConfig = getConfig().notifications;
    const hasKeywords = Array.isArray(body?.keywords);
    const rawKeywords = hasKeywords ? body.keywords : currentConfig.keywords || [];
    const keywords = rawKeywords
      .map((k: any) => String(k).trim())
      .filter(Boolean)
      .slice(0, 200);

    for (const kw of keywords) {
      if (kw.startsWith("/")) {
        const lastSlash = kw.lastIndexOf("/", kw.length - 1);
        if (lastSlash <= 0) {
          return Response.json(
            { error: `Invalid regex keyword (missing closing /): ${kw}` },
            { status: 400 },
          );
        }
        const pattern = kw.slice(1, lastSlash);
        const flags = kw.slice(lastSlash + 1);
        const invalidFlags = flags.replace(/[gimsuy]/g, "");
        if (invalidFlags.length > 0) {
          return Response.json(
            { error: `Invalid regex flags '${invalidFlags}' in keyword: ${kw}` },
            { status: 400 },
          );
        }
        try {
          new RegExp(pattern, flags);
        } catch (e: any) {
          return Response.json(
            { error: `Invalid regex in keyword '${kw}': ${e?.message ?? e}` },
            { status: 400 },
          );
        }
      }
    }

    const webhookEnabled =
      typeof body?.webhookEnabled === "boolean"
        ? body.webhookEnabled
        : currentConfig.webhookEnabled;
    const webhookUrl =
      typeof body?.webhookUrl === "string"
        ? body.webhookUrl.trim()
        : currentConfig.webhookUrl || "";
    const telegramEnabled =
      typeof body?.telegramEnabled === "boolean"
        ? body.telegramEnabled
        : currentConfig.telegramEnabled;
    const telegramBotToken =
      typeof body?.telegramBotToken === "string"
        ? body.telegramBotToken.trim()
        : currentConfig.telegramBotToken || "";
    const telegramChatId =
      typeof body?.telegramChatId === "string"
        ? body.telegramChatId.trim()
        : currentConfig.telegramChatId || "";
    const clipboardEnabled =
      typeof body?.clipboardEnabled === "boolean"
        ? body.clipboardEnabled
        : currentConfig.clipboardEnabled || false;

    if (webhookUrl) {
      try {
        const parsed = new URL(webhookUrl);
        if (!/^https?:$/.test(parsed.protocol)) {
          return Response.json(
            { error: "Webhook URL must be http(s)" },
            { status: 400 },
          );
        }
      } catch {
        return Response.json({ error: "Invalid webhook URL" }, { status: 400 });
      }
    }

    const updated = await updateNotificationsConfig({
      keywords,
      webhookEnabled,
      webhookUrl,
      telegramEnabled,
      telegramBotToken,
      telegramChatId,
      clipboardEnabled,
    });

    for (const client of clientManager.getAllClients().values()) {
      if (client.role !== "client") continue;
      try {
        client.ws.send(
          encodeMessage({
            type: "notification_config",
            keywords: updated.keywords || [],
            minIntervalMs: updated.minIntervalMs || 8000,
            clipboardEnabled: updated.clipboardEnabled || false,
          }),
        );
      } catch {}
    }

    logAudit({
      timestamp: Date.now(),
      username: user.username,
      ip: server.requestIP(req)?.address || "unknown",
      action: AuditAction.COMMAND,
      details: `Updated notification keywords (${updated.keywords.length})`,
      success: true,
    });

    return Response.json({ ok: true, notifications: updated });
  }

  if (url.pathname === "/api/notifications/my-settings") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (req.method === "GET") {
      const settings = getUserNotificationSettings(user.userId) ?? {
        webhook_enabled: 0,
        webhook_url: null,
        webhook_template: null,
        telegram_enabled: 0,
        telegram_bot_token: null,
        telegram_chat_id: null,
        telegram_template: null,
        client_event_webhook: 1,
        client_event_telegram: 1,
        client_event_push: 1,
      };
      return Response.json({
        settings,
        defaults: {
          webhookTemplate: DEFAULT_WEBHOOK_TEMPLATE,
          telegramTemplate: DEFAULT_TELEGRAM_TEMPLATE,
        },
      });
    }

    if (req.method === "PUT") {
      let body: any = {};
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }

      const patch: Record<string, any> = {};

      if (typeof body?.webhook_enabled === "boolean" || typeof body?.webhook_enabled === "number") {
        patch.webhook_enabled = body.webhook_enabled ? 1 : 0;
      }
      if (typeof body?.webhook_url === "string") {
        const url_val = body.webhook_url.trim();
        if (url_val) {
          try {
            const parsed = new URL(url_val);
            if (!/^https?:$/.test(parsed.protocol)) {
              return Response.json({ error: "Webhook URL must use http(s)" }, { status: 400 });
            }
          } catch {
            return Response.json({ error: "Invalid webhook URL" }, { status: 400 });
          }
        }
        patch.webhook_url = url_val || null;
      }
      if (typeof body?.webhook_template === "string") {
        patch.webhook_template = body.webhook_template.trim() || null;
      }
      if (typeof body?.telegram_enabled === "boolean" || typeof body?.telegram_enabled === "number") {
        patch.telegram_enabled = body.telegram_enabled ? 1 : 0;
      }
      if (typeof body?.telegram_bot_token === "string") {
        patch.telegram_bot_token = body.telegram_bot_token.trim() || null;
      }
      if (typeof body?.telegram_chat_id === "string") {
        patch.telegram_chat_id = body.telegram_chat_id.trim() || null;
      }
      if (typeof body?.telegram_template === "string") {
        patch.telegram_template = body.telegram_template.trim() || null;
      }
      if (typeof body?.client_event_webhook === "boolean" || typeof body?.client_event_webhook === "number") {
        patch.client_event_webhook = body.client_event_webhook ? 1 : 0;
      }
      if (typeof body?.client_event_telegram === "boolean" || typeof body?.client_event_telegram === "number") {
        patch.client_event_telegram = body.client_event_telegram ? 1 : 0;
      }
      if (typeof body?.client_event_push === "boolean" || typeof body?.client_event_push === "number") {
        patch.client_event_push = body.client_event_push ? 1 : 0;
      }

      const result = updateUserNotificationSettings(user.userId, patch);
      if (!result.success) {
        return Response.json({ error: result.error }, { status: 400 });
      }

      const updated = getUserNotificationSettings(user.userId);
      return Response.json({ ok: true, settings: updated });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/notifications/my-settings/preview/webhook") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const webhookUrl = typeof body?.webhookUrl === "string" ? body.webhookUrl.trim() : "";
    const webhookTemplate = typeof body?.webhookTemplate === "string" ? body.webhookTemplate : "";

    if (!webhookUrl) {
      return Response.json({ error: "Webhook URL is required" }, { status: 400 });
    }

    let parsed: URL;
    try {
      parsed = new URL(webhookUrl);
      if (!/^https?:$/.test(parsed.protocol)) {
        return Response.json({ error: "Webhook URL must use http(s)" }, { status: 400 });
      }
    } catch {
      return Response.json({ error: "Invalid webhook URL" }, { status: 400 });
    }

    const sampleRecord = {
      id: "preview-notification",
      clientId: "abc123def456",
      host: "DESKTOP-7G2ABK1",
      user: "john.doe",
      os: "windows",
      title: "Online Banking - Secure Login",
      process: "chrome.exe",
      processPath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
      pid: 4392,
      keyword: "bank",
      category: "active_window" as const,
      ts: Date.now(),
    };

    const payload = renderNotificationTemplate(
      webhookTemplate,
      sampleRecord,
      DEFAULT_WEBHOOK_TEMPLATE,
    );

    const canonicalPayload = JSON.stringify({ type: "notification", data: sampleRecord });
    const customTemplate = webhookTemplate.trim();
    let jsonPayloadToSend = canonicalPayload;
    if (customTemplate) {
      try {
        jsonPayloadToSend = JSON.stringify(JSON.parse(payload));
      } catch {
        jsonPayloadToSend = canonicalPayload;
      }
    }

    try {
      const isDiscord = /discord(app)?\.com$/i.test(parsed.hostname);
      let response: Response;
      let sentPayload = jsonPayloadToSend;
      let sentMode: "json" | "discord" = "json";

      if (isDiscord) {
        sentMode = "discord";
        const discordPayload = {
          content: `🔔 Notification: ${sampleRecord.title}`,
          embeds: [
            {
              title: sampleRecord.keyword ? `Keyword: ${sampleRecord.keyword}` : "Active Window",
              description: sampleRecord.title,
              fields: [
                { name: "Client", value: sampleRecord.clientId || "unknown", inline: true },
                { name: "User", value: sampleRecord.user || "unknown", inline: true },
                { name: "Host", value: sampleRecord.host || "unknown", inline: true },
                { name: "Process", value: sampleRecord.process || "unknown", inline: true },
              ],
              timestamp: new Date(sampleRecord.ts).toISOString(),
            },
          ],
        };
        sentPayload = JSON.stringify(discordPayload);
        response = await fetch(parsed.toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: sentPayload,
        });
      } else {
        response = await fetch(parsed.toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: jsonPayloadToSend,
        });
      }

      const responseText = await response.text().catch(() => "");

      return Response.json({
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        mode: sentMode,
        payload: sentPayload,
        responseBody: responseText ? responseText.slice(0, 500) : "",
      });
    } catch (err: any) {
      return Response.json(
        { error: err?.message || "Failed to POST preview webhook" },
        { status: 502 },
      );
    }
  }

  if (req.method === "GET" && url.pathname === "/api/notifications/vapid-public-key") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    return Response.json({ publicKey: getVapidPublicKey() });
  }

  if (url.pathname === "/api/notifications/push-subscribe") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (req.method === "POST") {
      let body: any = {};
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }

      const endpoint = typeof body?.endpoint === "string" ? body.endpoint.trim() : "";
      const p256dh = typeof body?.keys?.p256dh === "string" ? body.keys.p256dh : "";
      const auth = typeof body?.keys?.auth === "string" ? body.keys.auth : "";

      if (!endpoint || !p256dh || !auth) {
        return Response.json({ error: "Missing subscription fields" }, { status: 400 });
      }

      savePushSubscription(user.userId, endpoint, p256dh, auth);
      return Response.json({ ok: true });
    }

    if (req.method === "DELETE") {
      let body: any = {};
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }

      const endpoint = typeof body?.endpoint === "string" ? body.endpoint.trim() : "";
      if (!endpoint) {
        return Response.json({ error: "Missing endpoint" }, { status: 400 });
      }

      deletePushSubscription(endpoint);
      return Response.json({ ok: true });
    }
  }

  return null;
}
