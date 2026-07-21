import { logger } from "./logger";
import { db } from "./db/connection";
import { initializeUserSchema } from "./db/user-schema";
import { getConfig } from "./config";

export type UserRole = "admin" | "operator" | "viewer";
export type ClientAccessScope = "none" | "allowlist" | "denylist" | "all";
export type ClientAccessRuleKind = "allow" | "deny";
export type PluginAccessScope = "none" | "allowlist" | "all";

export interface User {
  id: number;
  username: string;
  password_hash: string;
  role: UserRole;
  created_at: number;
  last_login: number | null;
  onboarding_completed_at: number | null;
  created_by: string | null;
  must_change_password: number;
  client_scope: ClientAccessScope;
  plugin_scope: PluginAccessScope;
  can_build: number;
  can_upload_files: number;
  telegram_chat_id: string | null;
  mfa_secret: string | null;
  mfa_enabled: number;
  mfa_enabled_at: number | null;
  keylog_archive_enabled: number;
}

export interface UserInfo {
  id: number;
  username: string;
  role: UserRole;
  created_at: number;
  last_login: number | null;
  created_by: string | null;
  client_scope: ClientAccessScope;
  plugin_scope: PluginAccessScope;
  can_build: number;
  can_upload_files: number;
  telegram_chat_id: string | null;
  mfa_enabled: number;
  mfa_enabled_at: number | null;
  keylog_archive_enabled?: number;
}

export interface UserClientAccessRule {
  userId: number;
  clientId: string;
  access: ClientAccessRuleKind;
}

export interface UserPluginAccessRule {
  userId: number;
  pluginId: string;
}

type UserAccessCacheEntry = {
  scope: ClientAccessScope;
  allow: Set<string>;
  deny: Set<string>;
};

const userAccessCache = new Map<number, UserAccessCacheEntry>();
let notificationDeliveryCache: UserDeliveryRow[] | null = null;

type AccessCheck<E extends any[]> = (userId: number, role: UserRole, ...extra: E) => boolean;

function withAdminBypass<E extends any[]>(check: AccessCheck<E>): AccessCheck<E> {
  return (userId, role, ...extra) => {
    if (role === "admin") return true;
    return check(userId, role, ...extra);
  };
}

initializeUserSchema();

