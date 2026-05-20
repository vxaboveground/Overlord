import { type AuthenticatedUser } from "./auth";
import {
  canBuildClients,
  canChatWrite,
  canUserAccessClient,
  canUserAccessFeature,
  canUserAccessPlugin,
  getUserGrantedPermissions,
  type FeatureName,
  type UserRole,
} from "./users";

type PermissionDef = {
  description: string;
  roles: readonly UserRole[];
  userOverride?: (userId: number, role: UserRole) => boolean;
};

const PERMISSIONS = {
  "users:manage": {
    description: "Manage users and roles",
    roles: ["admin"],
  },
  "clients:control": {
    description: "Control clients (execute commands, desktop, console, files)",
    roles: ["admin", "operator"],
  },
  "clients:build": {
    description: "Build client binaries",
    roles: ["admin", "operator"],
    userOverride: canBuildClients,
  },
  "clients:enroll": {
    description: "Manage client enrollment approvals",
    roles: ["admin", "operator"],
  },
  "clients:silent-exec": {
    description: "Silently execute arbitrary commands on clients",
    roles: ["admin"],
  },
  "clients:disconnect": {
    description: "Force a client to disconnect",
    roles: ["admin", "operator"],
  },
  "clients:reconnect": {
    description: "Force a client to drop its session and reconnect",
    roles: ["admin", "operator"],
  },
  "clients:metadata": {
    description: "Edit client metadata (nickname, tag, group, bookmark, mute)",
    roles: ["admin", "operator"],
  },
  "clients:uninstall": {
    description: "Uninstall the agent on a client (removes persistence and deletes from dashboard)",
    roles: ["admin", "operator"],
  },
  "audit:view": {
    description: "View audit logs",
    roles: ["admin", "operator"],
  },
  "chat:write": {
    description: "Send messages in team chat",
    roles: ["admin", "operator"],
    userOverride: canChatWrite,
  },
  "scripts:manage": {
    description: "Manage auto-run scripts",
    roles: ["admin"],
  },
  "deploys:manage": {
    description: "Manage deploys and auto-deploys",
    roles: ["admin"],
  },
  "plugins:manage": {
    description: "Upload, enable, and delete plugins",
    roles: ["admin", "operator"],
  },
  "plugins:configure": {
    description: "Configure plugin trust, auto-load, and direct execution",
    roles: ["admin"],
  },
  "network:manage-bans": {
    description: "Manage IP bans",
    roles: ["admin"],
  },
  "system:configure": {
    description: "Change server-level settings (TLS, security, registration, notifications, appearance, etc.)",
    roles: ["admin"],
  },
  "clients:elevate": {
    description: "Elevate agent privileges (UAC on Windows, sudo on macOS)",
    roles: ["admin"],
  },
  "clients:winre": {
    description: "Install or uninstall WinRE persistence on clients",
    roles: ["admin"],
  },
} as const satisfies Record<string, PermissionDef>;

export type Permission = keyof typeof PERMISSIONS;

export function listAllPermissions(): Permission[] {
  return Object.keys(PERMISSIONS) as Permission[];
}

function lookupPermission(permission: string): PermissionDef | undefined {
  return (PERMISSIONS as Record<string, PermissionDef>)[permission];
}

export function hasPermission(
  role: UserRole,
  permission: Permission | string,
  userId?: number,
): boolean {
  const def = lookupPermission(permission);
  if (!def) return false;
  // The legacy role-level gate. Per-permission userOverride (canBuild,
  // canChatWrite) is authoritative when present + userId is known — it can
  // both grant AND deny relative to the role default (an operator with
  // can_build=0 loses clients:build at the role layer). Without a userOverride,
  // membership in def.roles decides.
  let grantedByRole: boolean;
  if (def.userOverride && userId !== undefined) {
    grantedByRole = def.userOverride(userId, role);
  } else {
    grantedByRole = def.roles.includes(role);
  }
  if (grantedByRole) return true;
  // Permission groups + per-user extras are *additive only*: they can grant a
  // permission the role doesn't have, but they cannot revoke one the role does.
  if (userId !== undefined && getUserGrantedPermissions(userId).has(permission)) {
    return true;
  }
  return false;
}

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

export function getPermissionDescription(permission: Permission | string): string {
  return lookupPermission(permission)?.description ?? "Unknown permission";
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

export function requireClientAccess(
  user: AuthenticatedUser | null,
  clientId: string,
): AuthenticatedUser {
  const authed = requireAuth(user);
  if (!canUserAccessClient(authed.userId, authed.role, clientId)) {
    throw new Response("Forbidden: You do not have access to this client", { status: 403 });
  }
  return authed;
}

export function requirePluginAccess(
  user: AuthenticatedUser | null,
  pluginId: string,
): AuthenticatedUser {
  const authed = requireAuth(user);
  if (!canUserAccessPlugin(authed.userId, authed.role, pluginId)) {
    throw new Response("Forbidden: You do not have access to this plugin", { status: 403 });
  }
  return authed;
}

export function requireFeatureAccess(
  user: AuthenticatedUser | null,
  feature: FeatureName,
): AuthenticatedUser {
  const authed = requireAuth(user);
  if (!canUserAccessFeature(authed.userId, authed.role, feature)) {
    throw new Response("Forbidden: feature access denied", { status: 403 });
  }
  return authed;
}

export function getRolePermissions(role: UserRole): Permission[] {
  const result: Permission[] = [];
  for (const perm of Object.keys(PERMISSIONS) as Permission[]) {
    const def = lookupPermission(perm);
    if (def && def.roles.includes(role)) result.push(perm);
  }
  return result;
}

export function getUserPermissions(userId: number, role: UserRole): Permission[] {
  const result: Permission[] = [];
  for (const perm of Object.keys(PERMISSIONS) as Permission[]) {
    if (hasPermission(role, perm, userId)) result.push(perm);
  }
  return result;
}
