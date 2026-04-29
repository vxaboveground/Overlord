import { Database } from "bun:sqlite";
import { resolve } from "path";
import { logger } from "./logger";
import { ensureDataDir } from "./paths";
import { getConfig } from "./config";

const dataDir = ensureDataDir();
const dbPath = resolve(dataDir, "overlord.db");
const db = new Database(dbPath);

export type UserRole = "admin" | "operator" | "viewer";
export type ClientAccessScope = "none" | "allowlist" | "denylist" | "all";
export type ClientAccessRuleKind = "allow" | "deny";

export interface User {
  id: number;
  username: string;
  password_hash: string;
  role: UserRole;
  created_at: number;
  last_login: number | null;
  created_by: string | null;
  must_change_password: number;
  client_scope: ClientAccessScope;
  can_build: number;
  can_upload_files: number;
  telegram_chat_id: string | null;
}

export interface UserInfo {
  id: number;
  username: string;
  role: UserRole;
  created_at: number;
  last_login: number | null;
  created_by: string | null;
  client_scope: ClientAccessScope;
  can_build: number;
  can_upload_files: number;
  telegram_chat_id: string | null;
}

export interface UserClientAccessRule {
  userId: number;
  clientId: string;
  access: ClientAccessRuleKind;
}

type UserAccessCacheEntry = {
  scope: ClientAccessScope;
  allow: Set<string>;
  deny: Set<string>;
};