const userCount = db.prepare("SELECT COUNT(*) as count FROM users").get() as {
  count: number;
};
if (userCount.count === 0) {
  const config = getConfig();
  const initialUsername = (config.auth.username || "admin").trim() || "admin";
  const initialPassword = config.auth.password;
  const mustChangePassword = config.auth.passwordIsUserSupplied ? 0 : 1;

  logger.info("[users] No users found, creating default admin account");
  const defaultPassword = await Bun.password.hash(initialPassword, {
    algorithm: "bcrypt",
    cost: 10,
  });

  db.prepare(
    "INSERT INTO users (username, password_hash, role, created_at, created_by, must_change_password, client_scope, plugin_scope, can_build, can_upload_files) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(initialUsername, defaultPassword, "admin", Date.now(), "system", mustChangePassword, "all", "all", 1, 1);

  const createdUser = db
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(initialUsername) as User | undefined;
  logger.info(
    "[users] Default admin created with must_change_password =",
    createdUser?.must_change_password,
  );

  logger.info(`[users] Initial admin account created (username: ${initialUsername})`);
  if (mustChangePassword) {
    logger.warn(
      "[users] SECURITY WARNING: A default admin account has been created with the fallback password. Sign in and rotate the password immediately. Bootstrap credentials default to admin/admin unless overridden by configuration; the password is not logged.",
    );
  } else {
    logger.info(
      "[users] Initial admin account uses the operator-supplied password; first-login rotation is not required.",
    );
  }
}

export function getUserById(id: number): User | null {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as
    | User
    | undefined;
  return user || null;
}

export function getUserByUsername(username: string): User | null {
  const user = db
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(username) as User | undefined;
  return user || null;
}

export function getUserInputArchiveEnabled(userId: number): boolean {
  const row = db
    .prepare("SELECT keylog_archive_enabled FROM users WHERE id = ?")
    .get(userId) as { keylog_archive_enabled?: number } | undefined;
  return row?.keylog_archive_enabled === 1;
}

export function setUserInputArchiveEnabled(userId: number, enabled: boolean): { success: boolean; error?: string } {
  try {
    db.prepare("UPDATE users SET keylog_archive_enabled = ? WHERE id = ?").run(enabled ? 1 : 0, userId);
    return { success: true };
  } catch (err: any) {
    logger.error("[users] setUserInputArchiveEnabled error:", err);
    return { success: false, error: err.message || "Failed to update input archive preference" };
  }
}

export function getUsersWithInputArchiveEnabled(): Array<{ id: number; username: string; role: UserRole; client_scope: ClientAccessScope }> {
  return db
    .prepare("SELECT id, username, role, client_scope FROM users WHERE keylog_archive_enabled = 1")
    .all() as any[];
}

export function listUsers(): UserInfo[] {
  const users = db
    .prepare(
      "SELECT id, username, role, created_at, last_login, created_by, client_scope, plugin_scope, can_build, can_upload_files, telegram_chat_id, mfa_enabled, mfa_enabled_at FROM users ORDER BY created_at DESC",
    )
    .all() as UserInfo[];
  return users;
}

export function isMfaRequiredForUser(user: Pick<User, "role">): boolean {
  const security = getConfig().security;
  return user.role === "admin"
    ? Boolean(security.mfaRequiredForAdmins)
    : Boolean(security.mfaRequiredForNonAdmins);
}

export function getUserMfaStatus(userId: number): {
  enabled: boolean;
  enabledAt: number | null;
  secret: string | null;
} | null {
  const row = db
    .prepare("SELECT mfa_enabled, mfa_enabled_at, mfa_secret FROM users WHERE id = ?")
    .get(userId) as
      | { mfa_enabled: number; mfa_enabled_at: number | null; mfa_secret: string | null }
      | undefined;
  if (!row) return null;
  return {
    enabled: Boolean(row.mfa_enabled),
    enabledAt: row.mfa_enabled_at || null,
    secret: row.mfa_secret || null,
  };
}

export function setUserMfaSecret(userId: number, secret: string): { success: boolean; error?: string } {
  try {
    db.prepare("UPDATE users SET mfa_secret = ?, mfa_enabled = 0, mfa_enabled_at = NULL WHERE id = ?").run(
      secret,
      userId,
    );
    return { success: true };
  } catch (err: any) {
    logger.error("[users] setUserMfaSecret error:", err);
    return { success: false, error: err.message || "Failed to update MFA secret" };
  }
}

export function enableUserMfa(userId: number): { success: boolean; error?: string } {
  try {
    db.prepare("UPDATE users SET mfa_enabled = 1, mfa_enabled_at = ? WHERE id = ?").run(
      Date.now(),
      userId,
    );
    return { success: true };
  } catch (err: any) {
    logger.error("[users] enableUserMfa error:", err);
    return { success: false, error: err.message || "Failed to enable MFA" };
  }
}

export function disableUserMfa(userId: number): { success: boolean; error?: string } {
  try {
    db.prepare("UPDATE users SET mfa_secret = NULL, mfa_enabled = 0, mfa_enabled_at = NULL WHERE id = ?").run(
      userId,
    );
    return { success: true };
  } catch (err: any) {
    logger.error("[users] disableUserMfa error:", err);
    return { success: false, error: err.message || "Failed to disable MFA" };
  }
}

export function getUserClientAccessScope(userId: number): ClientAccessScope {
  return getUserAccessCacheEntry(userId).scope;
}

export function listUserClientAccessRules(userId: number): UserClientAccessRule[] {
  return db
    .prepare(
      "SELECT user_id as userId, client_id as clientId, access FROM user_client_access_rules WHERE user_id = ? ORDER BY client_id ASC",
    )
    .all(userId) as UserClientAccessRule[];
}

export function listUserClientRuleIdsByAccess(
  userId: number,
  access: ClientAccessRuleKind,
): string[] {
  const entry = getUserAccessCacheEntry(userId);
  const values = access === "allow" ? entry.allow : entry.deny;
  return Array.from(values).sort((left, right) => left.localeCompare(right));
}

function invalidateUserAccessCache(userId?: number): void {
  if (userId === undefined) {
    userAccessCache.clear();
    return;
  }
  userAccessCache.delete(userId);
}

function invalidateNotificationDeliveryCache(): void {
  notificationDeliveryCache = null;
}

function getUserAccessCacheEntry(userId: number): UserAccessCacheEntry {
  const cached = userAccessCache.get(userId);
  if (cached) {
    return cached;
  }

  const row = db
    .prepare("SELECT client_scope FROM users WHERE id = ?")
    .get(userId) as { client_scope?: ClientAccessScope } | undefined;
  const rules = db
    .prepare(
      "SELECT client_id as clientId, access FROM user_client_access_rules WHERE user_id = ?",
    )
    .all(userId) as Array<{ clientId: string; access: ClientAccessRuleKind }>;

  const entry: UserAccessCacheEntry = {
    scope: row?.client_scope || "none",
    allow: new Set<string>(),
    deny: new Set<string>(),
  };

  for (const rule of rules) {
    if (rule.access === "allow") {
      entry.allow.add(rule.clientId);
    } else if (rule.access === "deny") {
      entry.deny.add(rule.clientId);
    }
  }

  userAccessCache.set(userId, entry);
  return entry;
}

export function setUserClientAccessScope(
  userId: number,
  scope: ClientAccessScope,
): { success: boolean; error?: string } {
  if (!["none", "allowlist", "denylist", "all"].includes(scope)) {
    return { success: false, error: "Invalid client access scope" };
  }

  try {
    db.prepare("UPDATE users SET client_scope = ? WHERE id = ?").run(scope, userId);
    invalidateUserAccessCache(userId);
    return { success: true };
  } catch (err: any) {
    logger.error("[users] setUserClientAccessScope error:", err);
    return { success: false, error: err.message || "Failed to update client access scope" };
  }
}

export function setUserClientAccessRule(
  userId: number,
  clientId: string,
  access: ClientAccessRuleKind,
): { success: boolean; error?: string } {
  const normalizedClientId = (clientId || "").trim();
  if (!normalizedClientId) {
    return { success: false, error: "clientId is required" };
  }
  if (!["allow", "deny"].includes(access)) {
    return { success: false, error: "Invalid client access rule" };
  }

  try {
    db.prepare(
      "INSERT OR REPLACE INTO user_client_access_rules (user_id, client_id, access, created_at) VALUES (?, ?, ?, ?)",
    ).run(userId, normalizedClientId, access, Date.now());
    invalidateUserAccessCache(userId);
    return { success: true };
  } catch (err: any) {
    logger.error("[users] setUserClientAccessRule error:", err);
    return { success: false, error: err.message || "Failed to update client access rule" };
  }
}

export function removeUserClientAccessRule(
  userId: number,
  clientId: string,
): { success: boolean; error?: string } {
  try {
    db.prepare("DELETE FROM user_client_access_rules WHERE user_id = ? AND client_id = ?").run(
      userId,
      clientId,
    );
    invalidateUserAccessCache(userId);
    return { success: true };
  } catch (err: any) {
    logger.error("[users] removeUserClientAccessRule error:", err);
    return { success: false, error: err.message || "Failed to remove client access rule" };
  }
}

export const canUserAccessClient = withAdminBypass(
  (userId, _role, clientId: string): boolean => {
    const access = getUserAccessCacheEntry(userId);
    const scope = access.scope;
    if (scope === "none") return false;
    if (scope === "all") return true;
    if (scope === "allowlist") return access.allow.has(clientId);
    if (scope === "denylist") return !access.deny.has(clientId);
    return false;
  },
);

type PluginAccessCacheEntry = {
  scope: PluginAccessScope;
  allowed: Set<string>;
};

const pluginAccessCache = new Map<number, PluginAccessCacheEntry>();

function invalidatePluginAccessCache(userId?: number): void {
  if (userId === undefined) {
    pluginAccessCache.clear();
    return;
  }
  pluginAccessCache.delete(userId);
}

function getPluginAccessCacheEntry(userId: number): PluginAccessCacheEntry {
  const cached = pluginAccessCache.get(userId);
  if (cached) return cached;

  const row = db
    .prepare("SELECT plugin_scope FROM users WHERE id = ?")
    .get(userId) as { plugin_scope?: PluginAccessScope } | undefined;
  const rules = db
    .prepare("SELECT plugin_id as pluginId FROM user_plugin_access_rules WHERE user_id = ?")
    .all(userId) as Array<{ pluginId: string }>;

  const entry: PluginAccessCacheEntry = {
    scope: row?.plugin_scope || "none",
    allowed: new Set<string>(),
  };

  for (const rule of rules) {
    entry.allowed.add(rule.pluginId);
  }

  pluginAccessCache.set(userId, entry);
  return entry;
}

export function getUserPluginAccessScope(userId: number): PluginAccessScope {
  return getPluginAccessCacheEntry(userId).scope;
}

export function listUserPluginAccessRules(userId: number): UserPluginAccessRule[] {
  return db
    .prepare(
      "SELECT user_id as userId, plugin_id as pluginId FROM user_plugin_access_rules WHERE user_id = ? ORDER BY plugin_id ASC",
    )
    .all(userId) as UserPluginAccessRule[];
}

export const canUserAccessPlugin = withAdminBypass(
  (userId, _role, pluginId: string): boolean => {
    const access = getPluginAccessCacheEntry(userId);
    if (access.scope === "none") return false;
    if (access.scope === "all") return true;
    if (access.scope === "allowlist") return access.allowed.has(pluginId);
    return false;
  },
);

export function setUserPluginAccessScope(
  userId: number,
  scope: PluginAccessScope,
): { success: boolean; error?: string } {
  if (!["none", "allowlist", "all"].includes(scope)) {
    return { success: false, error: "Invalid plugin access scope" };
  }

  try {
    db.prepare("UPDATE users SET plugin_scope = ? WHERE id = ?").run(scope, userId);
    invalidatePluginAccessCache(userId);
    return { success: true };
  } catch (err: any) {
    logger.error("[users] setUserPluginAccessScope error:", err);
    return { success: false, error: err.message || "Failed to update plugin access scope" };
  }
}

export function setUserPluginAccessRule(
  userId: number,
  pluginId: string,
): { success: boolean; error?: string } {
  const normalizedPluginId = (pluginId || "").trim();
  if (!normalizedPluginId) {
    return { success: false, error: "pluginId is required" };
  }

  try {
    db.prepare(
      "INSERT OR REPLACE INTO user_plugin_access_rules (user_id, plugin_id, created_at) VALUES (?, ?, ?)",
    ).run(userId, normalizedPluginId, Date.now());
    invalidatePluginAccessCache(userId);
    return { success: true };
  } catch (err: any) {
    logger.error("[users] setUserPluginAccessRule error:", err);
    return { success: false, error: err.message || "Failed to update plugin access rule" };
  }
}

export function removeUserPluginAccessRule(
  userId: number,
  pluginId: string,
): { success: boolean; error?: string } {
  try {
    db.prepare("DELETE FROM user_plugin_access_rules WHERE user_id = ? AND plugin_id = ?").run(
      userId,
      pluginId,
    );
    invalidatePluginAccessCache(userId);
    return { success: true };
  } catch (err: any) {
    logger.error("[users] removeUserPluginAccessRule error:", err);
    return { success: false, error: err.message || "Failed to remove plugin access rule" };
  }
}

export function setUserPluginAccessRulesBulk(
  userId: number,
  pluginIds: string[],
): { success: boolean; error?: string } {
  try {
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM user_plugin_access_rules WHERE user_id = ?").run(userId);
      const stmt = db.prepare(
        "INSERT INTO user_plugin_access_rules (user_id, plugin_id, created_at) VALUES (?, ?, ?)",
      );
      const now = Date.now();
      for (const pid of pluginIds) {
        const normalized = (pid || "").trim();
        if (normalized) stmt.run(userId, normalized, now);
      }
    });
    tx();
    invalidatePluginAccessCache(userId);
    return { success: true };
  } catch (err: any) {
    logger.error("[users] setUserPluginAccessRulesBulk error:", err);
    return { success: false, error: err.message || "Failed to update plugin access rules" };
  }
}

