import { authenticateRequest } from "../../auth";
import { getConfig, updateEnrollmentConfig } from "../../config";
import {
  getPendingClients,
  getEnrollmentStats,
  setClientEnrollmentStatus,
  getClientEnrollmentStatus,
  getClientIp,
  banIp,
  unbanIp,
  isIpBanned,
  listBannedIps,
  getClientBuildOwnership,
} from "../../db";
import { logAudit, AuditAction } from "../../auditLog";
import * as clientManager from "../../clientManager";
import { setOnlineState } from "../../db";
import { requirePermission } from "../../rbac";
import { getUserById, getUserClientAccessScope, setUserClientAccessScope, setUserClientAccessRule } from "../../users";


function grantBuildOwnerAccess(clientId: string): void {
  const ownership = getClientBuildOwnership(clientId);
  if (!ownership || ownership.builtByUserId == null) return;

  const owner = getUserById(ownership.builtByUserId);
  if (!owner || owner.role === "admin") return;

  const currentScope = getUserClientAccessScope(ownership.builtByUserId);
  if (currentScope === "none") {
    setUserClientAccessScope(ownership.builtByUserId, "allowlist");
  }
  if (currentScope === "none" || currentScope === "allowlist") {
    setUserClientAccessRule(ownership.builtByUserId, clientId, "allow");
  }
}

function getClientScopeFilters(userId: number, role: string): {
  allowedClientIds?: string[];
  deniedClientIds?: string[];
  builtByUserId?: number;
  requireBuildOwner?: boolean;
} {
  if (role === "admin") return {};
  return {
    builtByUserId: userId,
    requireBuildOwner: true,
  };
}

function canManageEnrollmentClient(
  userId: number,
  role: string,
  clientId: string,
): boolean {
  if (role === "admin") return true;
  if (role !== "operator") return false;

  const ownership = getClientBuildOwnership(clientId);
  if (!ownership || ownership.builtByUserId == null) return false;
  return ownership.builtByUserId === userId;
}

let _postApproveHook: ((clientId: string) => void) | undefined;

export function setPostApproveHook(hook: (clientId: string) => void): void {
  _postApproveHook = hook;
}

