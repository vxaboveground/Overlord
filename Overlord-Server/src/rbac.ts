import { type AuthenticatedUser } from "./auth";
import { hasPermission, type UserRole } from "./users";

export type Permission =
  | "users:manage"
  | "clients:control"
  | "clients:view"
  | "clients:build"
  | "clients:enroll"
  | "audit:view"
  | "chat:write";

export function checkPermission(
  user: AuthenticatedUser | null,
  permission: Permission,
): boolean {
  if (!user) return false;
  return hasPermission(user.role, permission, user.userId);
}

export function checkAnyPermission(
  user: AuthenticatedUser | null,
  permissions: Permission[],
): boolean {
  if (!user) return false;
  return permissions.some((p) => hasPermission(user.role, p, user.userId));
}

export function checkAllPermissions(
  user: AuthenticatedUser | null,
  permissions: Permission[],
): boolean {
  if (!user) return false;
  return permissions.every((p) => hasPermission(user.role, p, user.userId));
}

export function requireAuth(user: AuthenticatedUser | null): AuthenticatedUser {
  if (!user) {
    throw new Response("Unauthorized", { status: 401 });
  }
  return user;
}

export function requirePermission(
  user: AuthenticatedUser | null,
  permission: Permission,
): AuthenticatedUser {
  const authedUser = requireAuth(user);

  if (!checkPermission(authedUser, permission)) {
    throw new Response("Forbidden: Insufficient permissions", { status: 403 });
  }

  return authedUser;
}

export function requireAnyPermission(
  user: AuthenticatedUser | null,
  permissions: Permission[],
): AuthenticatedUser {
  const authedUser = requireAuth(user);

  if (!checkAnyPermission(authedUser, permissions)) {
    throw new Response("Forbidden: Insufficient permissions", { status: 403 });
  }

  return authedUser;
}

export function getPermissionDescription(permission: Permission): string {
  switch (permission) {
    case "users:manage":
      return "Manage users and roles";
    case "clients:control":
      return "Control clients (execute commands, desktop, console, files)";
    case "clients:view":
      return "View connected clients";
    case "clients:build":
      return "Build client binaries";
    case "clients:enroll":
      return "Manage client enrollment approvals";
    case "audit:view":
      return "View audit logs";
    case "chat:write":
      return "Send messages in team chat";
    default:
      return "Unknown permission";
  }
}

export function getRoleDescription(role: UserRole): string {
  switch (role) {
    case "admin":
      return "Full access - can manage users and control all clients";
    case "operator":
      return "Can control clients but cannot manage users";
    case "viewer":
      return "Read-only access to view clients";
    default:
      return "Unknown role";
  }
}

export function getRolePermissions(role: UserRole): Permission[] {
  const permissions: Permission[] = [];

  if (hasPermission(role, "users:manage")) permissions.push("users:manage");
  if (hasPermission(role, "clients:control"))
    permissions.push("clients:control");
  if (hasPermission(role, "clients:view")) permissions.push("clients:view");
  if (hasPermission(role, "clients:build")) permissions.push("clients:build");
  if (hasPermission(role, "clients:enroll")) permissions.push("clients:enroll");
  if (hasPermission(role, "audit:view")) permissions.push("audit:view");

  return permissions;
}