export type FeatureName =
  | "console"
  | "remote_desktop"
  | "backstage"
  | "webcam"
  | "file_browser"
  | "processes"
  | "keylogger"
  | "voice"
  | "disconnect"
  | "reconnect"
  | "uninstall"
  | "client_metadata";

export const ALL_FEATURES: FeatureName[] = [
  "console",
  "remote_desktop",
  "backstage",
  "webcam",
  "file_browser",
  "processes",
  "keylogger",
  "voice",
  "disconnect",
  "reconnect",
  "uninstall",
  "client_metadata",
];

const featurePermCache = new Map<number, Map<string, boolean>>();

function getFeaturePermCacheEntry(userId: number): Map<string, boolean> {
  const cached = featurePermCache.get(userId);
  if (cached) return cached;

  const rows = db
    .prepare("SELECT feature, allowed FROM user_feature_permissions WHERE user_id = ?")
    .all(userId) as Array<{ feature: string; allowed: number }>;

  const map = new Map<string, boolean>();
  for (const row of rows) {
    map.set(row.feature, row.allowed === 1);
  }
  featurePermCache.set(userId, map);
  return map;
}

function invalidateFeaturePermCache(userId: number): void {
  featurePermCache.delete(userId);
}

export const canUserAccessFeature = withAdminBypass(
  (userId, role, feature: FeatureName): boolean => {
    if (role === "viewer") return false;
    const perms = getFeaturePermCacheEntry(userId);
    const entry = perms.get(feature);
    return entry === undefined ? true : entry;
  },
);

export function getUserFeaturePermissions(
  userId: number,
): Record<FeatureName, boolean> {
  const user = getUserById(userId);
  if (!user) {
    const result = {} as Record<FeatureName, boolean>;
    for (const f of ALL_FEATURES) result[f] = false;
    return result;
  }

  const result = {} as Record<FeatureName, boolean>;
  for (const f of ALL_FEATURES) {
    result[f] = canUserAccessFeature(userId, user.role, f);
  }
  return result;
}

export function setUserFeaturePermission(
  userId: number,
  feature: FeatureName,
  allowed: boolean,
): { success: boolean; error?: string } {
  if (!ALL_FEATURES.includes(feature)) {
    return { success: false, error: `Invalid feature: ${feature}` };
  }
  try {
    db.prepare(
      "INSERT OR REPLACE INTO user_feature_permissions (user_id, feature, allowed) VALUES (?, ?, ?)",
    ).run(userId, feature, allowed ? 1 : 0);
    invalidateFeaturePermCache(userId);
    return { success: true };
  } catch (err: any) {
    logger.error("[users] setUserFeaturePermission error:", err);
    return { success: false, error: err.message || "Failed to update feature permission" };
  }
}

export function setUserFeaturePermissions(
  userId: number,
  permissions: Partial<Record<FeatureName, boolean>>,
): { success: boolean; error?: string } {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO user_feature_permissions (user_id, feature, allowed) VALUES (?, ?, ?)",
  );
  try {
    const tx = db.transaction(() => {
      for (const [feature, allowed] of Object.entries(permissions)) {
        if (!ALL_FEATURES.includes(feature as FeatureName)) continue;
        stmt.run(userId, feature, allowed ? 1 : 0);
      }
    });
    tx();
    invalidateFeaturePermCache(userId);
    return { success: true };
  } catch (err: any) {
    logger.error("[users] setUserFeaturePermissions error:", err);
    return { success: false, error: err.message || "Failed to update feature permissions" };
  }
}

export function resetUserFeaturePermissions(
  userId: number,
): { success: boolean; error?: string } {
  try {
    db.prepare("DELETE FROM user_feature_permissions WHERE user_id = ?").run(userId);
    invalidateFeaturePermCache(userId);
    return { success: true };
  } catch (err: any) {
    logger.error("[users] resetUserFeaturePermissions error:", err);
    return { success: false, error: err.message || "Failed to reset feature permissions" };
  }
}

