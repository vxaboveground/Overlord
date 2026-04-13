import { logger } from "../../logger";
import { authenticateRequest } from "../../auth";
import { AuditAction, getAuditLogs, logAudit } from "../../auditLog";
import { getConfig, updateSecurityConfig, updateTlsConfig, updateAppearanceConfig, getExportableConfig, importFullConfig } from "../../config";
import { getClientMetricsSummary } from "../../db";
import { metrics } from "../../metrics";
import { requirePermission } from "../../rbac";
import { getUserTelegramChatId, setUserTelegramChatId } from "../../users";
import { runCertbotSetup } from "../certbot-setup";
import {
  getActiveProxies,
  startProxy,
  stopProxy,
} from "../socks5-proxy-manager";
import {
  checkForUpdate,
  writeUpdateRequest,
  readUpdateStatus,
  hasPendingRequest,
  clearUpdateStatus,
} from "../update-checker";

type MiscRouteDeps = {
  CORS_HEADERS: Record<string, string>;
  SERVER_VERSION: string;
  requestIP?: (req: Request) => { address?: string } | null | undefined;
  getConsoleSessionCount: () => number;
  getRdSessionCount: () => number;
  getFileBrowserSessionCount: () => number;
  getProcessSessionCount: () => number;
  tlsCertPath?: string;
  tlsSource?: "certbot" | "configured" | "self-signed";
};

