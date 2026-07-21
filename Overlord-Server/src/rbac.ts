import { type AuthenticatedUser } from "./auth";
import {
  canBuildClients,
  canChatWrite,
  canUploadFiles,
  canUserAccessClient,
  canUserAccessFeature,
  canUserAccessPlugin,
  getUserExtraPermissions,
  getUserGrantedPermissions,
  getUserGroupIds,
  listPermissionGroups,
  type FeatureName,
  type UserRole,
} from "./users";

type PermissionDef = {
  description: string;
  roles: readonly UserRole[];
  userOverride?: (userId: number, role: UserRole) => boolean;
  overrideSourceLabel?: string;
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
    overrideSourceLabel: "Build permission toggle",
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
    overrideSourceLabel: "Chat write permission toggle",
  },
  "files:upload": {
    description: "Upload shared files and build artifacts",
    roles: ["admin"],
    userOverride: canUploadFiles,
    overrideSourceLabel: "File upload permission toggle",
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
    description: "Legacy full server settings access (grants all system:* settings permissions)",
    roles: ["admin"],
  },
  "system:security": {
    description: "Change security policy settings",
    roles: ["admin"],
  },
  "system:tls": {
    description: "Change TLS and certificate settings",
    roles: ["admin"],
  },
  "system:oidc": {
    description: "Change OIDC and SSO login settings",
    roles: ["admin"],
  },
  "system:registration": {
    description: "Change user registration policy settings",
    roles: ["admin"],
  },
  "system:notifications": {
    description: "Change global notification delivery settings",
    roles: ["admin"],
  },
  "system:chat": {
    description: "Change team chat settings",
    roles: ["admin"],
  },
  "system:appearance": {
    description: "Change custom CSS and appearance settings",
    roles: ["admin"],
  },
  "system:thumbnails": {
    description: "Change screenshot thumbnail settings",
    roles: ["admin"],
  },
  "system:input-archive": {
    description: "Change input log archive settings",
    roles: ["admin"],
  },
  "system:build-limits": {
    description: "Change build rate limit settings",
    roles: ["admin"],
  },
  "system:export-import": {
    description: "Export and import server settings",
    roles: ["admin"],
  },
  "system:health": {
    description: "View server health diagnostics",
    roles: ["admin"],
  },
  "system:health:manage": {
    description: "Run server health maintenance actions",
    roles: ["admin"],
  },
  "system:profiler": {
    description: "Run server CPU and memory profiler captures",
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
  if (userId !== undefined) {
    const granted = getUserGrantedPermissions(userId);
    if (granted.has(permission)) return true;
    if (
      typeof permission === "string" &&
      permission.startsWith("system:") &&
      permission !== "system:configure" &&
      granted.has("system:configure")
    ) {
      return true;
    }
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
    throw new Response(`Forbidden: missing permission ${permission}`, { status: 403 });
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

export type EffectivePermissionSource =
  | { type: "role"; label: string; role: UserRole }
  | { type: "group"; label: string; groupId: number }
  | { type: "extra"; label: string }
  | { type: "system-configure"; label: string };

export type EffectivePermissionDetail = {
  id: Permission;
  description: string;
  allowed: boolean;
  sources: EffectivePermissionSource[];
};

export function getUserEffectivePermissionDetails(
  userId: number,
  role: UserRole,
): EffectivePermissionDetail[] {
  const assignedGroupIds = new Set(getUserGroupIds(userId));
  const groups = listPermissionGroups().filter((group) => assignedGroupIds.has(group.id));
  const extras = getUserExtraPermissions(userId);

  return listAllPermissions().map((permission) => {
    const def = lookupPermission(permission);
    const sources: EffectivePermissionSource[] = [];

    if (def) {
      const roleGrants = def.userOverride
        ? def.userOverride(userId, role)
        : def.roles.includes(role);
      if (roleGrants) {
        sources.push({
          type: "role",
          label: def.overrideSourceLabel || `${role} role`,
          role,
        });
      }
    }

    for (const group of groups) {
      if (group.permissions.includes(permission)) {
        sources.push({
          type: "group",
          label: group.name,
          groupId: group.id,
        });
      }
    }

    if (extras.has(permission)) {
      sources.push({
        type: "extra",
        label: "Direct extra permission",
      });
    }

    if (
      sources.length === 0 &&
      permission.startsWith("system:") &&
      permission !== "system:configure"
    ) {
      const configureGroup = groups.find((group) => group.permissions.includes("system:configure"));
      if (configureGroup) {
        sources.push({
          type: "system-configure",
          label: `Via ${configureGroup.name} → system:configure`,
        });
      } else if (extras.has("system:configure")) {
        sources.push({
          type: "system-configure",
          label: "Via direct system:configure",
        });
      }
    }

    return {
      id: permission,
      description: getPermissionDescription(permission),
      allowed: hasPermission(role, permission, userId),
      sources,
    };
  });
}