export function validatePasswordPolicy(password: string): string | null {
  const security = getConfig().security;
  const minLength = Math.min(128, Math.max(6, Number(security.passwordMinLength) || 6));

  if (!password || password.length < minLength) {
    return `Password must be at least ${minLength} characters`;
  }

  if (security.passwordRequireUppercase && !/[A-Z]/.test(password)) {
    return "Password must include at least one uppercase letter";
  }
  if (security.passwordRequireLowercase && !/[a-z]/.test(password)) {
    return "Password must include at least one lowercase letter";
  }
  if (security.passwordRequireNumber && !/[0-9]/.test(password)) {
    return "Password must include at least one number";
  }
  if (security.passwordRequireSymbol && !/[^A-Za-z0-9]/.test(password)) {
    return "Password must include at least one symbol";
  }

  return null;
}

export async function createUser(
  username: string,
  password: string,
  role: UserRole,
  createdBy: string,
  mustChangePassword = false,
): Promise<{ success: boolean; error?: string; userId?: number }> {
  if (!username || username.length < 3 || username.length > 32) {
    return {
      success: false,
      error: "Username must be between 3 and 32 characters",
    };
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return {
      success: false,
      error:
        "Username can only contain letters, numbers, hyphens, and underscores",
    };
  }

  const policyError = validatePasswordPolicy(password);
  if (policyError) {
    return { success: false, error: policyError };
  }

  const existing = getUserByUsername(username);
  if (existing) {
    return { success: false, error: "Username already exists" };
  }

  try {
    const passwordHash = await Bun.password.hash(password, {
      algorithm: "bcrypt",
      cost: 10,
    });

    const result = db
      .prepare(
        "INSERT INTO users (username, password_hash, role, created_at, created_by, must_change_password, client_scope, plugin_scope, can_build, can_upload_files) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(username, passwordHash, role, Date.now(), createdBy, mustChangePassword ? 1 : 0, role === "admin" ? "all" : "none", role === "admin" ? "all" : "none", role === "admin" || role === "operator" ? 1 : 0, role === "admin" ? 1 : 0);

    invalidateNotificationDeliveryCache();

    return { success: true, userId: result.lastInsertRowid as number };
  } catch (err: any) {
    logger.error("[users] Create user error:", err);
    return { success: false, error: err.message || "Failed to create user" };
  }
}

export async function createExternalUser(
  username: string,
  role: UserRole,
  createdBy: string,
  registeredVia: string,
): Promise<{ success: boolean; error?: string; userId?: number }> {
  if (!username || username.length < 3 || username.length > 32) {
    return {
      success: false,
      error: "Username must be between 3 and 32 characters",
    };
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return {
      success: false,
      error: "Username can only contain letters, numbers, hyphens, and underscores",
    };
  }

  const existing = getUserByUsername(username);
  if (existing) {
    return { success: false, error: "Username already exists" };
  }

  try {
    const passwordHash = await Bun.password.hash(crypto.randomUUID() + crypto.randomUUID(), {
      algorithm: "bcrypt",
      cost: 10,
    });

    const result = db
      .prepare(
        "INSERT INTO users (username, password_hash, role, created_at, created_by, must_change_password, client_scope, plugin_scope, can_build, can_upload_files, registered_via) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)",
      )
      .run(
        username,
        passwordHash,
        role,
        Date.now(),
        createdBy,
        role === "admin" ? "all" : "none",
        role === "admin" ? "all" : "none",
        role === "admin" || role === "operator" ? 1 : 0,
        role === "admin" ? 1 : 0,
        registeredVia,
      );

    invalidateNotificationDeliveryCache();

    return { success: true, userId: result.lastInsertRowid as number };
  } catch (err: any) {
    logger.error("[users] Create external user error:", err);
    return { success: false, error: err.message || "Failed to create external user" };
  }
}

export async function updateUserPassword(
  userId: number,
  newPassword: string,
): Promise<{ success: boolean; error?: string }> {
  const policyError = validatePasswordPolicy(newPassword);
  if (policyError) {
    return { success: false, error: policyError };
  }

  try {
    const passwordHash = await Bun.password.hash(newPassword, {
      algorithm: "bcrypt",
      cost: 10,
    });

    db.prepare(
      "UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?",
    ).run(passwordHash, userId);
    return { success: true };
  } catch (err: any) {
    console.error("[users] Update password error:", err);
    return {
      success: false,
      error: err.message || "Failed to update password",
    };
  }
}

export function updateUserRole(
  userId: number,
  newRole: UserRole,
): { success: boolean; error?: string } {
  try {
    const nextScope: ClientAccessScope = newRole === "admin" ? "all" : "none";
    const nextPluginScope: PluginAccessScope = newRole === "admin" ? "all" : "none";
    db.prepare("UPDATE users SET role = ?, client_scope = ?, plugin_scope = ? WHERE id = ?").run(
      newRole,
      nextScope,
      nextPluginScope,
      userId,
    );
    invalidateUserAccessCache(userId);
    invalidatePluginAccessCache(userId);
    invalidateNotificationDeliveryCache();
    return { success: true };
  } catch (err: any) {
    console.error("[users] Update role error:", err);
    return { success: false, error: err.message || "Failed to update role" };
  }
}

export function deleteUser(userId: number): {
  success: boolean;
  error?: string;
} {
  const admins = db
    .prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'")
    .get() as { count: number };
  const user = getUserById(userId);

  if (user?.role === "admin" && admins.count <= 1) {
    return { success: false, error: "Cannot delete the last admin user" };
  }

  try {
    // SQLite foreign keys aren't enforced by default, so manually purge the
    // user's dependent rows so the caches and the DB agree.
    db.transaction(() => {
      db.prepare("DELETE FROM user_permission_groups WHERE user_id = ?").run(userId);
      db.prepare("DELETE FROM user_extra_permissions WHERE user_id = ?").run(userId);
      db.prepare("DELETE FROM user_client_access_rules WHERE user_id = ?").run(userId);
      db.prepare("DELETE FROM user_plugin_access_rules WHERE user_id = ?").run(userId);
      db.prepare("DELETE FROM user_feature_permissions WHERE user_id = ?").run(userId);
      db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    })();
    invalidateUserAccessCache(userId);
    invalidatePluginAccessCache(userId);
    invalidateNotificationDeliveryCache();
    userGroupIdsCache.delete(userId);
    userExtraPermsCache.delete(userId);
    return { success: true };
  } catch (err: any) {
    console.error("[users] Delete user error:", err);
    return { success: false, error: err.message || "Failed to delete user" };
  }
}

export function updateLastLogin(userId: number): void {
  db.prepare("UPDATE users SET last_login = ? WHERE id = ?").run(
    Date.now(),
    userId,
  );
}

export function completeUserOnboarding(userId: number): boolean {
  const result = db
    .prepare(
      "UPDATE users SET onboarding_completed_at = ? WHERE id = ? AND onboarding_completed_at IS NULL",
    )
    .run(Date.now(), userId);
  return Number(result.changes) > 0;
}

let _dummyHashPromise: Promise<string> | null = null;
function getDummyPasswordHash(): Promise<string> {
  if (!_dummyHashPromise) {
    _dummyHashPromise = Bun.password.hash("__overlord_dummy_hash_for_timing__", {
      algorithm: "bcrypt",
      cost: 10,
    });
  }
  return _dummyHashPromise;
}

export async function verifyPassword(
  username: string,
  password: string,
): Promise<User | null> {
  const user = getUserByUsername(username);
  if (!user) {
    try {
      const dummy = await getDummyPasswordHash();
      await Bun.password.verify(password, dummy);
    } catch {
    }
    return null;
  }

  const isValid = await Bun.password.verify(password, user.password_hash);
  if (!isValid) return null;

  updateLastLogin(user.id);
  return user;
}

export const canBuildClients = withAdminBypass((userId): boolean => {
  const user = getUserById(userId);
  return user ? user.can_build === 1 : false;
});

export function setUserCanBuild(
  userId: number,
  canBuild: boolean,
): { success: boolean; error?: string } {
  try {
    db.prepare("UPDATE users SET can_build = ? WHERE id = ?").run(canBuild ? 1 : 0, userId);
    return { success: true };
  } catch (err: any) {
    logger.error("[users] setUserCanBuild error:", err);
    return { success: false, error: err.message || "Failed to update build permission" };
  }
}

export const canUploadFiles = withAdminBypass((userId): boolean => {
  const user = getUserById(userId);
  return user ? user.can_upload_files === 1 : false;
});

export function setUserCanUploadFiles(
  userId: number,
  canUpload: boolean,
): { success: boolean; error?: string } {
  try {
    db.prepare("UPDATE users SET can_upload_files = ? WHERE id = ?").run(canUpload ? 1 : 0, userId);
    return { success: true };
  } catch (err: any) {
    logger.error("[users] setUserCanUploadFiles error:", err);
    return { success: false, error: err.message || "Failed to update upload permission" };
  }
}

export const canChatWrite = withAdminBypass((userId, role): boolean => {
  const user = getUserById(userId);
  if (!user) return false;
  const chatWrite = (user as any).chat_write;
  if (chatWrite === null || chatWrite === undefined) {
    return role === "operator";
  }
  return chatWrite === 1;
});

export function setUserChatWrite(
  userId: number,
  canWrite: boolean | null,
): { success: boolean; error?: string } {
  try {
    db.prepare("UPDATE users SET chat_write = ? WHERE id = ?").run(canWrite === null ? null : (canWrite ? 1 : 0), userId);
    return { success: true };
  } catch (err: any) {
    logger.error("[users] setUserChatWrite error:", err);
    return { success: false, error: err.message || "Failed to update chat write permission" };
  }
}

export interface PermissionGroup {
  id: number;
  name: string;
  description: string | null;
  created_at: number;
  created_by: number | null;
  permissions: string[];
}

const groupPermsCache = new Map<number, Set<string>>();
const userGroupIdsCache = new Map<number, number[]>();
const userExtraPermsCache = new Map<number, Set<string>>();

function invalidateUserPermissionCaches(userId?: number): void {
  if (userId === undefined) {
    userGroupIdsCache.clear();
    userExtraPermsCache.clear();
    return;
  }
  userGroupIdsCache.delete(userId);
  userExtraPermsCache.delete(userId);
}

function invalidateGroupPermsCache(groupId?: number): void {
  if (groupId === undefined) {
    groupPermsCache.clear();
    return;
  }
  groupPermsCache.delete(groupId);
}

export function listPermissionGroups(): PermissionGroup[] {
  const rows = db
    .prepare(
      `SELECT id, name, description, created_at, created_by FROM permission_groups ORDER BY name ASC`,
    )
    .all() as Array<Omit<PermissionGroup, "permissions">>;
  return rows.map((row) => ({
    ...row,
    permissions: Array.from(getPermissionsForGroup(row.id)).sort(),
  }));
}

export function getPermissionGroup(groupId: number): PermissionGroup | null {
  const row = db
    .prepare(
      `SELECT id, name, description, created_at, created_by FROM permission_groups WHERE id = ?`,
    )
    .get(groupId) as Omit<PermissionGroup, "permissions"> | undefined;
  if (!row) return null;
  return {
    ...row,
    permissions: Array.from(getPermissionsForGroup(row.id)).sort(),
  };
}

function getPermissionsForGroup(groupId: number): Set<string> {
  const cached = groupPermsCache.get(groupId);
  if (cached) return cached;
  const rows = db
    .prepare("SELECT permission FROM permission_group_permissions WHERE group_id = ?")
    .all(groupId) as Array<{ permission: string }>;
  const set = new Set(rows.map((r) => r.permission));
  groupPermsCache.set(groupId, set);
  return set;
}

export function createPermissionGroup(
  name: string,
  description: string | null,
  permissions: string[],
  createdBy: number | null,
): { success: boolean; error?: string; group?: PermissionGroup } {
  const trimmedName = (name || "").trim();
  if (!trimmedName || trimmedName.length > 64) {
    return { success: false, error: "Name must be 1-64 characters" };
  }
  const trimmedDesc = description ? String(description).slice(0, 256).trim() || null : null;
  const perms = Array.from(new Set(permissions.filter((p) => typeof p === "string" && p.length > 0)));

  try {
    const tx = db.transaction(() => {
      const result = db
        .prepare(
          "INSERT INTO permission_groups (name, description, created_at, created_by) VALUES (?, ?, ?, ?)",
        )
        .run(trimmedName, trimmedDesc, Date.now(), createdBy);
      const groupId = result.lastInsertRowid as number;
      const insertPerm = db.prepare(
        "INSERT INTO permission_group_permissions (group_id, permission) VALUES (?, ?)",
      );
      for (const perm of perms) insertPerm.run(groupId, perm);
      return groupId;
    });
    const groupId = tx();
    invalidateGroupPermsCache(groupId);
    invalidateUserPermissionCaches();
    const group = getPermissionGroup(groupId);
    return group ? { success: true, group } : { success: false, error: "Failed to load created group" };
  } catch (err: any) {
    if (err.message?.includes("UNIQUE constraint")) {
      return { success: false, error: "A group with that name already exists" };
    }
    logger.error("[users] createPermissionGroup error:", err);
    return { success: false, error: err.message || "Failed to create permission group" };
  }
}

export function updatePermissionGroup(
  groupId: number,
  updates: { name?: string; description?: string | null; permissions?: string[] },
): { success: boolean; error?: string; group?: PermissionGroup } {
  const existing = getPermissionGroup(groupId);
  if (!existing) return { success: false, error: "Group not found" };

  try {
    const tx = db.transaction(() => {
      if (updates.name !== undefined) {
        const trimmed = String(updates.name).trim();
        if (!trimmed || trimmed.length > 64) throw new Error("Name must be 1-64 characters");
        db.prepare("UPDATE permission_groups SET name = ? WHERE id = ?").run(trimmed, groupId);
      }
      if (updates.description !== undefined) {
        const trimmed = updates.description ? String(updates.description).slice(0, 256).trim() || null : null;
        db.prepare("UPDATE permission_groups SET description = ? WHERE id = ?").run(trimmed, groupId);
      }
      if (updates.permissions !== undefined) {
        db.prepare("DELETE FROM permission_group_permissions WHERE group_id = ?").run(groupId);
        const insertPerm = db.prepare(
          "INSERT INTO permission_group_permissions (group_id, permission) VALUES (?, ?)",
        );
        const perms = Array.from(new Set(updates.permissions.filter((p) => typeof p === "string" && p.length > 0)));
        for (const perm of perms) insertPerm.run(groupId, perm);
      }
    });
    tx();
    invalidateGroupPermsCache(groupId);
    invalidateUserPermissionCaches();
    const group = getPermissionGroup(groupId);
    return group ? { success: true, group } : { success: false, error: "Failed to load updated group" };
  } catch (err: any) {
    if (err.message?.includes("UNIQUE constraint")) {
      return { success: false, error: "A group with that name already exists" };
    }
    logger.error("[users] updatePermissionGroup error:", err);
    return { success: false, error: err.message || "Failed to update permission group" };
  }
}

export function deletePermissionGroup(groupId: number): { success: boolean; error?: string } {
  try {
    // SQLite foreign keys aren't enforced unless PRAGMA foreign_keys=ON, so
    // clean up dependent rows explicitly to avoid orphans.
    const result = db.transaction(() => {
      db.prepare("DELETE FROM permission_group_permissions WHERE group_id = ?").run(groupId);
      db.prepare("DELETE FROM user_permission_groups WHERE group_id = ?").run(groupId);
      return db.prepare("DELETE FROM permission_groups WHERE id = ?").run(groupId);
    })();
    invalidateGroupPermsCache(groupId);
    invalidateUserPermissionCaches();
    if (result.changes === 0) return { success: false, error: "Group not found" };
    return { success: true };
  } catch (err: any) {
    logger.error("[users] deletePermissionGroup error:", err);
    return { success: false, error: err.message || "Failed to delete permission group" };
  }
}

export function getUserGroupIds(userId: number): number[] {
  const cached = userGroupIdsCache.get(userId);
  if (cached) return cached;
  const rows = db
    .prepare("SELECT group_id FROM user_permission_groups WHERE user_id = ?")
    .all(userId) as Array<{ group_id: number }>;
  const ids = rows.map((r) => r.group_id);
  userGroupIdsCache.set(userId, ids);
  return ids;
}

export function setUserGroups(
  userId: number,
  groupIds: number[],
): { success: boolean; error?: string } {
  try {
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM user_permission_groups WHERE user_id = ?").run(userId);
      const insert = db.prepare(
        "INSERT OR IGNORE INTO user_permission_groups (user_id, group_id) VALUES (?, ?)",
      );
      const unique = Array.from(new Set(groupIds.filter((id) => Number.isFinite(id))));
      for (const gid of unique) insert.run(userId, gid);
    });
    tx();
    invalidateUserPermissionCaches(userId);
    return { success: true };
  } catch (err: any) {
    logger.error("[users] setUserGroups error:", err);
    return { success: false, error: err.message || "Failed to update user groups" };
  }
}

