import { generateToken, authenticateRequest, getSessionTtlSeconds } from "../../auth";
import { AuditAction, logAudit } from "../../auditLog";
import { logger } from "../../logger";
import { requirePermission } from "../../rbac";
import {
  listUserSessions,
  persistRevokedTokenHash,
  revokeAllUserSessions,
} from "../../db";
import {
  type ClientAccessRuleKind,
  type ClientAccessScope,
  type FeatureName,
  ALL_FEATURES,
  createUser,
  deleteUser,
  getUserById,
  getUserClientAccessScope,
  getUserFeaturePermissions,
  listUsers,
  listUserClientAccessRules,
  removeUserClientAccessRule,
  setUserClientAccessRule,
  setUserClientAccessScope,
  setUserCanBuild,
  setUserCanUploadFiles,
  setUserFeaturePermissions,
  resetUserFeaturePermissions,
  updateUserPassword,
  updateUserRole,
} from "../../users";
import { makeAuthCookie } from "./auth-cookie";

type RequestIpProvider = {
  requestIP: (req: Request) => { address?: string } | null | undefined;
};

export async function handleUsersRoutes(
  req: Request,
  url: URL,
  server: RequestIpProvider,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/users")) {
    return null;
  }

  try {
    const user = await authenticateRequest(req);

    if (req.method === "GET" && url.pathname === "/api/users") {
      requirePermission(user, "users:manage");
      const users = listUsers();
      return Response.json({ users });
    }

    if (req.method === "POST" && url.pathname === "/api/users") {
      const authedUser = requirePermission(user, "users:manage");
      const body = await req.json();
      const { username, password, role } = body;

      if (!username || !password || !role) {
        return Response.json({ error: "Missing required fields" }, { status: 400 });
      }

      if (!["admin", "operator", "viewer"].includes(role)) {
        return Response.json({ error: "Invalid role" }, { status: 400 });
      }

      const result = await createUser(username, password, role, authedUser.username);

      if (result.success) {
        const ip = server.requestIP(req)?.address || "unknown";
        logAudit({
          timestamp: Date.now(),
          username: authedUser.username,
          ip,
          action: AuditAction.COMMAND,
          details: `Created user: ${username} (${role})`,
          success: true,
        });

        return Response.json({ success: true, userId: result.userId });
      }
      return Response.json({ error: result.error }, { status: 400 });
    }

    if (req.method === "PUT" && url.pathname.match(/^\/api\/users\/\d+\/password$/)) {
      if (!user) {
        return Response.json({ error: "Not authenticated" }, { status: 401 });
      }
      const userId = parseInt(url.pathname.split("/")[3]);
      const body = await req.json();
      const { password, newPassword, currentPassword } = body;

      const canChange = user.userId === userId || user.role === "admin";

      if (!canChange) {
        return Response.json({ error: "Permission denied" }, { status: 403 });
      }

      if (user.userId === userId) {
        const targetUser = getUserById(userId);
        if (!targetUser) {
          return Response.json({ error: "User not found" }, { status: 404 });
        }

        if (typeof currentPassword !== "string" || currentPassword.length === 0) {
          return Response.json(
            { error: "Current password is required" },
            { status: 400 },
          );
        }

        const isValid = await Bun.password.verify(
          currentPassword,
          targetUser.password_hash,
        );
        if (!isValid) {
          return Response.json(
            { error: "Current password is incorrect" },
            { status: 400 },
          );
        }
      }

      const finalPassword = newPassword || password;
      if (!finalPassword) {
        return Response.json({ error: "Password required" }, { status: 400 });
      }

      const result = await updateUserPassword(userId, finalPassword);

      if (result.success) {
        const targetUser = getUserById(userId);

        const existingSessions = listUserSessions(userId).filter((s) => !s.revoked);
        for (const s of existingSessions) {
          persistRevokedTokenHash(s.tokenHash, s.expiresAt);
        }
        revokeAllUserSessions(userId);

        const ip = server.requestIP(req)?.address || "unknown";
        logAudit({
          timestamp: Date.now(),
          username: user.username,
          ip,
          action: AuditAction.COMMAND,
          details: `Updated password for user: ${targetUser?.username}`,
          success: true,
        });

        if (user.userId === userId && targetUser) {
          const userAgent = req.headers.get("User-Agent") || undefined;
          const newToken = await generateToken(targetUser, { ip, userAgent });
          const sessionTtlSeconds = getSessionTtlSeconds();
          return new Response(
            JSON.stringify({
              success: true,
              token: newToken,
            }),
            {
              headers: {
                "Content-Type": "application/json",
                "Set-Cookie": makeAuthCookie(newToken, sessionTtlSeconds, req),
              },
            },
          );
        }

        return Response.json({ success: true });
      }
      return Response.json({ error: result.error }, { status: 400 });
    }

    if (req.method === "PUT" && url.pathname.match(/^\/api\/users\/\d+\/role$/)) {
      const authedUser = requirePermission(user, "users:manage");
      const userId = parseInt(url.pathname.split("/")[3]);
      const body = await req.json();
      const { role } = body;

      if (!role || !["admin", "operator", "viewer"].includes(role)) {
        return Response.json({ error: "Invalid role" }, { status: 400 });
      }

      if (userId === authedUser.userId) {
        return Response.json({ error: "Cannot change your own role" }, { status: 400 });
      }

      const result = updateUserRole(userId, role);

      if (result.success) {
        const targetUser = getUserById(userId);

        const existingSessions = listUserSessions(userId).filter((s) => !s.revoked);
        for (const s of existingSessions) {
          persistRevokedTokenHash(s.tokenHash, s.expiresAt);
        }
        revokeAllUserSessions(userId);

        const ip = server.requestIP(req)?.address || "unknown";
        logAudit({
          timestamp: Date.now(),
          username: authedUser.username,
          ip,
          action: AuditAction.COMMAND,
          details: `Updated role for user: ${targetUser?.username} to ${role}`,
          success: true,
        });

        return Response.json({ success: true });
      }
      return Response.json({ error: result.error }, { status: 400 });
    }

    if (req.method === "GET" && url.pathname.match(/^\/api\/users\/\d+\/client-access$/)) {
      const authedUser = requirePermission(user, "users:manage");
      const userId = parseInt(url.pathname.split("/")[3]);
      const targetUser = getUserById(userId);
      if (!targetUser) {
        return Response.json({ error: "User not found" }, { status: 404 });
      }

      const scope = getUserClientAccessScope(userId);
      const rules = listUserClientAccessRules(userId);

      const ip = server.requestIP(req)?.address || "unknown";
      logAudit({
        timestamp: Date.now(),
        username: authedUser.username,
        ip,
        action: AuditAction.COMMAND,
        details: `Viewed client access policy for user: ${targetUser.username}`,
        success: true,
      });

      return Response.json({ scope, rules });
    }

    if (req.method === "PUT" && url.pathname.match(/^\/api\/users\/\d+\/client-access$/)) {
      const authedUser = requirePermission(user, "users:manage");
      const userId = parseInt(url.pathname.split("/")[3]);
      const targetUser = getUserById(userId);
      if (!targetUser) {
        return Response.json({ error: "User not found" }, { status: 404 });
      }

      const body = await req.json();
      const scope = body?.scope as ClientAccessScope;
      const result = setUserClientAccessScope(userId, scope);
      if (!result.success) {
        return Response.json({ error: result.error }, { status: 400 });
      }

      const ip = server.requestIP(req)?.address || "unknown";
      logAudit({
        timestamp: Date.now(),
        username: authedUser.username,
        ip,
        action: AuditAction.COMMAND,
        details: `Updated client access scope for ${targetUser.username} to ${scope}`,
        success: true,
      });

      return Response.json({ success: true, scope });
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/users\/\d+\/client-access\/rules$/)) {
      const authedUser = requirePermission(user, "users:manage");
      const userId = parseInt(url.pathname.split("/")[3]);
      const targetUser = getUserById(userId);
      if (!targetUser) {
        return Response.json({ error: "User not found" }, { status: 404 });
      }

      const body = await req.json();
      const clientId = String(body?.clientId || "").trim();
      const access = body?.access as ClientAccessRuleKind;
      const result = setUserClientAccessRule(userId, clientId, access);
      if (!result.success) {
        return Response.json({ error: result.error }, { status: 400 });
      }

      if (access === "allow") {
        const currentScope = getUserClientAccessScope(userId);
        if (currentScope === "none") {
          setUserClientAccessScope(userId, "allowlist");
        }
      }

      const ip = server.requestIP(req)?.address || "unknown";
      logAudit({
        timestamp: Date.now(),
        username: authedUser.username,
        ip,
        action: AuditAction.COMMAND,
        details: `Set client access rule for ${targetUser.username}: ${access} ${clientId}`,
        success: true,
      });

      return Response.json({ success: true });
    }

    if (req.method === "DELETE" && url.pathname.match(/^\/api\/users\/\d+\/client-access\/rules$/)) {
      const authedUser = requirePermission(user, "users:manage");
      const userId = parseInt(url.pathname.split("/")[3]);
      const targetUser = getUserById(userId);
      if (!targetUser) {
        return Response.json({ error: "User not found" }, { status: 404 });
      }

      const clientId = String(url.searchParams.get("clientId") || "").trim();
      if (!clientId) {
        return Response.json({ error: "clientId is required" }, { status: 400 });
      }

      const result = removeUserClientAccessRule(userId, clientId);
      if (!result.success) {
        return Response.json({ error: result.error }, { status: 400 });
      }

      const ip = server.requestIP(req)?.address || "unknown";
      logAudit({
        timestamp: Date.now(),
        username: authedUser.username,
        ip,
        action: AuditAction.COMMAND,
        details: `Removed client access rule for ${targetUser.username}: ${clientId}`,
        success: true,
      });

      return Response.json({ success: true });
    }

    if (req.method === "DELETE" && url.pathname.match(/^\/api\/users\/\d+$/)) {
      const authedUser = requirePermission(user, "users:manage");
      const userId = parseInt(url.pathname.split("/")[3]);

      if (userId === authedUser.userId) {
        return Response.json(
          { error: "Cannot delete your own account" },
          { status: 400 },
        );
      }

      const targetUser = getUserById(userId);
      const result = deleteUser(userId);

      if (result.success) {
        const ip = server.requestIP(req)?.address || "unknown";
        logAudit({
          timestamp: Date.now(),
          username: authedUser.username,
          ip,
          action: AuditAction.COMMAND,
          details: `Deleted user: ${targetUser?.username}`,
          success: true,
        });

        return Response.json({ success: true });
      }
      return Response.json({ error: result.error }, { status: 400 });
    }

    if (req.method === "PUT" && url.pathname.match(/^\/api\/users\/\d+\/can-build$/)) {
      const authedUser = requirePermission(user, "users:manage");
      const userId = parseInt(url.pathname.split("/")[3]);
      const targetUser = getUserById(userId);
      if (!targetUser) {
        return Response.json({ error: "User not found" }, { status: 404 });
      }

      const body = await req.json();
      const canBuild = !!body?.canBuild;
      const result = setUserCanBuild(userId, canBuild);
      if (!result.success) {
        return Response.json({ error: result.error }, { status: 400 });
      }

      const ip = server.requestIP(req)?.address || "unknown";
      logAudit({
        timestamp: Date.now(),
        username: authedUser.username,
        ip,
        action: AuditAction.COMMAND,
        details: `${canBuild ? "Granted" : "Revoked"} build permission for ${targetUser.username}`,
        success: true,
      });

      return Response.json({ success: true, canBuild });
    }

    if (req.method === "PUT" && url.pathname.match(/^\/api\/users\/\d+\/can-upload-files$/)) {
      const authedUser = requirePermission(user, "users:manage");
      const userId = parseInt(url.pathname.split("/")[3]);
      const targetUser = getUserById(userId);
      if (!targetUser) {
        return Response.json({ error: "User not found" }, { status: 404 });
      }

      const body = await req.json();
      const canUploadFiles = !!body?.canUploadFiles;
      const result = setUserCanUploadFiles(userId, canUploadFiles);
      if (!result.success) {
        return Response.json({ error: result.error }, { status: 400 });
      }

      const ip = server.requestIP(req)?.address || "unknown";
      logAudit({
        timestamp: Date.now(),
        username: authedUser.username,
        ip,
        action: AuditAction.COMMAND,
        details: `${canUploadFiles ? "Granted" : "Revoked"} file upload permission for ${targetUser.username}`,
        success: true,
      });

      return Response.json({ success: true, canUploadFiles });
    }

    if (req.method === "GET" && url.pathname.match(/^\/api\/users\/\d+\/feature-permissions$/)) {
      requirePermission(user, "users:manage");
      const userId = parseInt(url.pathname.split("/")[3]);
      const targetUser = getUserById(userId);
      if (!targetUser) {
        return Response.json({ error: "User not found" }, { status: 404 });
      }

      const permissions = getUserFeaturePermissions(userId);
      return Response.json({ success: true, permissions, features: ALL_FEATURES });
    }

    if (req.method === "PUT" && url.pathname.match(/^\/api\/users\/\d+\/feature-permissions$/)) {
      const authedUser = requirePermission(user, "users:manage");
      const userId = parseInt(url.pathname.split("/")[3]);
      const targetUser = getUserById(userId);
      if (!targetUser) {
        return Response.json({ error: "User not found" }, { status: 404 });
      }

      const body = await req.json();
      const permissions = body?.permissions;
      if (!permissions || typeof permissions !== "object") {
        return Response.json({ error: "Invalid permissions object" }, { status: 400 });
      }

      const validated: Partial<Record<FeatureName, boolean>> = {};
      for (const [key, value] of Object.entries(permissions)) {
        if (ALL_FEATURES.includes(key as FeatureName)) {
          validated[key as FeatureName] = !!value;
        }
      }

      const result = setUserFeaturePermissions(userId, validated);
      if (!result.success) {
        return Response.json({ error: result.error }, { status: 400 });
      }

      const ip = server.requestIP(req)?.address || "unknown";
      logAudit({
        timestamp: Date.now(),
        username: authedUser.username,
        ip,
        action: AuditAction.COMMAND,
        details: `Updated feature permissions for ${targetUser.username}: ${JSON.stringify(validated)}`,
        success: true,
      });

      return Response.json({ success: true, permissions: getUserFeaturePermissions(userId) });
    }

    if (req.method === "DELETE" && url.pathname.match(/^\/api\/users\/\d+\/feature-permissions$/)) {
      const authedUser = requirePermission(user, "users:manage");
      const userId = parseInt(url.pathname.split("/")[3]);
      const targetUser = getUserById(userId);
      if (!targetUser) {
        return Response.json({ error: "User not found" }, { status: 404 });
      }

      const result = resetUserFeaturePermissions(userId);
      if (!result.success) {
        return Response.json({ error: result.error }, { status: 400 });
      }

      const ip = server.requestIP(req)?.address || "unknown";
      logAudit({
        timestamp: Date.now(),
        username: authedUser.username,
        ip,
        action: AuditAction.COMMAND,
        details: `Reset feature permissions for ${targetUser.username} to defaults`,
        success: true,
      });

      return Response.json({ success: true });
    }

    return new Response("Not found", { status: 404 });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    logger.error("[users] API error:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