const userAccessCache = new Map<number, UserAccessCacheEntry>();
let notificationDeliveryCache: UserDeliveryRow[] | null = null;

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'operator', 'viewer')),
    created_at INTEGER NOT NULL,
    last_login INTEGER,
    created_by TEXT,
    must_change_password INTEGER DEFAULT 0,
    client_scope TEXT NOT NULL DEFAULT 'none' CHECK(client_scope IN ('none', 'allowlist', 'denylist', 'all'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS user_client_access_rules (
    user_id INTEGER NOT NULL,
    client_id TEXT NOT NULL,
    access TEXT NOT NULL CHECK(access IN ('allow', 'deny')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, client_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`);

db.exec(
  `CREATE INDEX IF NOT EXISTS idx_user_client_access_rules_user ON user_client_access_rules(user_id)`,
);

db.exec(`
  CREATE TABLE IF NOT EXISTS user_feature_permissions (
    user_id INTEGER NOT NULL,
    feature TEXT NOT NULL,
    allowed INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, feature),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`);

try {
  db.exec(
    `ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0`,
  );
  logger.info("[users] Added must_change_password column to existing database");
} catch (err: any) {
  if (!err.message?.includes("duplicate column name")) {
    logger.error("[users] Migration error:", err);
  }
}

try {
  db.exec(
    `ALTER TABLE users ADD COLUMN client_scope TEXT NOT NULL DEFAULT 'none' CHECK(client_scope IN ('none', 'allowlist', 'denylist', 'all'))`,
  );
  logger.info("[users] Added client_scope column to existing database");
} catch (err: any) {
  if (!err.message?.includes("duplicate column name")) {
    logger.error("[users] Migration error:", err);
  }
}

try {
  db.exec(`UPDATE users SET client_scope='all' WHERE role='admin'`);
} catch (err: any) {
  logger.error("[users] Failed to normalize admin client_scope:", err);
}

try {
  db.exec(
    `ALTER TABLE users ADD COLUMN can_build INTEGER NOT NULL DEFAULT 0`,
  );
  logger.info("[users] Added can_build column to existing database");

  try {
    db.exec(`UPDATE users SET can_build=1 WHERE role='admin' OR role='operator'`);
  } catch (err: any) {
    logger.error("[users] Failed to backfill admin/operator can_build:", err);
  }
} catch (err: any) {
  if (!err.message?.includes("duplicate column name")) {
    logger.error("[users] Migration error:", err);
  }
}

try {
  db.exec(
    `ALTER TABLE users ADD COLUMN telegram_chat_id TEXT DEFAULT NULL`,
  );
  logger.info("[users] Added telegram_chat_id column to existing database");
} catch (err: any) {
  if (!err.message?.includes("duplicate column name")) {
    logger.error("[users] Migration error:", err);
  }
}

const notificationColumns: Array<{ sql: string; label: string }> = [
  { sql: `ALTER TABLE users ADD COLUMN webhook_enabled INTEGER DEFAULT 0`, label: "webhook_enabled" },
  { sql: `ALTER TABLE users ADD COLUMN webhook_url TEXT DEFAULT NULL`, label: "webhook_url" },
  { sql: `ALTER TABLE users ADD COLUMN webhook_template TEXT DEFAULT NULL`, label: "webhook_template" },
  { sql: `ALTER TABLE users ADD COLUMN telegram_enabled INTEGER DEFAULT 0`, label: "telegram_enabled" },
  { sql: `ALTER TABLE users ADD COLUMN telegram_bot_token TEXT DEFAULT NULL`, label: "telegram_bot_token" },
  { sql: `ALTER TABLE users ADD COLUMN telegram_template TEXT DEFAULT NULL`, label: "telegram_template" },
];
for (const col of notificationColumns) {
  try {
    db.exec(col.sql);
    logger.info(`[users] Added ${col.label} column to existing database`);
  } catch (err: any) {
    if (!err.message?.includes("duplicate column name")) {
      logger.error("[users] Migration error:", err);
    }
  }
}

try {
  db.exec(
    `ALTER TABLE users ADD COLUMN can_upload_files INTEGER NOT NULL DEFAULT 0`,
  );
  logger.info("[users] Added can_upload_files column to existing database");

  try {
    db.exec(`UPDATE users SET can_upload_files=1 WHERE role='admin'`);
  } catch (err: any) {
    logger.error("[users] Failed to backfill admin can_upload_files:", err);
  }
} catch (err: any) {
  if (!err.message?.includes("duplicate column name")) {
    logger.error("[users] Migration error:", err);
  }
}

const clientEventColumns: Array<{ sql: string; label: string }> = [
  { sql: `ALTER TABLE users ADD COLUMN client_event_webhook INTEGER DEFAULT 1`, label: "client_event_webhook" },
  { sql: `ALTER TABLE users ADD COLUMN client_event_telegram INTEGER DEFAULT 1`, label: "client_event_telegram" },
  { sql: `ALTER TABLE users ADD COLUMN client_event_push INTEGER DEFAULT 1`, label: "client_event_push" },
];
for (const col of clientEventColumns) {
  try {
    db.exec(col.sql);
    logger.info(`[users] Added ${col.label} column to existing database`);
  } catch (err: any) {
    if (!err.message?.includes("duplicate column name")) {
      logger.error("[users] Migration error:", err);
    }
  }
}

try {
  db.exec(`ALTER TABLE users ADD COLUMN chat_write INTEGER DEFAULT NULL`);
  logger.info("[users] Added chat_write column to existing database");
} catch (err: any) {
  if (!err.message?.includes("duplicate column name")) {
    logger.error("[users] Migration error:", err);
  }
}

try {
  db.exec(`ALTER TABLE users ADD COLUMN registered_via TEXT DEFAULT NULL`);
  logger.info("[users] Added registered_via column to existing database");
} catch (err: any) {
  if (!err.message?.includes("duplicate column name")) {
    logger.error("[users] Migration error:", err);
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS registration_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    label TEXT,
    created_by INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    used_by INTEGER,
    used_at INTEGER,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_registration_keys_key ON registration_keys("key")`);

db.exec(`
  CREATE TABLE IF NOT EXISTS pending_registrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'denied')),
    reviewed_by INTEGER,
    reviewed_at INTEGER,
    key_used INTEGER,
    FOREIGN KEY (key_used) REFERENCES registration_keys(id)
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_registrations_status ON pending_registrations(status)`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_registrations_username_pending ON pending_registrations(username) WHERE status = 'pending'`);


const userCount = db.prepare("SELECT COUNT(*) as count FROM users").get() as {
  count: number;
};
if (userCount.count === 0) {
  const config = getConfig();
  const initialUsername = (config.auth.username || "admin").trim() || "admin";
  const initialPassword = config.auth.password;

  logger.info("[users] No users found, creating default admin account");
  const defaultPassword = await Bun.password.hash(initialPassword, {
    algorithm: "bcrypt",
    cost: 10,
  });

  db.prepare(
    "INSERT INTO users (username, password_hash, role, created_at, created_by, must_change_password, client_scope, can_build, can_upload_files) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(initialUsername, defaultPassword, "admin", Date.now(), "system", 1, "all", 1, 1);

  const createdUser = db
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(initialUsername) as User | undefined;
  logger.info(
    "[users] Default admin created with must_change_password =",
    createdUser?.must_change_password,
  );

  logger.info(`[users] Initial admin account created (username: ${initialUsername})`);
  logger.warn(
    "[users] SECURITY WARNING: A default admin account has been created. Sign in and rotate the password immediately. Bootstrap credentials default to admin/admin unless overridden by configuration; the password is not logged.",
  );
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

export function listUsers(): UserInfo[] {
  const users = db
    .prepare(
      "SELECT id, username, role, created_at, last_login, created_by, client_scope, can_build, can_upload_files, telegram_chat_id FROM users ORDER BY created_at DESC",
    )
    .all() as UserInfo[];
  return users;
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

export function canUserAccessClient(
  userId: number,
  role: UserRole,
  clientId: string,
): boolean {
  if (role === "admin") return true;

  const access = getUserAccessCacheEntry(userId);
  const scope = access.scope;
  if (scope === "none") return false;
  if (scope === "all") return true;

  if (scope === "allowlist") {
    return access.allow.has(clientId);
  }
  if (scope === "denylist") {
    return !access.deny.has(clientId);
  }
  return false;
}

export type FeatureName =
  | "console"
  | "remote_desktop"
  | "hvnc"
  | "webcam"
  | "file_browser"
  | "processes"
  | "keylogger"
  | "voice";

export const ALL_FEATURES: FeatureName[] = [
  "console",
  "remote_desktop",
  "hvnc",
  "webcam",
  "file_browser",
  "processes",
  "keylogger",
  "voice",
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

export function canUserAccessFeature(
  userId: number,
  role: UserRole,
  feature: FeatureName,
): boolean {
  if (role === "admin") return true;
  if (role === "viewer") return false;

  const perms = getFeaturePermCacheEntry(userId);
  const entry = perms.get(feature);
  if (entry === undefined) return true;
  return entry;
}

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
        "INSERT INTO users (username, password_hash, role, created_at, created_by, client_scope, can_build, can_upload_files) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(username, passwordHash, role, Date.now(), createdBy, role === "admin" ? "all" : "none", role === "admin" || role === "operator" ? 1 : 0, role === "admin" ? 1 : 0);

    invalidateNotificationDeliveryCache();

    return { success: true, userId: result.lastInsertRowid as number };
  } catch (err: any) {
    logger.error("[users] Create user error:", err);
    return { success: false, error: err.message || "Failed to create user" };
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
    db.prepare("UPDATE users SET role = ?, client_scope = ? WHERE id = ?").run(
      newRole,
      nextScope,
      userId,
    );
    invalidateUserAccessCache(userId);
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
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    invalidateUserAccessCache(userId);
    invalidateNotificationDeliveryCache();
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

export function canManageUsers(role: UserRole): boolean {
  return role === "admin";
}

export function canControlClients(role: UserRole): boolean {
  return role === "admin" || role === "operator";
}

export function canViewClients(role: UserRole): boolean {
  return role === "admin";
}

export function canBuildClients(userId: number, role: UserRole): boolean {
  if (role === "admin") return true;
  const user = getUserById(userId);
  return user ? user.can_build === 1 : false;
}

export function canViewAuditLogs(role: UserRole): boolean {
  return role === "admin" || role === "operator";
}

export function canManageEnrollment(role: UserRole): boolean {
  return role === "admin" || role === "operator";
}

export function hasPermission(role: UserRole, permission: string, userId?: number): boolean {
  switch (permission) {
    case "users:manage":
      return canManageUsers(role);
    case "clients:control":
      return canControlClients(role);
    case "clients:view":
      return canViewClients(role);
    case "clients:build":
      if (userId !== undefined) return canBuildClients(userId, role);
      return role === "admin" || role === "operator";
    case "clients:enroll":
      return canManageEnrollment(role);
    case "audit:view":
      return canViewAuditLogs(role);
    case "chat:write":
      if (userId !== undefined) return canChatWrite(userId, role);
      return role === "admin" || role === "operator";
    default:
      return false;
  }
}

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

export function canUploadFiles(userId: number, role: UserRole): boolean {
  if (role === "admin") return true;
  const user = getUserById(userId);
  return user ? user.can_upload_files === 1 : false;
}

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

export function canChatWrite(userId: number, role: UserRole): boolean {
  if (role === "admin") return true;
  const user = getUserById(userId);
  if (!user) return false;
  const chatWrite = (user as any).chat_write;
  if (chatWrite === null || chatWrite === undefined) {
    return role === "operator";
  }
  return chatWrite === 1;
}

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

export function getTotalUserCount(): number {
  const row = db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number };
  return row.count;
}