export function getUserExtraPermissions(userId: number): Set<string> {
  const cached = userExtraPermsCache.get(userId);
  if (cached) return cached;
  const rows = db
    .prepare("SELECT permission FROM user_extra_permissions WHERE user_id = ?")
    .all(userId) as Array<{ permission: string }>;
  const set = new Set(rows.map((r) => r.permission));
  userExtraPermsCache.set(userId, set);
  return set;
}

export function setUserExtraPermissions(
  userId: number,
  permissions: string[],
): { success: boolean; error?: string } {
  try {
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM user_extra_permissions WHERE user_id = ?").run(userId);
      const insert = db.prepare(
        "INSERT OR IGNORE INTO user_extra_permissions (user_id, permission) VALUES (?, ?)",
      );
      const unique = Array.from(new Set(permissions.filter((p) => typeof p === "string" && p.length > 0)));
      for (const perm of unique) insert.run(userId, perm);
    });
    tx();
    invalidateUserPermissionCaches(userId);
    return { success: true };
  } catch (err: any) {
    logger.error("[users] setUserExtraPermissions error:", err);
    return { success: false, error: err.message || "Failed to update extra permissions" };
  }
}

// Collects every permission string a user has via assigned groups + direct
// extras. Returns a Set for cheap membership tests; getUserPermissions in
// rbac.ts unions this with role-level permissions.
export function getUserGrantedPermissions(userId: number): Set<string> {
  const result = new Set<string>();
  for (const groupId of getUserGroupIds(userId)) {
    for (const perm of getPermissionsForGroup(groupId)) result.add(perm);
  }
  for (const perm of getUserExtraPermissions(userId)) result.add(perm);
  return result;
}

