import { authenticateRequest } from "../../auth";
import { AuditAction, logAudit } from "../../auditLog";
import {
  createPermissionGroup,
  deletePermissionGroup,
  getPermissionGroup,
  getUserById,
  getUserExtraPermissions,
  getUserGroupIds,
  listPermissionGroups,
  setUserExtraPermissions,
  setUserGroups,
  updatePermissionGroup,
} from "../../users";
import {
  getPermissionDescription,
  type Permission,
  requirePermission,
} from "../../rbac";

const KNOWN_PERMISSIONS: Permission[] = [
  "users:manage",
  "clients:control",
  "clients:build",
  "clients:enroll",
  "clients:silent-exec",
  "clients:disconnect",
  "clients:reconnect",
  "clients:metadata",
  "clients:uninstall",
  "clients:winre",
  "audit:view",
  "chat:write",
  "scripts:manage",
  "deploys:manage",
  "plugins:manage",
  "plugins:configure",
  "network:manage-bans",
  "system:configure",
];

function sanitizePermissions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set<string>(KNOWN_PERMISSIONS);
  return Array.from(
    new Set(
      raw
        .filter((p): p is string => typeof p === "string")
        .map((p) => p.trim())
        .filter((p) => known.has(p)),
    ),
  );
}

function diffArrays<T>(before: readonly T[], after: readonly T[]): { added: T[]; removed: T[] } {
  const b = new Set(before);
  const a = new Set(after);
  return {
    added: after.filter((x) => !b.has(x)),
    removed: before.filter((x) => !a.has(x)),
  };
}

type RequestIpProvider = {
  requestIP: (req: Request) => { address?: string } | null | undefined;
};

