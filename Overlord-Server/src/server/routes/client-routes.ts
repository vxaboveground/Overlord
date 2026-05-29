import { v4 as uuidv4 } from "uuid";
import { authenticateRequest } from "../../auth";
import { AuditAction, logAudit } from "../../auditLog";
import * as clientManager from "../../clientManager";
import {
  banIp,
  clientExists,
  deleteClientRow,
  deleteOfflineClientRows,
  getClientOnlineState,
  getClientIp,
  isIpBanned,
  listBannedIps,
  listClients,
  listDistinctCountries,
  setClientBookmark,
  setClientNickname,
  setClientNotificationsMuted,
  setClientTag,
  setOnlineState,
  unbanIp,
  deleteNotificationsForClient,
} from "../../db";
import { metrics } from "../../metrics";
import { encodeMessage } from "../../protocol";
import { requireClientAccess, requireFeatureAccess, requirePermission } from "../../rbac";
import {
  canUserAccessClient,
  getUserClientAccessScope,
  listUserClientRuleIdsByAccess,
} from "../../users";
import { notifyDashboardViewers } from "../../sessions/sessionManager";
import { clearThumbnail } from "../../thumbnails";
import { handleClientCommandRoute } from "./client-command-routes";
import { handleClientGroupRoutes } from "./client-group-routes";

type RequestIpProvider = {
  requestIP: (req: Request) => { address?: string } | null | undefined;
};

type PendingScript = {
  resolve: (result: any) => void;
  reject: (error: any) => void;
  timeout: NodeJS.Timeout;
  clientId: string;
};

type PendingCommandReply = {
  resolve: (result: { ok: boolean; message?: string }) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  clientId: string;
};

type ClientRouteDeps = {
  CORS_HEADERS: Record<string, string>;
  pendingScripts: Map<string, PendingScript>;
  pendingCommandReplies: Map<string, PendingCommandReply>;
  broadcastNotificationsCleared: (clientId: string) => void;
};