export async function handleMiscRoutes(
  req: Request,
  url: URL,
  deps: MiscRouteDeps,
): Promise<Response | null> {
  if (req.method === "GET" && url.pathname === "/api/metrics") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const snapshot = metrics.getSnapshot();

    const clientSummary = getClientMetricsSummary();
    snapshot.clients.total = clientSummary.total;
    snapshot.clients.online = clientSummary.online;
    snapshot.clients.offline = clientSummary.total - clientSummary.online;
    snapshot.clients.byOS = clientSummary.byOS;
    snapshot.clients.byCountry = clientSummary.byCountry;

    snapshot.sessions.console = deps.getConsoleSessionCount();
    snapshot.sessions.remoteDesktop = deps.getRdSessionCount();
    snapshot.sessions.fileBrowser = deps.getFileBrowserSessionCount();
    snapshot.sessions.process = deps.getProcessSessionCount();

    metrics.recordHistoryEntry(snapshot);

    const history = metrics.getHistory();

    return new Response(JSON.stringify({ snapshot, history }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (url.pathname === "/health") {
    return new Response("ok", { headers: deps.CORS_HEADERS });
  }

  if (req.method === "GET" && url.pathname === "/api/version") {
    return new Response(JSON.stringify({ version: deps.SERVER_VERSION }), {
      headers: {
        ...deps.CORS_HEADERS,
        "Content-Type": "application/json",
      },
    });
  }

  if (url.pathname === "/api/settings/telegram") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (req.method === "GET") {
      const chatId = getUserTelegramChatId(user.userId);
      return Response.json({ telegramChatId: chatId || "" });
    }

    if (req.method === "PUT") {
      let body: any = {};
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }

      const chatId = typeof body?.telegramChatId === "string" ? body.telegramChatId.trim() : null;
      const result = setUserTelegramChatId(user.userId, chatId || null);
      if (!result.success) {
        return Response.json({ error: result.error }, { status: 400 });
      }

      return Response.json({ success: true, telegramChatId: chatId || "" });
    }
  }

  if (url.pathname === "/api/settings/security") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (user.role !== "admin") {
      return new Response("Forbidden: Admin access required", { status: 403 });
    }

    if (req.method === "GET") {
      return Response.json({ security: getConfig().security }, { headers: deps.CORS_HEADERS });
    }

    if (req.method === "PUT") {
      let body: any = {};
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }

      const updated = await updateSecurityConfig({
        sessionTtlHours: Number(body?.sessionTtlHours),
        loginMaxAttempts: Number(body?.loginMaxAttempts),
        loginWindowMinutes: Number(body?.loginWindowMinutes),
        loginLockoutMinutes: Number(body?.loginLockoutMinutes),
        passwordMinLength: Number(body?.passwordMinLength),
        passwordRequireUppercase: Boolean(body?.passwordRequireUppercase),
        passwordRequireLowercase: Boolean(body?.passwordRequireLowercase),
        passwordRequireNumber: Boolean(body?.passwordRequireNumber),
        passwordRequireSymbol: Boolean(body?.passwordRequireSymbol),
      });

      logAudit({
        timestamp: Date.now(),
        username: user.username,
        ip: deps.requestIP?.(req)?.address || "unknown",
        action: AuditAction.COMMAND,
        details: "Updated security settings",
        success: true,
      });

      return Response.json({ ok: true, security: updated }, { headers: deps.CORS_HEADERS });
    }
  }

  if (url.pathname === "/api/settings/tls") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (user.role !== "admin") {
      return new Response("Forbidden: Admin access required", { status: 403 });
    }

    if (req.method === "GET") {
      return Response.json({ tls: getConfig().tls }, { headers: deps.CORS_HEADERS });
    }

    if (req.method === "PUT") {
      let body: any = {};
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }

      const updated = await updateTlsConfig({
        certPath: typeof body?.certPath === "string" ? body.certPath : undefined,
        keyPath: typeof body?.keyPath === "string" ? body.keyPath : undefined,
        caPath: typeof body?.caPath === "string" ? body.caPath : undefined,
        certbot: {
          enabled: Boolean(body?.certbot?.enabled),
          livePath: typeof body?.certbot?.livePath === "string" ? body.certbot.livePath : undefined,
          domain: typeof body?.certbot?.domain === "string" ? body.certbot.domain : undefined,
          certFileName:
            typeof body?.certbot?.certFileName === "string" ? body.certbot.certFileName : undefined,
          keyFileName:
            typeof body?.certbot?.keyFileName === "string" ? body.certbot.keyFileName : undefined,
          caFileName:
            typeof body?.certbot?.caFileName === "string" ? body.certbot.caFileName : undefined,
        },
      });

      logAudit({
        timestamp: Date.now(),
        username: user.username,
        ip: deps.requestIP?.(req)?.address || "unknown",
        action: AuditAction.COMMAND,
        details: "Updated TLS settings",
        success: true,
      });

      return Response.json({ ok: true, tls: updated }, { headers: deps.CORS_HEADERS });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/settings/tls/certbot/setup") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (user.role !== "admin") {
      return new Response("Forbidden: Admin access required", { status: 403 });
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const domain = String(body?.domain || "").trim();
    const email = String(body?.email || "").trim();
    const livePath = String(body?.livePath || "/etc/letsencrypt/live").trim() || "/etc/letsencrypt/live";

    try {
      const result = await runCertbotSetup({ domain, email, livePath });

      const updated = await updateTlsConfig({
        certbot: {
          enabled: true,
          livePath,
          domain,
          certFileName: "fullchain.pem",
          keyFileName: "privkey.pem",
          caFileName: "chain.pem",
        },
      });

      logAudit({
        timestamp: Date.now(),
        username: user.username,
        ip: deps.requestIP?.(req)?.address || "unknown",
        action: AuditAction.COMMAND,
        details: `Ran certbot setup for domain ${domain}`,
        success: true,
      });

      return Response.json(
        {
          ok: true,
          tls: updated,
          certbot: {
            certPath: result.certPath,
            keyPath: result.keyPath,
            caPath: result.caPath,
            output: result.output,
          },
          message:
            "Certificate issued and certbot TLS mode enabled. Restart the server/container to load the new certificate.",
        },
        { headers: deps.CORS_HEADERS },
      );
    } catch (error: any) {
      logger.error("[TLS] certbot auto-setup failed", error);

      logAudit({
        timestamp: Date.now(),
        username: user.username,
        ip: deps.requestIP?.(req)?.address || "unknown",
        action: AuditAction.COMMAND,
        details: `Certbot setup failed for domain ${domain}`,
        success: false,
        errorMessage: String(error?.message || error),
      });

      return Response.json(
        {
          ok: false,
          error: String(error?.message || "Certbot setup failed"),
        },
        { status: 400, headers: deps.CORS_HEADERS },
      );
    }
  }

  if (req.method === "GET" && url.pathname === "/api/audit-logs") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    try {
      requirePermission(user, "audit:view");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    const page = Math.max(1, Number(url.searchParams.get("page") || 1));
    const pageSize = Math.max(1, Math.min(100, Number(url.searchParams.get("pageSize") || 50)));
    const targetClientId = (url.searchParams.get("clientId") || "").trim();
    const action = (url.searchParams.get("action") || "").trim();
    const actionsRaw = (url.searchParams.get("actions") || "").trim();
    const actions = actionsRaw
      ? actionsRaw
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : undefined;
    const startDate = Number(url.searchParams.get("startDate") || 0) || undefined;
    const endDate = Number(url.searchParams.get("endDate") || 0) || undefined;
    const successOnly = url.searchParams.get("successOnly") === "true";

    const result = getAuditLogs({
      page,
      pageSize,
      targetClientId: targetClientId || undefined,
      action: action || undefined,
      actions,
      startDate,
      endDate,
      successOnly,
    });

    return Response.json(result, { headers: deps.CORS_HEADERS });
  }

  if (req.method === "GET" && url.pathname === "/api/proxy/list") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (user.role === "viewer") {
      return new Response("Forbidden", { status: 403 });
    }
    return Response.json({ proxies: getActiveProxies() }, { headers: deps.CORS_HEADERS });
  }

  if (req.method === "POST" && url.pathname === "/api/proxy/start") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (user.role === "viewer") {
      return new Response("Forbidden", { status: 403 });
    }
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, message: "Invalid JSON" }, { status: 400 });
    }
    const clientId = typeof body?.clientId === "string" ? body.clientId.trim() : "";
    const port = typeof body?.port === "number" ? Math.floor(body.port) : 0;
    if (!clientId) {
      return Response.json({ ok: false, message: "clientId is required" }, { status: 400 });
    }
    if (port < 1 || port > 65535) {
      return Response.json({ ok: false, message: "port must be 1-65535" }, { status: 400 });
    }
    const result = startProxy(clientId, port);
    return Response.json(result, {
      status: result.ok ? 200 : 400,
      headers: deps.CORS_HEADERS,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/proxy/stop") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (user.role === "viewer") {
      return new Response("Forbidden", { status: 403 });
    }
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, message: "Invalid JSON" }, { status: 400 });
    }
    const port = typeof body?.port === "number" ? Math.floor(body.port) : 0;
    if (port < 1 || port > 65535) {
      return Response.json({ ok: false, message: "port must be 1-65535" }, { status: 400 });
    }
    const result = stopProxy(port);
    return Response.json(result, {
      status: result.ok ? 200 : 400,
      headers: deps.CORS_HEADERS,
    });
  }

  if (req.method === "GET" && url.pathname === "/api/cert/info") {
    return Response.json(
      { source: deps.tlsSource || "unknown" },
      { headers: { "Content-Type": "application/json", ...deps.CORS_HEADERS } },
    );
  }

  if (req.method === "GET" && url.pathname === "/api/settings/export") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (user.role !== "admin") {
      return new Response("Forbidden: Admin access required", { status: 403 });
    }

    const exportData = getExportableConfig(deps.SERVER_VERSION);

    logAudit({
      timestamp: Date.now(),
      username: user.username,
      ip: deps.requestIP?.(req)?.address || "unknown",
      action: AuditAction.COMMAND,
      details: "Exported settings",
      success: true,
    });

    const dateStr = new Date().toISOString().slice(0, 10);
    return new Response(JSON.stringify(exportData, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="overlord-settings-${dateStr}.json"`,
        ...deps.CORS_HEADERS,
      },
    });
  }

  if (req.method === "POST" && url.pathname === "/api/settings/import") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (user.role !== "admin") {
      return new Response("Forbidden: Admin access required", { status: 403 });
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (!body || typeof body !== "object") {
      return Response.json({ error: "Expected a JSON object" }, { status: 400 });
    }

    try {
      const result = await importFullConfig(body);

      logAudit({
        timestamp: Date.now(),
        username: user.username,
        ip: deps.requestIP?.(req)?.address || "unknown",
        action: AuditAction.COMMAND,
        details: `Imported settings: ${result.applied.join(", ") || "none"}`,
        success: true,
      });

      return Response.json({ ok: true, applied: result.applied, warnings: result.warnings }, { headers: deps.CORS_HEADERS });
    } catch (error: any) {
      logAudit({
        timestamp: Date.now(),
        username: user.username,
        ip: deps.requestIP?.(req)?.address || "unknown",
        action: AuditAction.COMMAND,
        details: "Settings import failed",
        success: false,
        errorMessage: String(error?.message || error),
      });

      return Response.json({ ok: false, error: String(error?.message || "Import failed") }, { status: 400, headers: deps.CORS_HEADERS });
    }
  }

  if (url.pathname === "/api/settings/appearance") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (user.role !== "admin") {
      return new Response("Forbidden: Admin access required", { status: 403 });
    }

    if (req.method === "GET") {
      return Response.json(
        { customCSS: getConfig().appearance?.customCSS || "" },
        { headers: deps.CORS_HEADERS },
      );
    }

    if (req.method === "PUT") {
      let body: any = {};
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }

      const customCSS = typeof body?.customCSS === "string" ? body.customCSS : "";
      if (customCSS.length > 51200) {
        return Response.json({ error: "CSS exceeds 50 KB limit" }, { status: 400 });
      }

      const updated = await updateAppearanceConfig(customCSS);

      logAudit({
        timestamp: Date.now(),
        username: user.username,
        ip: deps.requestIP?.(req)?.address || "unknown",
        action: AuditAction.COMMAND,
        details: "Updated custom CSS",
        success: true,
      });

      return Response.json({ ok: true, customCSS: updated.customCSS }, { headers: deps.CORS_HEADERS });
    }
  }

  // ---- In-app update endpoints ----

  if (req.method === "GET" && url.pathname === "/api/update/check") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (user.role !== "admin") {
      return new Response("Forbidden: Admin access required", { status: 403 });
    }

    try {
      const result = await checkForUpdate(deps.SERVER_VERSION);
      return Response.json(result, { headers: deps.CORS_HEADERS });
    } catch (error: any) {
      logger.error("[update] check failed", error);
      return Response.json(
        { error: String(error?.message || "Update check failed") },
        { status: 502, headers: deps.CORS_HEADERS },
      );
    }
  }

  if (req.method === "POST" && url.pathname === "/api/update/start") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (user.role !== "admin") {
      return new Response("Forbidden: Admin access required", { status: 403 });
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const targetVersion = typeof body?.targetVersion === "string" ? body.targetVersion.trim() : "";
    if (!targetVersion) {
      return Response.json({ error: "targetVersion is required" }, { status: 400 });
    }

    const pending = await hasPendingRequest();
    if (pending) {
      return Response.json(
        { error: "An update is already pending. Wait for it to complete or check status." },
        { status: 409, headers: deps.CORS_HEADERS },
      );
    }

    await writeUpdateRequest({
      requestedAt: Date.now(),
      requestedBy: user.username,
      targetVersion,
    });

    logAudit({
      timestamp: Date.now(),
      username: user.username,
      ip: deps.requestIP?.(req)?.address || "unknown",
      action: AuditAction.COMMAND,
      details: `Triggered in-app update to version ${targetVersion}`,
      success: true,
    });

    return Response.json({ ok: true, message: "Update requested. The host updater will process it shortly." }, { headers: deps.CORS_HEADERS });
  }

  if (req.method === "GET" && url.pathname === "/api/update/status") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (user.role !== "admin") {
      return new Response("Forbidden: Admin access required", { status: 403 });
    }

    const status = await readUpdateStatus();
    return Response.json(status, { headers: deps.CORS_HEADERS });
  }

  if (req.method === "POST" && url.pathname === "/api/update/reset") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (user.role !== "admin") {
      return new Response("Forbidden: Admin access required", { status: 403 });
    }

    await clearUpdateStatus();
    return Response.json({ ok: true }, { headers: deps.CORS_HEADERS });
  }

  if (req.method === "GET" && url.pathname === "/api/cert/download" && deps.tlsCertPath) {
    try {
      const file = Bun.file(deps.tlsCertPath);
      if (await file.exists()) {
        return new Response(file, {
          headers: {
            "Content-Type": "application/x-pem-file",
            "Content-Disposition": 'attachment; filename="overlord-ca.crt"',
            ...deps.CORS_HEADERS,
          },
        });
      }
    } catch { }
    return new Response("Certificate not available", { status: 404 });
  }

  return null;
}