export async function handlePermissionGroupsRoutes(
  req: Request,
  url: URL,
  server: RequestIpProvider,
): Promise<Response | null> {
  if (req.method === "GET" && url.pathname === "/api/permissions") {
    const user = await authenticateRequest(req);
    try {
      requirePermission(user, "users:manage");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }
    return Response.json({
      permissions: KNOWN_PERMISSIONS.map((p) => ({
        id: p,
        description: getPermissionDescription(p),
      })),
    });
  }

  if (req.method === "GET" && url.pathname === "/api/permission-groups") {
    const user = await authenticateRequest(req);
    try {
      requirePermission(user, "users:manage");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }
    return Response.json({ groups: listPermissionGroups() });
  }

  if (req.method === "POST" && url.pathname === "/api/permission-groups") {
    const user = await authenticateRequest(req);
    let authed;
    try {
      authed = requirePermission(user, "users:manage");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }
    let body: any;
    try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
    const name = typeof body?.name === "string" ? body.name : "";
    const description = typeof body?.description === "string" ? body.description : null;
    const permissions = sanitizePermissions(body?.permissions);

    const result = createPermissionGroup(name, description, permissions, authed.userId);
    if (!result.success) return Response.json({ error: result.error }, { status: 400 });

    logAudit({
      timestamp: Date.now(),
      username: authed.username,
      ip: server.requestIP(req)?.address || "unknown",
      action: AuditAction.PERMISSION_GROUP_CREATE,
      details: JSON.stringify({
        groupId: result.group!.id,
        name: result.group!.name,
        description: result.group!.description,
        permissions: result.group!.permissions,
      }),
      success: true,
    });

    return Response.json({ group: result.group });
  }

  const singleGroupMatch = url.pathname.match(/^\/api\/permission-groups\/(\d+)$/);
  if (singleGroupMatch) {
    const groupId = Number(singleGroupMatch[1]);
    const user = await authenticateRequest(req);
    let authed;
    try {
      authed = requirePermission(user, "users:manage");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    if (req.method === "GET") {
      const group = getPermissionGroup(groupId);
      if (!group) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json({ group });
    }

    if (req.method === "PATCH" || req.method === "PUT") {
      let body: any;
      try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
      const before = getPermissionGroup(groupId);
      if (!before) return Response.json({ error: "Not found" }, { status: 404 });

      const updates: Parameters<typeof updatePermissionGroup>[1] = {};
      if (body?.name !== undefined) updates.name = String(body.name);
      if (body?.description !== undefined) updates.description = body.description === null ? null : String(body.description);
      if (body?.permissions !== undefined) updates.permissions = sanitizePermissions(body.permissions);
      const result = updatePermissionGroup(groupId, updates);
      if (!result.success) return Response.json({ error: result.error }, { status: 400 });

      const after = result.group!;
      const permsDiff = diffArrays(before.permissions, after.permissions);
      const auditDetails: Record<string, unknown> = {
        groupId,
        name: after.name,
      };
      if (before.name !== after.name) auditDetails.nameChanged = { from: before.name, to: after.name };
      if (before.description !== after.description) {
        auditDetails.descriptionChanged = { from: before.description, to: after.description };
      }
      if (permsDiff.added.length || permsDiff.removed.length) {
        auditDetails.permissionsAdded = permsDiff.added;
        auditDetails.permissionsRemoved = permsDiff.removed;
      }

      logAudit({
        timestamp: Date.now(),
        username: authed.username,
        ip: server.requestIP(req)?.address || "unknown",
        action: AuditAction.PERMISSION_GROUP_UPDATE,
        details: JSON.stringify(auditDetails),
        success: true,
      });
      return Response.json({ group: result.group });
    }

    if (req.method === "DELETE") {
      const existing = getPermissionGroup(groupId);
      const result = deletePermissionGroup(groupId);
      if (!result.success) return Response.json({ error: result.error }, { status: 404 });

      logAudit({
        timestamp: Date.now(),
        username: authed.username,
        ip: server.requestIP(req)?.address || "unknown",
        action: AuditAction.PERMISSION_GROUP_DELETE,
        details: JSON.stringify({
          groupId,
          name: existing?.name ?? null,
          permissions: existing?.permissions ?? [],
        }),
        success: true,
      });
      return Response.json({ ok: true });
    }
  }

  const userGroupsMatch = url.pathname.match(/^\/api\/users\/(\d+)\/permission-groups$/);
  if (userGroupsMatch) {
    const targetUserId = Number(userGroupsMatch[1]);
    const user = await authenticateRequest(req);
    let authed;
    try {
      authed = requirePermission(user, "users:manage");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    if (!getUserById(targetUserId)) {
      return Response.json({ error: "User not found" }, { status: 404 });
    }

    if (req.method === "GET") {
      return Response.json({ groupIds: getUserGroupIds(targetUserId) });
    }

    if (req.method === "PUT") {
      let body: any;
      try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
      const ids = Array.isArray(body?.groupIds)
        ? body.groupIds.map((g: any) => Number(g)).filter((g: number) => Number.isFinite(g))
        : [];
      const targetUser = getUserById(targetUserId);
      const before = getUserGroupIds(targetUserId);
      const result = setUserGroups(targetUserId, ids);
      if (!result.success) return Response.json({ error: result.error }, { status: 400 });

      const groupDiff = diffArrays(before, ids);
      logAudit({
        timestamp: Date.now(),
        username: authed.username,
        ip: server.requestIP(req)?.address || "unknown",
        action: AuditAction.USER_GROUPS_CHANGE,
        details: JSON.stringify({
          targetUserId,
          targetUsername: targetUser?.username,
          groupsAdded: groupDiff.added,
          groupsRemoved: groupDiff.removed,
          groupsAfter: ids,
        }),
        success: true,
      });
      return Response.json({ ok: true, groupIds: ids });
    }
  }

  const userExtrasMatch = url.pathname.match(/^\/api\/users\/(\d+)\/extra-permissions$/);
  if (userExtrasMatch) {
    const targetUserId = Number(userExtrasMatch[1]);
    const user = await authenticateRequest(req);
    let authed;
    try {
      authed = requirePermission(user, "users:manage");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    if (!getUserById(targetUserId)) {
      return Response.json({ error: "User not found" }, { status: 404 });
    }

    if (req.method === "GET") {
      return Response.json({ permissions: Array.from(getUserExtraPermissions(targetUserId)).sort() });
    }

    if (req.method === "PUT") {
      let body: any;
      try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
      const perms = sanitizePermissions(body?.permissions);
      const targetUser = getUserById(targetUserId);
      const before = Array.from(getUserExtraPermissions(targetUserId));
      const result = setUserExtraPermissions(targetUserId, perms);
      if (!result.success) return Response.json({ error: result.error }, { status: 400 });

      const permsDiff = diffArrays(before, perms);
      logAudit({
        timestamp: Date.now(),
        username: authed.username,
        ip: server.requestIP(req)?.address || "unknown",
        action: AuditAction.USER_EXTRA_PERMISSIONS_CHANGE,
        details: JSON.stringify({
          targetUserId,
          targetUsername: targetUser?.username,
          permissionsAdded: permsDiff.added,
          permissionsRemoved: permsDiff.removed,
          permissionsAfter: perms,
        }),
        success: true,
      });
      return Response.json({ ok: true, permissions: perms });
    }
  }

  return null;
}