export function setUserTelegramChatId(
  userId: number,
  chatId: string | null,
): { success: boolean; error?: string } {
  try {
    db.prepare("UPDATE users SET telegram_chat_id = ? WHERE id = ?").run(chatId, userId);
    invalidateNotificationDeliveryCache();
    return { success: true };
  } catch (err: any) {
    logger.error("[users] setUserTelegramChatId error:", err);
    return { success: false, error: err.message || "Failed to update Telegram chat ID" };
  }
}

export function getUserTelegramChatId(userId: number): string | null {
  const row = db
    .prepare("SELECT telegram_chat_id FROM users WHERE id = ?")
    .get(userId) as { telegram_chat_id?: string | null } | undefined;
  return row?.telegram_chat_id || null;
}

export function getUsersWithTelegramChatId(): Array<{ id: number; username: string; role: UserRole; client_scope: ClientAccessScope; telegram_chat_id: string }> {
  return db
    .prepare(
      "SELECT id, username, role, client_scope, telegram_chat_id FROM users WHERE telegram_chat_id IS NOT NULL AND telegram_chat_id != ''",
    )
    .all() as any[];
}

// ─── Per-user notification delivery settings ─────────────────────────────────

export interface UserNotificationSettings {
  webhook_enabled: number;
  webhook_url: string | null;
  webhook_template: string | null;
  telegram_enabled: number;
  telegram_bot_token: string | null;
  telegram_chat_id: string | null;
  telegram_template: string | null;
  client_event_webhook: number;
  client_event_telegram: number;
  client_event_push: number;
}

export function getUserNotificationSettings(userId: number): UserNotificationSettings | null {
  const row = db
    .prepare(
      "SELECT webhook_enabled, webhook_url, webhook_template, telegram_enabled, telegram_bot_token, telegram_chat_id, telegram_template, client_event_webhook, client_event_telegram, client_event_push FROM users WHERE id = ?",
    )
    .get(userId) as UserNotificationSettings | undefined;
  return row ?? null;
}