export async function handleEnrollmentRoutes(
  req: Request,
  url: URL,
): Promise<Response | null> {
  // GET /api/enrollment/pending
  if (req.method === "GET" && url.pathname === "/api/enrollment/pending") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try {
      requirePermission(user, "clients:enroll");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    const scopeFilters = getClientScopeFilters(user.userId, user.role);
    const clients = getPendingClients(scopeFilters);
    return Response.json({ items: clients });
  }

  // GET /api/enrollment/stats
  if (req.method === "GET" && url.pathname === "/api/enrollment/stats") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try {
      requirePermission(user, "clients:enroll");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    const scopeFilters = getClientScopeFilters(user.userId, user.role);
    const stats = getEnrollmentStats(scopeFilters);
    return Response.json(stats);
  }

  // GET /api/enrollment/settings
  if (req.method === "GET" && url.pathname === "/api/enrollment/settings") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });

    const config = getConfig();
    return Response.json({
      requireApproval: config.enrollment?.requireApproval ?? true,
      autoApproveUnlessSuspicious: config.enrollment?.autoApproveUnlessSuspicious ?? false,
    });
  }

  // POST /api/enrollment/settings
  if (req.method === "POST" && url.pathname === "/api/enrollment/settings") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    if (user.role !== "admin") return new Response("Forbidden", { status: 403 });

    let body: any;
    try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }

    const updates: { requireApproval?: boolean; autoApproveUnlessSuspicious?: boolean } = {};
    if (typeof body?.requireApproval === "boolean") updates.requireApproval = body.requireApproval;
    if (typeof body?.autoApproveUnlessSuspicious === "boolean") updates.autoApproveUnlessSuspicious = body.autoApproveUnlessSuspicious;

    if (Object.keys(updates).length === 0) {
      return Response.json({ error: "No valid boolean fields provided" }, { status: 400 });
    }

    const updated = await updateEnrollmentConfig(updates);

    logAudit({
      timestamp: Date.now(),
      username: user.username,
      ip: "server",
      action: AuditAction.ENROLLMENT_SETTINGS,
      success: true,
      details: JSON.stringify(updates),
    });

    return Response.json({ ok: true, requireApproval: updated.requireApproval, autoApproveUnlessSuspicious: updated.autoApproveUnlessSuspicious });
  }

  // POST /api/enrollment/:id/approve
  const approveMatch = url.pathname.match(/^\/api\/enrollment\/([^/]+)\/approve$/);
  if (req.method === "POST" && approveMatch) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try {
      requirePermission(user, "clients:enroll");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    const clientId = decodeURIComponent(approveMatch[1]);
    const current = getClientEnrollmentStatus(clientId);
    if (!current) return Response.json({ error: "Client not found" }, { status: 404 });

    if (!canManageEnrollmentClient(user.userId, user.role, clientId)) {
      return new Response("Forbidden: Client access denied", { status: 403 });
    }

    setClientEnrollmentStatus(clientId, "approved", user.username);

    grantBuildOwnerAccess(clientId);

    _postApproveHook?.(clientId);

    logAudit({
      timestamp: Date.now(),
      username: user.username,
      ip: "server",
      action: AuditAction.ENROLLMENT_APPROVE,
      targetClientId: clientId,
      success: true,
      details: JSON.stringify({ enrollment: "approved" }),
    });

    return Response.json({ ok: true, status: "approved" });
  }

  // POST /api/enrollment/:id/deny
  const denyMatch = url.pathname.match(/^\/api\/enrollment\/([^/]+)\/deny$/);
  if (req.method === "POST" && denyMatch) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try {
      requirePermission(user, "clients:enroll");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    const clientId = decodeURIComponent(denyMatch[1]);
    const current = getClientEnrollmentStatus(clientId);
    if (!current) return Response.json({ error: "Client not found" }, { status: 404 });

    if (!canManageEnrollmentClient(user.userId, user.role, clientId)) {
      return new Response("Forbidden: Client access denied", { status: 403 });
    }

    let denyBody: any = {};
    try { denyBody = await req.json(); } catch {}
    const denyReason = typeof denyBody?.reason === "string" ? denyBody.reason.slice(0, 200).trim() || undefined : undefined;

    setClientEnrollmentStatus(clientId, "denied", undefined, denyReason);

    logAudit({
      timestamp: Date.now(),
      username: user.username,
      ip: "server",
      action: AuditAction.ENROLLMENT_DENY,
      targetClientId: clientId,
      success: true,
      details: JSON.stringify({ enrollment: "denied" }),
    });

    return Response.json({ ok: true, status: "denied" });
  }

  // POST /api/enrollment/:id/reset
  const resetMatch = url.pathname.match(/^\/api\/enrollment\/([^/]+)\/reset$/);
  if (req.method === "POST" && resetMatch) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try {
      requirePermission(user, "clients:enroll");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    const clientId = decodeURIComponent(resetMatch[1]);
    const current = getClientEnrollmentStatus(clientId);
    if (!current) return Response.json({ error: "Client not found" }, { status: 404 });

    if (!canManageEnrollmentClient(user.userId, user.role, clientId)) {
      return new Response("Forbidden: Client access denied", { status: 403 });
    }

    setClientEnrollmentStatus(clientId, "pending");

    return Response.json({ ok: true, status: "pending" });
  }

  // POST /api/enrollment/bulk
  if (req.method === "POST" && url.pathname === "/api/enrollment/bulk") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try {
      requirePermission(user, "clients:enroll");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    let body: any;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const ids = Array.isArray(body?.ids) ? body.ids.filter((id: unknown) => typeof id === "string") : [];
    const action = body?.action;

    if (!["approve", "deny", "reset", "ban-ip"].includes(action)) {
      return Response.json({ error: "action must be 'approve', 'deny', 'reset', or 'ban-ip'" }, { status: 400 });
    }
    if (ids.length === 0) {
      return Response.json({ error: "ids array is required" }, { status: 400 });
    }

    if (action === "ban-ip") {
      let banned = 0;
      for (const id of ids) {
        if (!canManageEnrollmentClient(user.userId, user.role, id)) continue;
        const clientIp = getClientIp(id);
        if (!clientIp) continue;
        banIp(clientIp, `Bulk banned from purgatory by ${user.username}`);
        setClientEnrollmentStatus(id, "denied");
        const target = clientManager.getClient(id);
        if (target) {
          try { target.ws.close(4003, "banned"); } catch {}
          setOnlineState(id, false);
        }
        banned++;
      }

      logAudit({
        timestamp: Date.now(),
        username: user.username,
        ip: "server",
        action: AuditAction.ENROLLMENT_BULK,
        success: true,
        details: JSON.stringify({ enrollment: { bulk: "ban-ip", count: banned } }),
      });

      return Response.json({ ok: true, action, updated: banned });
    }

    const bulkDenyReason = typeof body?.reason === "string" ? body.reason.slice(0, 200).trim() || undefined : undefined;
    const status = action === "approve" ? "approved" : action === "deny" ? "denied" : "pending";
    let updated = 0;
    for (const id of ids) {
      if (!canManageEnrollmentClient(user.userId, user.role, id)) continue;
      const ok = setClientEnrollmentStatus(
        id,
        status as "approved" | "denied" | "pending",
        action === "approve" ? user.username : undefined,
        action === "deny" ? bulkDenyReason : undefined,
      );
      if (ok) {
        updated++;
        if (action === "approve") {
          grantBuildOwnerAccess(id);
          _postApproveHook?.(id);
        }
      }
    }

    logAudit({
      timestamp: Date.now(),
      username: user.username,
      ip: "server",
      action: AuditAction.ENROLLMENT_BULK,
      success: true,
      details: JSON.stringify({ enrollment: { bulk: action, count: updated } }),
    });

    return Response.json({ ok: true, action, updated });
  }

  // POST /api/enrollment/:id/ban-ip
  // Ban ip API makes me wanna fucking kms.
  const banMatch = url.pathname.match(/^\/api\/enrollment\/([^/]+)\/ban-ip$/);
  if (req.method === "POST" && banMatch) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try {
      requirePermission(user, "clients:enroll");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    const clientId = decodeURIComponent(banMatch[1]);
    const targetIp = getClientIp(clientId);
    if (!targetIp) return Response.json({ error: "Client IP not found" }, { status: 404 });

    if (!canManageEnrollmentClient(user.userId, user.role, clientId)) {
      return new Response("Forbidden: Client access denied", { status: 403 });
    }

    banIp(targetIp, `Banned from purgatory by ${user.username} for client ${clientId}`);
    setClientEnrollmentStatus(clientId, "denied");

    const target = clientManager.getClient(clientId);
    if (target) {
      try { target.ws.close(4003, "banned"); } catch {}
      setOnlineState(clientId, false);
    }

    logAudit({
      timestamp: Date.now(),
      username: user.username,
      ip: "server",
      action: AuditAction.ENROLLMENT_DENY,
      targetClientId: clientId,
      success: true,
      details: JSON.stringify({ bannedIp: targetIp }),
    });

    return Response.json({ ok: true, ip: targetIp });
  }

  // GET /api/enrollment/banned-ips
  if (req.method === "GET" && url.pathname === "/api/enrollment/banned-ips") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try {
      requirePermission(user, "network:manage-bans");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    return Response.json({ items: listBannedIps() });
  }

  // DELETE /api/enrollment/banned-ips?ip=...
  if (req.method === "DELETE" && url.pathname === "/api/enrollment/banned-ips") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try {
      requirePermission(user, "network:manage-bans");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    const ipToUnban = (url.searchParams.get("ip") || "").trim();
    if (!ipToUnban) return Response.json({ error: "Missing ip parameter" }, { status: 400 });
    if (!/^[0-9a-fA-F:.]{3,64}$/.test(ipToUnban)) return Response.json({ error: "Invalid IP format" }, { status: 400 });
    if (!isIpBanned(ipToUnban)) return Response.json({ error: "IP is not banned" }, { status: 404 });

    unbanIp(ipToUnban);

    logAudit({
      timestamp: Date.now(),
      username: user.username,
      ip: "server",
      action: AuditAction.ENROLLMENT_BULK,
      success: true,
      details: JSON.stringify({ unbannedIp: ipToUnban }),
    });

    return Response.json({ ok: true });
  }

  // POST /api/enrollment/ban-ip (manual IP ban)
  if (req.method === "POST" && url.pathname === "/api/enrollment/ban-ip") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try {
      requirePermission(user, "network:manage-bans");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    let body: any;
    try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }

    const ip = typeof body?.ip === "string" ? body.ip.trim() : "";
    if (!ip) return Response.json({ error: "ip is required" }, { status: 400 });
    if (!/^[0-9a-fA-F:.]{3,64}$/.test(ip)) return Response.json({ error: "Invalid IP format" }, { status: 400 });

    const reason = typeof body?.reason === "string" ? body.reason.slice(0, 200) : `Banned from purgatory by ${user.username}`;
    banIp(ip, reason);

    logAudit({
      timestamp: Date.now(),
      username: user.username,
      ip: "server",
      action: AuditAction.ENROLLMENT_DENY,
      success: true,
      details: JSON.stringify({ bannedIp: ip, reason }),
    });

    return Response.json({ ok: true, ip });
  }

  return null;
}
