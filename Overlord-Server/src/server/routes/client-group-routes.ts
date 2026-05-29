import { authenticateRequest } from "../../auth";
import { AuditAction, logAudit } from "../../auditLog";
import {
  clientExists,
  listGroups,
  getGroup,
  createGroup,
  updateGroup,
  deleteGroup,
  setClientGroup,
} from "../../db";
import { requireClientAccess, requireFeatureAccess, requirePermission } from "../../rbac";
import { canUserAccessClient } from "../../users";
import { notifyDashboardViewers } from "../../sessions/sessionManager";

type RequestIpProvider = {
  requestIP: (req: Request) => { address?: string } | null | undefined;
};

type ClientGroupDeps = {
  CORS_HEADERS: Record<string, string>;
};

export async function handleClientGroupRoutes(
  req: Request,
  url: URL,
  server: RequestIpProvider,
  deps: ClientGroupDeps,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/groups") &&
      url.pathname !== "/api/clients/bulk-group" &&
      !url.pathname.match(/^\/api\/clients\/[^/]+\/group$/)) {
    return null;
  }

  if (url.pathname === "/api/groups") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });

    if (req.method === "GET") {
      return Response.json({ groups: listGroups() }, { headers: deps.CORS_HEADERS });
    }

    if (req.method === "POST") {
      try { requirePermission(user, "clients:control"); } catch (error) {
        if (error instanceof Response) return error;
        return new Response("Forbidden", { status: 403 });
      }
      let body: any = {};
      try { body = await req.json(); } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      const color = typeof body?.color === "string" ? body.color.trim() : "#3b82f6";
      if (!name || name.length > 64) {
        return Response.json({ error: "Name is required and must be 64 characters or fewer" }, { status: 400 });
      }
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
        return Response.json({ error: "Color must be a valid hex code (#RRGGBB)" }, { status: 400 });
      }
      const group = createGroup(name, color);
      const ip = server.requestIP(req)?.address || "unknown";
      logAudit({ timestamp: Date.now(), username: user.username, ip, action: AuditAction.COMMAND, details: `create_group:${name}`, success: true });
      return Response.json(group, { status: 201, headers: deps.CORS_HEADERS });
    }
  }

  const groupIdMatch = url.pathname.match(/^\/api\/groups\/(\d+)$/);
  if (groupIdMatch) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try { requirePermission(user, "clients:control"); } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }
    const groupId = Number(groupIdMatch[1]);

    if (req.method === "PATCH") {
      let body: any = {};
      try { body = await req.json(); } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }
      const existing = getGroup(groupId);
      if (!existing) return Response.json({ error: "Group not found" }, { status: 404 });
      const name = typeof body?.name === "string" ? body.name.trim() : existing.name;
      const color = typeof body?.color === "string" ? body.color.trim() : existing.color;
      if (name.length === 0 || name.length > 64) {
        return Response.json({ error: "Name must be 1-64 characters" }, { status: 400 });
      }
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
        return Response.json({ error: "Color must be a valid hex code (#RRGGBB)" }, { status: 400 });
      }
      const updated = updateGroup(groupId, name, color);
      if (!updated) return Response.json({ error: "Group not found" }, { status: 404 });
      notifyDashboardViewers();
      const ip = server.requestIP(req)?.address || "unknown";
      logAudit({ timestamp: Date.now(), username: user.username, ip, action: AuditAction.COMMAND, details: `update_group:${groupId}`, success: true });
      return Response.json({ ok: true, id: groupId, name, color }, { headers: deps.CORS_HEADERS });
    }

    if (req.method === "DELETE") {
      const deleted = deleteGroup(groupId);
      if (!deleted) return Response.json({ error: "Group not found" }, { status: 404 });
      notifyDashboardViewers();
      const ip = server.requestIP(req)?.address || "unknown";
      logAudit({ timestamp: Date.now(), username: user.username, ip, action: AuditAction.COMMAND, details: `delete_group:${groupId}`, success: true });
      return Response.json({ ok: true }, { headers: deps.CORS_HEADERS });
    }
  }

  if (req.method === "PATCH" && url.pathname === "/api/clients/bulk-group") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try { requirePermission(user, "clients:metadata"); requireFeatureAccess(user, "client_metadata"); } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }
    let body: any = {};
    try { body = await req.json(); } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const clientIds = body?.clientIds;
    if (!Array.isArray(clientIds) || clientIds.length === 0 || clientIds.some((id: any) => typeof id !== "string")) {
      return Response.json({ error: "clientIds must be a non-empty array of strings" }, { status: 400 });
    }
    if (clientIds.length > 500) {
      return Response.json({ error: "Too many clients (max 500)" }, { status: 400 });
    }
    const groupId = body?.groupId === null ? null : Number(body?.groupId);
    if (groupId !== null && (isNaN(groupId) || groupId < 1)) {
      return Response.json({ error: "Invalid groupId" }, { status: 400 });
    }
    let updated = 0;
    for (const cid of clientIds) {
      if (!canUserAccessClient(user.userId, user.role, cid)) continue;
      if (setClientGroup(cid, groupId)) updated++;
    }
    notifyDashboardViewers();
    const ip = server.requestIP(req)?.address || "unknown";
    logAudit({ timestamp: Date.now(), username: user.username, ip, action: AuditAction.COMMAND, details: `bulk_set_group:${groupId ?? "none"}:${updated}/${clientIds.length}`, success: true });
    return Response.json({ ok: true, updated, total: clientIds.length, groupId }, { headers: deps.CORS_HEADERS });
  }

  const clientGroupMatch = url.pathname.match(/^\/api\/clients\/([^/]+)\/group$/);
  if (req.method === "PATCH" && clientGroupMatch) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try { requirePermission(user, "clients:metadata"); requireFeatureAccess(user, "client_metadata"); } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }
    const targetId = clientGroupMatch[1];
    try {
      requireClientAccess(user, targetId);
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }
    if (!clientExists(targetId)) {
      return Response.json({ error: "Client not found" }, { status: 404 });
    }
    let body: any = {};
    try { body = await req.json(); } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const groupId = body?.groupId === null ? null : Number(body?.groupId);
    if (groupId !== null && (isNaN(groupId) || groupId < 1)) {
      return Response.json({ error: "Invalid groupId" }, { status: 400 });
    }
    const updated = setClientGroup(targetId, groupId);
    if (!updated) {
      return Response.json({ error: "Client not found or group does not exist" }, { status: 404 });
    }
    notifyDashboardViewers();
    const ip = server.requestIP(req)?.address || "unknown";
    logAudit({ timestamp: Date.now(), username: user.username, ip, action: AuditAction.COMMAND, targetClientId: targetId, details: groupId ? `set_group:${groupId}` : "clear_group", success: true });
    return Response.json({ ok: true, groupId }, { headers: deps.CORS_HEADERS });
  }

  return null;
}