export function updateUserNotificationSettings(
  userId: number,
  settings: Partial<UserNotificationSettings>,
): { success: boolean; error?: string } {
  const fields: string[] = [];
  const values: any[] = [];

  if ("webhook_enabled" in settings) {
    fields.push("webhook_enabled = ?");
    values.push(settings.webhook_enabled ? 1 : 0);
  }
  if ("webhook_url" in settings) {
    fields.push("webhook_url = ?");
    values.push(settings.webhook_url || null);
  }
  if ("webhook_template" in settings) {
    fields.push("webhook_template = ?");
    values.push(settings.webhook_template || null);
  }
  if ("telegram_enabled" in settings) {
    fields.push("telegram_enabled = ?");
    values.push(settings.telegram_enabled ? 1 : 0);
  }
  if ("telegram_bot_token" in settings) {
    fields.push("telegram_bot_token = ?");
    values.push(settings.telegram_bot_token || null);
  }
  if ("telegram_chat_id" in settings) {
    fields.push("telegram_chat_id = ?");
    values.push(settings.telegram_chat_id || null);
  }
  if ("telegram_template" in settings) {
    fields.push("telegram_template = ?");
    values.push(settings.telegram_template || null);
  }
  if ("client_event_webhook" in settings) {
    fields.push("client_event_webhook = ?");
    values.push(settings.client_event_webhook ? 1 : 0);
  }
  if ("client_event_telegram" in settings) {
    fields.push("client_event_telegram = ?");
    values.push(settings.client_event_telegram ? 1 : 0);
  }
  if ("client_event_push" in settings) {
    fields.push("client_event_push = ?");
    values.push(settings.client_event_push ? 1 : 0);
  }

  if (fields.length === 0) return { success: true };

  try {
    values.push(userId);
    db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    invalidateNotificationDeliveryCache();
    return { success: true };
  } catch (err: any) {
    logger.error("[users] updateUserNotificationSettings error:", err);
    return { success: false, error: err.message || "Failed to update notification settings" };
  }
}

export interface UserDeliveryRow {
  id: number;
  username: string;
  role: UserRole;
  client_scope: ClientAccessScope;
  webhook_enabled: number;
  webhook_url: string | null;
  webhook_template: string | null;
  telegram_enabled: number;
  telegram_bot_token: string | null;
  telegram_chat_id: string | null;
  telegram_template: string | null;
  client_event_webhook: number;
  client_event_telegram: number;
  client_event_push: number;
}

export function getUsersForNotificationDelivery(): UserDeliveryRow[] {
  if (notificationDeliveryCache) {
    return notificationDeliveryCache;
  }

  notificationDeliveryCache = db
    .prepare(
      `SELECT id, username, role, client_scope,
              webhook_enabled, webhook_url, webhook_template,
              telegram_enabled, telegram_bot_token, telegram_chat_id, telegram_template,
              client_event_webhook, client_event_telegram, client_event_push
       FROM users
       WHERE (webhook_enabled = 1 AND webhook_url IS NOT NULL AND webhook_url != '')
          OR (telegram_enabled = 1 AND telegram_bot_token IS NOT NULL AND telegram_bot_token != ''
              AND telegram_chat_id IS NOT NULL AND telegram_chat_id != '')`,
    )
    .all() as UserDeliveryRow[];

  return notificationDeliveryCache;
}

export function getUsersForNotificationDeliveryByClient(clientId: string): UserDeliveryRow[] {
  return getUsersForNotificationDelivery().filter((user) =>
    canUserAccessClient(user.id, user.role, clientId),
  );
}

function getClientOwnerUserId(clientId: string): number | null {
  if (!clientId) return null;
  try {
    const row = db
      .prepare("SELECT built_by_user_id FROM clients WHERE id = ?")
      .get(clientId) as { built_by_user_id: number | null } | undefined;
    if (!row || row.built_by_user_id == null) return null;
    return typeof row.built_by_user_id === "number" ? row.built_by_user_id : null;
  } catch {
    return null;
  }
}

export function getUsersForNotificationDeliveryByClientOwnership(
  clientId: string,
): UserDeliveryRow[] {
  const ownerId = getClientOwnerUserId(clientId);
  const all = getUsersForNotificationDelivery();
  if (ownerId != null) {
    return all.filter((user) => user.id === ownerId);
  }
  return all.filter((user) => user.role === "admin");
}

export function isClientOwnedByUser(userId: number, clientId: string): boolean {
  const ownerId = getClientOwnerUserId(clientId);
  return ownerId != null && ownerId === userId;
}


export interface RegistrationKey {
  id: number;
  key: string;
  label: string | null;
  created_by: number;
  created_at: number;
  expires_at: number | null;
  used_by: number | null;
  used_at: number | null;
}

export interface PendingRegistration {
  id: number;
  username: string;
  password_hash: string;
  requested_at: number;
  status: "pending" | "approved" | "denied";
  reviewed_by: number | null;
  reviewed_at: number | null;
  key_used: number | null;
}

export function generateRegistrationKey(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const segments = 4;
  const segmentLen = 5;
  const parts: string[] = [];
  for (let s = 0; s < segments; s++) {
    let seg = "";
    const bytes = new Uint8Array(segmentLen);
    crypto.getRandomValues(bytes);
    for (let i = 0; i < segmentLen; i++) {
      seg += chars[bytes[i] % chars.length];
    }
    parts.push(seg);
  }
  return parts.join("-");
}