export async function handleClientRoutes(
  req: Request,
  url: URL,
  server: RequestIpProvider,
  deps: ClientRouteDeps,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/clients") && !url.pathname.startsWith("/api/groups")) {
    return null;
  }

  if (url.pathname === "/api/clients") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    const page = Math.max(1, Number(url.searchParams.get("page") || 1));
    const pageSize = Math.max(1, Number(url.searchParams.get("pageSize") || 12));
    const search = (url.searchParams.get("q") || "").toLowerCase().trim();
    const sort = url.searchParams.get("sort") || "last_seen_desc";
    const statusFilter = url.searchParams.get("status") || "all";
    const osFilter = url.searchParams.get("os") || "all";
    const countryFilter = url.searchParams.get("country") || "all";
    const enrollmentFilter = url.searchParams.get("enrollmentFilter") || "approved";
    const groupFilter = url.searchParams.get("group") || "all";
    const isEnrollmentRequest = url.searchParams.has("enrollmentFilter");

    if (user.role === "admin") {
      const result = listClients({ page, pageSize, search, sort, statusFilter, osFilter, countryFilter, enrollmentFilter, groupFilter });
      return Response.json(result, { headers: deps.CORS_HEADERS });
    }

    if (user.role === "operator" && isEnrollmentRequest) {
      const result = listClients({ page, pageSize, search, sort, statusFilter, osFilter, countryFilter, enrollmentFilter, groupFilter, builtByUserId: user.userId, requireBuildOwner: true });
      return Response.json(result, { headers: deps.CORS_HEADERS });
    }

    const scope = getUserClientAccessScope(user.userId);
    if (scope === "none") {
      return Response.json({ page, pageSize, total: 0, online: 0, items: [] }, { headers: deps.CORS_HEADERS });
    }

    const allowedClientIds = scope === "allowlist" ? listUserClientRuleIdsByAccess(user.userId, "allow") : undefined;
    const deniedClientIds = scope === "denylist" ? listUserClientRuleIdsByAccess(user.userId, "deny") : undefined;

    const result = listClients({ page, pageSize, search, sort, statusFilter, osFilter, countryFilter, enrollmentFilter, groupFilter, allowedClientIds, deniedClientIds });
    return Response.json(result, { headers: deps.CORS_HEADERS });
  }

  if (url.pathname === "/api/clients/countries") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    return Response.json({ countries: listDistinctCountries() }, { headers: deps.CORS_HEADERS });
  }

  if (url.pathname === "/api/clients/banned-ips") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try {
      requirePermission(user, "network:manage-bans");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    if (req.method === "GET") {
      return Response.json({ items: listBannedIps() }, { headers: deps.CORS_HEADERS });
    }

    if (req.method === "DELETE") {
      const ipToUnban = (url.searchParams.get("ip") || "").trim();
      if (!ipToUnban) return Response.json({ error: "Missing ip query parameter" }, { status: 400 });
      if (!/^[0-9a-fA-F:.]{3,64}$/.test(ipToUnban)) return Response.json({ error: "Invalid IP format" }, { status: 400 });
      if (!isIpBanned(ipToUnban)) return Response.json({ error: "IP is not banned" }, { status: 404 });

      unbanIp(ipToUnban);
      const ip = server.requestIP(req)?.address || "unknown";
      logAudit({ timestamp: Date.now(), username: user.username, ip, action: AuditAction.COMMAND, details: `Unbanned IP ${ipToUnban}`, success: true });
      return Response.json({ ok: true }, { headers: deps.CORS_HEADERS });
    }
  }

  const banMatch = url.pathname.match(/^\/api\/clients\/(.+)\/ban$/);
  if (req.method === "POST" && banMatch) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try { requirePermission(user, "clients:control"); } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }
    const targetId = banMatch[1];
    try { requireClientAccess(user, targetId); } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }
    const target = clientManager.getClient(targetId);
    const targetIp = target?.ip || getClientIp(targetId);
    if (!targetIp) return Response.json({ error: "Client IP not found" }, { status: 404 });

    banIp(targetIp, `Banned by ${user.username} for client ${targetId}`);
    if (target) {
      try { target.ws.close(4003, "banned"); } catch { }
      setOnlineState(targetId, false);
    }
    const ip = server.requestIP(req)?.address || "unknown";
    logAudit({ timestamp: Date.now(), username: user.username, ip, action: AuditAction.COMMAND, targetClientId: targetId, details: `Banned IP ${targetIp}`, success: true });
    return Response.json({ ok: true, ip: targetIp });
  }

  const thumbnailMatch = url.pathname.match(/^\/api\/clients\/(.+)\/thumbnail$/);
  if (req.method === "POST" && thumbnailMatch) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    const clientId = thumbnailMatch[1];
    try { requireClientAccess(user, clientId); } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }
    const { requestThumbnailRegen, markThumbnailRequested, getThumbnailVersion, waitForThumbnail, clearThumbnailRequest } = await import("../../thumbnails");
    markThumbnailRequested(clientId);
    const target = clientManager.getClient(clientId);
    const beforeVersion = getThumbnailVersion(clientId);
    if (target?.online) {
      const commandId = uuidv4();
      target.ws.send(encodeMessage({ type: "command", commandType: "screenshot", id: commandId, payload: { mode: "notification", allDisplays: true } }));
      metrics.recordCommand("screenshot");
    }
    const fresh = target?.online ? await waitForThumbnail(clientId, 2500) : false;
    if (fresh) {
      await new Promise((r) => setTimeout(r, 300));
    } else {
      await requestThumbnailRegen(clientId);
    }
    clearThumbnailRequest(clientId);
    const version = getThumbnailVersion(clientId);
    return Response.json({ ok: true, updated: version > beforeVersion, version }, { headers: deps.CORS_HEADERS });
  }

  if (req.method === "GET" && thumbnailMatch) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    const clientId = thumbnailMatch[1];
    try { requireClientAccess(user, clientId); } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }
    const { getThumbnailRecord } = await import("../../thumbnails");
    const record = getThumbnailRecord(clientId);
    if (!record) return new Response("Not Found", { status: 404 });
    return new Response(record.bytes as unknown as BodyInit, {
      status: 200,
      headers: { "Content-Type": record.contentType, "Content-Length": String(record.bytes.byteLength), "Cache-Control": "no-store" },
    });
  }

  if (req.method === "DELETE" && url.pathname === "/api/clients/offline") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try { requirePermission(user, "clients:control"); } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }
    const count = deleteOfflineClientRows();
    notifyDashboardViewers();
    const ip = server.requestIP(req)?.address || "unknown";
    logAudit({ timestamp: Date.now(), username: user.username, ip, action: AuditAction.COMMAND, details: `wipe_offline_clients: removed ${count}`, success: true });
    return Response.json({ ok: true, count }, { headers: deps.CORS_HEADERS });
  }

  const clientDeleteMatch = url.pathname.match(/^\/api\/clients\/([^/]+)$/);
  if (req.method === "DELETE" && clientDeleteMatch) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try { requirePermission(user, "clients:control"); } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }
    const targetId = clientDeleteMatch[1];
    try { requireClientAccess(user, targetId); } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }
    const target = clientManager.getClient(targetId);
    const isOnlineInDb = getClientOnlineState(targetId);
    if (target?.online || isOnlineInDb === true) {
      return Response.json({ error: "Client is online. Remove from dashboard is only allowed for offline clients." }, { status: 409 });
    }
    const existsInDb = clientExists(targetId);
    if (!target && !existsInDb) return Response.json({ error: "Client not found" }, { status: 404 });

    if (target) {
      try { target.ws.close(4000, "removed"); } catch { }
      clientManager.deleteClient(targetId);
      setOnlineState(targetId, false);
    }
    deleteClientRow(targetId);
    clearThumbnail(targetId);
    notifyDashboardViewers();
    const ip = server.requestIP(req)?.address || "unknown";
    logAudit({ timestamp: Date.now(), username: user.username, ip, action: AuditAction.COMMAND, targetClientId: targetId, details: "remove_dashboard", success: true });
    return Response.json({ ok: true }, { headers: deps.CORS_HEADERS });
  }

  const clientNicknameMatch = url.pathname.match(/^\/api\/clients\/([^/]+)\/nickname$/);
  if (req.method === "PATCH" && clientNicknameMatch) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try { requirePermission(user, "clients:metadata"); requireFeatureAccess(user, "client_metadata"); } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }
    const targetId = clientNicknameMatch[1];
    try { requireClientAccess(user, targetId); } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }
    if (!clientExists(targetId)) return Response.json({ error: "Client not found" }, { status: 404 });
    let body: any = {};
    try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON body" }, { status: 400 }); }
    const rawNickname = typeof body?.nickname === "string" ? body.nickname : "";
    const trimmed = rawNickname.trim();
    if (trimmed.length > 64) return Response.json({ error: "Nickname must be 64 characters or fewer" }, { status: 400 });
    const nickname = trimmed.length ? trimmed : null;
    const updated = setClientNickname(targetId, nickname);
    if (!updated) return Response.json({ error: "Client not found" }, { status: 404 });
    notifyDashboardViewers();
    const ip = server.requestIP(req)?.address || "unknown";
    logAudit({ timestamp: Date.now(), username: user.username, ip, action: AuditAction.COMMAND, targetClientId: targetId, details: nickname ? `set_nickname:${nickname}` : "clear_nickname", success: true });
    return Response.json({ ok: true, nickname }, { headers: deps.CORS_HEADERS });
  }

  const clientTagMatch = url.pathname.match(/^\/api\/clients\/([^/]+)\/tag$/);
  if (req.method === "PATCH" && clientTagMatch) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try { requirePermission(user, "clients:metadata"); requireFeatureAccess(user, "client_metadata"); } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }
    const targetId = clientTagMatch[1];
    try { requireClientAccess(user, targetId); } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }
    if (!clientExists(targetId)) return Response.json({ error: "Client not found" }, { status: 404 });
    let body: any = {};
    try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON body" }, { status: 400 }); }
    const rawTag = typeof body?.tag === "string" ? body.tag : "";
    const rawNote = typeof body?.note === "string" ? body.note : "";
    const tag = rawTag.trim();
    if (tag.length > 64) return Response.json({ error: "Tag must be 64 characters or fewer" }, { status: 400 });
    const normalizedTag = tag.length ? tag : null;
    const note = normalizedTag ? rawNote : null;
    const updated = setClientTag(targetId, normalizedTag, note);
    if (!updated) return Response.json({ error: "Client not found" }, { status: 404 });
    notifyDashboardViewers();
    const ip = server.requestIP(req)?.address || "unknown";
    logAudit({ timestamp: Date.now(), username: user.username, ip, action: AuditAction.COMMAND, targetClientId: targetId, details: normalizedTag ? `set_custom_tag:${normalizedTag} (note_len=${note?.length || 0})` : "clear_custom_tag", success: true });
    return Response.json({ ok: true, tag: normalizedTag, note: note ?? null }, { headers: deps.CORS_HEADERS });
  }

  if (req.method === "PATCH" && url.pathname === "/api/clients/bulk-notifications-muted") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try { requirePermission(user, "clients:metadata"); requireFeatureAccess(user, "client_metadata"); } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }
    let body: any = {};
    try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON body" }, { status: 400 }); }
    const clientIds = body?.clientIds;
    if (!Array.isArray(clientIds) || clientIds.length === 0 || clientIds.some((id: any) => typeof id !== "string")) {
      return Response.json({ error: "clientIds must be a non-empty array of strings" }, { status: 400 });
    }
    if (clientIds.length > 500) return Response.json({ error: "Too many clients (max 500)" }, { status: 400 });
    const muted = !!body?.muted;
    let updated = 0;
    let cleared = 0;
    for (const cid of clientIds) {
      if (!canUserAccessClient(user.userId, user.role, cid)) continue;
      if (setClientNotificationsMuted(cid, muted)) updated++;
      cleared += deleteNotificationsForClient(cid);
      deps.broadcastNotificationsCleared(cid);
    }
    notifyDashboardViewers();
    const ip = server.requestIP(req)?.address || "unknown";
    logAudit({ timestamp: Date.now(), username: user.username, ip, action: AuditAction.COMMAND, details: `bulk_set_notifications_muted:${muted}:${updated}/${clientIds.length} (cleared ${cleared})`, success: true });
    return Response.json({ ok: true, updated, total: clientIds.length, muted, cleared }, { headers: deps.CORS_HEADERS });
  }

  const muteMatch = url.pathname.match(/^\/api\/clients\/([^/]+)\/notifications-muted$/);
  if (req.method === "PATCH" && muteMatch) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try { requirePermission(user, "clients:metadata"); requireFeatureAccess(user, "client_metadata"); } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }
    const targetId = muteMatch[1];
    try { requireClientAccess(user, targetId); } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }
    if (!clientExists(targetId)) return Response.json({ error: "Client not found" }, { status: 404 });
    let body: any = {};
    try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON body" }, { status: 400 }); }
    const muted = !!body?.muted;
    const updated = setClientNotificationsMuted(targetId, muted);
    if (!updated) return Response.json({ error: "Client not found" }, { status: 404 });
    const cleared = deleteNotificationsForClient(targetId);
    deps.broadcastNotificationsCleared(targetId);
    notifyDashboardViewers();
    const ip = server.requestIP(req)?.address || "unknown";
    logAudit({ timestamp: Date.now(), username: user.username, ip, action: AuditAction.COMMAND, targetClientId: targetId, details: `${muted ? "mute_notifications" : "unmute_notifications"} (cleared ${cleared})`, success: true });
    return Response.json({ ok: true, muted, cleared }, { headers: deps.CORS_HEADERS });
  }

  const bookmarkMatch = url.pathname.match(/^\/api\/clients\/([^/]+)\/bookmark$/);
  if (req.method === "PATCH" && bookmarkMatch) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    const targetId = bookmarkMatch[1];
    try { requireClientAccess(user, targetId); } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }
    if (!clientExists(targetId)) return Response.json({ error: "Client not found" }, { status: 404 });
    let body: any = {};
    try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON body" }, { status: 400 }); }
    const bookmarked = !!body?.bookmarked;
    const updated = setClientBookmark(targetId, bookmarked);
    if (!updated) return Response.json({ error: "Client not found" }, { status: 404 });
    return Response.json({ ok: true, bookmarked }, { headers: deps.CORS_HEADERS });
  }

  const cmdResult = await handleClientCommandRoute(req, url, server, deps);
  if (cmdResult !== null) return cmdResult;

  const groupResult = await handleClientGroupRoutes(req, url, server, deps);
  if (groupResult !== null) return groupResult;

  return null;
}