export function createRegistrationKeys(
  count: number,
  createdBy: number,
  label?: string,
  expiresInHours?: number,
): RegistrationKey[] {
  const safeCount = Math.min(100, Math.max(1, count));
  const now = Date.now();
  const expiresAt = expiresInHours && expiresInHours > 0
    ? now + expiresInHours * 60 * 60 * 1000
    : null;
  const safeLabel = label ? String(label).slice(0, 128).trim() : null;

  const stmt = db.prepare(
    `INSERT INTO registration_keys ("key", label, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
  );

  const keys: RegistrationKey[] = [];
  const tx = db.transaction(() => {
    for (let i = 0; i < safeCount; i++) {
      const key = generateRegistrationKey();
      const result = stmt.run(key, safeLabel, createdBy, now, expiresAt);
      keys.push({
        id: result.lastInsertRowid as number,
        key,
        label: safeLabel,
        created_by: createdBy,
        created_at: now,
        expires_at: expiresAt,
        used_by: null,
        used_at: null,
      });
    }
  });
  tx();
  return keys;
}

export function listRegistrationKeys(): RegistrationKey[] {
  return db.prepare(
    `SELECT id, "key", label, created_by, created_at, expires_at, used_by, used_at FROM registration_keys ORDER BY created_at DESC`,
  ).all() as RegistrationKey[];
}

export function getRegistrationKeyByValue(keyValue: string): RegistrationKey | null {
  const row = db.prepare(
    `SELECT id, "key", label, created_by, created_at, expires_at, used_by, used_at FROM registration_keys WHERE "key" = ?`,
  ).get(keyValue) as RegistrationKey | undefined;
  return row || null;
}

export function markRegistrationKeyUsed(keyId: number, usedByUserId: number): void {
  db.prepare(`UPDATE registration_keys SET used_by = ?, used_at = ? WHERE id = ?`).run(
    usedByUserId, Date.now(), keyId,
  );
}


export function claimRegistrationKey(
  keyValue: string,
  usedByUserId: number,
): { success: true; key: RegistrationKey } | { success: false; error: string } {
  const tx = db.transaction(() => {
    const row = db.prepare(
      `SELECT id, "key", label, created_by, created_at, expires_at, used_by, used_at FROM registration_keys WHERE "key" = ?`,
    ).get(keyValue) as RegistrationKey | undefined;

    if (!row) return { success: false as const, error: "Invalid registration key" };
    if (row.used_by !== null) return { success: false as const, error: "This registration key has already been used" };
    if (row.expires_at && row.expires_at < Date.now()) return { success: false as const, error: "This registration key has expired" };

    db.prepare(`UPDATE registration_keys SET used_by = ?, used_at = ? WHERE id = ? AND used_by IS NULL`).run(
      usedByUserId, Date.now(), row.id,
    );

    return { success: true as const, key: row };
  });
  return tx();
}

export function deleteRegistrationKey(keyId: number): boolean {
  const result = db.prepare(`DELETE FROM registration_keys WHERE id = ?`).run(keyId);
  return (result.changes as number) > 0;
}

export function createPendingRegistration(
  username: string,
  passwordHash: string,
  keyUsed?: number,
): { success: boolean; id?: number; error?: string } {
  try {
    const result = db.prepare(
      `INSERT INTO pending_registrations (username, password_hash, requested_at, status, key_used) VALUES (?, ?, ?, 'pending', ?)`,
    ).run(username, passwordHash, Date.now(), keyUsed || null);
    return { success: true, id: result.lastInsertRowid as number };
  } catch (err: any) {
    if (err.message?.includes("UNIQUE constraint")) {
      return { success: false, error: "A registration with this username is already pending" };
    }
    return { success: false, error: err.message || "Failed to create pending registration" };
  }
}

export function listPendingRegistrations(): PendingRegistration[] {
  return db.prepare(
    `SELECT id, username, requested_at, status, reviewed_by, reviewed_at, key_used FROM pending_registrations WHERE status = 'pending' ORDER BY requested_at ASC`,
  ).all() as PendingRegistration[];
}

export function getPendingRegistration(id: number): PendingRegistration | null {
  const row = db.prepare(
    `SELECT * FROM pending_registrations WHERE id = ?`,
  ).get(id) as PendingRegistration | undefined;
  return row || null;
}

export async function approvePendingRegistration(
  pendingId: number,
  reviewedBy: number,
  defaultRole: UserRole,
): Promise<{ success: boolean; userId?: number; error?: string }> {
  const pending = getPendingRegistration(pendingId);
  if (!pending) return { success: false, error: "Pending registration not found" };
  if (pending.status !== "pending") return { success: false, error: "Registration already reviewed" };

  const existing = getUserByUsername(pending.username);
  if (existing) return { success: false, error: "Username already exists" };

  try {
    const role = defaultRole === "viewer" ? "viewer" : "operator";
    const result = db.prepare(
      `INSERT INTO users (username, password_hash, role, created_at, created_by, client_scope, can_build, can_upload_files, registered_via) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      pending.username, pending.password_hash, role, Date.now(), "registration",
      "allowlist", role === "operator" ? 1 : 0, 0, "approval",
    );

    db.prepare(
      `UPDATE pending_registrations SET status = 'approved', reviewed_by = ?, reviewed_at = ? WHERE id = ?`,
    ).run(reviewedBy, Date.now(), pendingId);

    applyRegistrationDefaultGroups(result.lastInsertRowid as number);
    invalidateNotificationDeliveryCache();
    return { success: true, userId: result.lastInsertRowid as number };
  } catch (err: any) {
    logger.error("[users] approvePendingRegistration error:", err);
    return { success: false, error: err.message || "Failed to approve registration" };
  }
}

export function denyPendingRegistration(
  pendingId: number,
  reviewedBy: number,
): { success: boolean; error?: string } {
  const pending = getPendingRegistration(pendingId);
  if (!pending) return { success: false, error: "Pending registration not found" };
  if (pending.status !== "pending") return { success: false, error: "Registration already reviewed" };

  db.prepare(
    `UPDATE pending_registrations SET status = 'denied', reviewed_by = ?, reviewed_at = ? WHERE id = ?`,
  ).run(reviewedBy, Date.now(), pendingId);

  return { success: true };
}

export async function registerUser(
  username: string,
  password: string,
  registeredVia: "open" | "key",
  defaultRole: UserRole,
): Promise<{ success: boolean; error?: string; userId?: number }> {
  if (!username || username.length < 3 || username.length > 32) {
    return { success: false, error: "Username must be between 3 and 32 characters" };
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return { success: false, error: "Username can only contain letters, numbers, hyphens, and underscores" };
  }

  const policyError = validatePasswordPolicy(password);
  if (policyError) return { success: false, error: policyError };

  const existing = getUserByUsername(username);
  if (existing) return { success: false, error: "Username already exists" };

  const pendingExisting = db.prepare(
    `SELECT id FROM pending_registrations WHERE username = ? AND status = 'pending'`,
  ).get(username);
  if (pendingExisting) return { success: false, error: "A registration with this username is already pending" };

  try {
    const passwordHash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 });
    const role = defaultRole === "viewer" ? "viewer" : "operator";
    const result = db.prepare(
      `INSERT INTO users (username, password_hash, role, created_at, created_by, client_scope, can_build, can_upload_files, registered_via) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      username, passwordHash, role, Date.now(), "registration",
      "allowlist", role === "operator" ? 1 : 0, 0, registeredVia,
    );

    applyRegistrationDefaultGroups(result.lastInsertRowid as number);
    invalidateNotificationDeliveryCache();
    return { success: true, userId: result.lastInsertRowid as number };
  } catch (err: any) {
    if (err.message?.includes("UNIQUE constraint")) {
      return { success: false, error: "Username already exists" };
    }
    logger.error("[users] registerUser error:", err);
    return { success: false, error: err.message || "Failed to register user" };
  }
}

function applyRegistrationDefaultGroups(userId: number): void {
  let defaults: number[] = [];
  try {
    defaults = getConfig().registration.defaultGroupIds || [];
  } catch {
    return;
  }
  if (defaults.length === 0) return;
  const validIds: number[] = [];
  const check = db.prepare("SELECT 1 AS ok FROM permission_groups WHERE id = ?");
  for (const id of defaults) {
    if ((check.get(id) as { ok?: number } | undefined)?.ok) validIds.push(id);
  }
  if (validIds.length === 0) return;
  setUserGroups(userId, validIds);
}

export function getTotalUserCount(): number {
  const row = db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number };
  return row.count;
}


