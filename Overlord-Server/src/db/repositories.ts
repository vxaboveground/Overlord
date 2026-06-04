import type { ClientInfo, ListFilters, ListResult, ClientRole } from "../types";
import Fuse from "fuse.js";
import { getThumbnailSummaries } from "../thumbnails";
import { db, dbPath } from "./connection";
import "./schema";

export type ChatMessageRecord = {
  id: number;
  userId: number;
  username: string;
  userRole: string;
  message: string;
  createdAt: number;
};

export function insertChatMessage(userId: number, username: string, userRole: string, message: string): ChatMessageRecord {
  const createdAt = Date.now();
  const result = db.run(
    `INSERT INTO chat_messages (user_id, username, user_role, message, created_at) VALUES (?, ?, ?, ?, ?)`,
    userId, username, userRole, message, createdAt,
  );
  const id = Number((result as any).lastInsertRowid);
  return { id, userId, username, userRole, message, createdAt };
}

export function getChatHistory(before?: number, limit: number = 50, retentionMs?: number): ChatMessageRecord[] {
  const maxLimit = Math.min(Math.max(1, limit), 200);
  const cutoff = retentionMs && retentionMs > 0 ? Date.now() - retentionMs : 0;
  let rows: any[];
  if (before) {
    if (cutoff > 0) {
      rows = db.query<any>(
        `SELECT id, user_id, username, user_role, message, created_at FROM chat_messages WHERE created_at < ? AND created_at > ? ORDER BY created_at DESC LIMIT ?`,
      ).all(before, cutoff, maxLimit);
    } else {
      rows = db.query<any>(
        `SELECT id, user_id, username, user_role, message, created_at FROM chat_messages WHERE created_at < ? ORDER BY created_at DESC LIMIT ?`,
      ).all(before, maxLimit);
    }
  } else {
    if (cutoff > 0) {
      rows = db.query<any>(
        `SELECT id, user_id, username, user_role, message, created_at FROM chat_messages WHERE created_at > ? ORDER BY created_at DESC LIMIT ?`,
      ).all(cutoff, maxLimit);
    } else {
      rows = db.query<any>(
        `SELECT id, user_id, username, user_role, message, created_at FROM chat_messages ORDER BY created_at DESC LIMIT ?`,
      ).all(maxLimit);
    }
  }
  return rows.map((r: any) => ({
    id: r.id,
    userId: r.user_id,
    username: r.username,
    userRole: r.user_role,
    message: r.message,
    createdAt: r.created_at,
  })).reverse();
}

export function deleteExpiredChatMessages(retentionMs: number): number {
  if (retentionMs <= 0) return 0;
  const cutoff = Date.now() - retentionMs;
  const result = db.run(`DELETE FROM chat_messages WHERE created_at < ?`, cutoff);
  return Number((result as any).changes ?? 0);
}

export type SharedFileRecord = {
  id: string;
  filename: string;
  storedPath: string;
  size: number;
  mimeType: string;
  uploadedBy: number;
  uploadedByUsername: string;
  passwordHash: string | null;
  maxDownloads: number | null;
  downloadCount: number;
  expiresAt: number | null;
  createdAt: number;
  description: string | null;
};

export function insertSharedFile(file: SharedFileRecord): void {
  db.run(
    `INSERT INTO shared_files (id, filename, stored_path, size, mime_type, uploaded_by, uploaded_by_username, password_hash, max_downloads, download_count, expires_at, created_at, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    file.id,
    file.filename,
    file.storedPath,
    file.size,
    file.mimeType,
    file.uploadedBy,
    file.uploadedByUsername,
    file.passwordHash,
    file.maxDownloads,
    file.downloadCount,
    file.expiresAt,
    file.createdAt,
    file.description,
  );
}

export function getSharedFile(id: string): SharedFileRecord | null {
  const row = db.query<any>(`SELECT * FROM shared_files WHERE id=?`).get(id);
  if (!row) return null;
  return {
    id: row.id,
    filename: row.filename,
    storedPath: row.stored_path,
    size: row.size,
    mimeType: row.mime_type,
    uploadedBy: row.uploaded_by,
    uploadedByUsername: row.uploaded_by_username,
    passwordHash: row.password_hash,
    maxDownloads: row.max_downloads,
    downloadCount: row.download_count,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    description: row.description,
  };
}

export function listSharedFiles(): SharedFileRecord[] {
  return db
    .query<any>(`SELECT * FROM shared_files ORDER BY created_at DESC`)
    .all()
    .map((row: any) => ({
      id: row.id,
      filename: row.filename,
      storedPath: row.stored_path,
      size: row.size,
      mimeType: row.mime_type,
      uploadedBy: row.uploaded_by,
      uploadedByUsername: row.uploaded_by_username,
      passwordHash: row.password_hash,
      maxDownloads: row.max_downloads,
      downloadCount: row.download_count,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      description: row.description,
    }));
}

export function deleteSharedFile(id: string): boolean {
  const result = db.run(`DELETE FROM shared_files WHERE id=?`, id);
  return (result as any)?.changes ? (result as any).changes > 0 : false;
}

export function updateSharedFile(
  id: string,
  updates: {
    passwordHash?: string | null;
    maxDownloads?: number | null;
    expiresAt?: number | null;
    description?: string | null;
  },
): boolean {
  const setClauses: string[] = [];
  const values: any[] = [];

  if (updates.passwordHash !== undefined) {
    setClauses.push("password_hash=?");
    values.push(updates.passwordHash);
  }
  if (updates.maxDownloads !== undefined) {
    setClauses.push("max_downloads=?");
    values.push(updates.maxDownloads);
  }
  if (updates.expiresAt !== undefined) {
    setClauses.push("expires_at=?");
    values.push(updates.expiresAt);
  }
  if (updates.description !== undefined) {
    setClauses.push("description=?");
    values.push(updates.description);
  }

  if (setClauses.length === 0) return false;

  values.push(id);
  const result = db.run(
    `UPDATE shared_files SET ${setClauses.join(", ")} WHERE id=?`,
    ...values,
  );
  return (result as any)?.changes ? (result as any).changes > 0 : false;
}

export function incrementSharedFileDownloadCount(id: string): boolean {
  const result = db.run(
    `UPDATE shared_files SET download_count = download_count + 1 WHERE id=?`,
    id,
  );
  return (result as any)?.changes ? (result as any).changes > 0 : false;
}

export function deleteExpiredSharedFiles(): string[] {
  const now = Date.now();
  const expired = db
    .query<any>(`SELECT id, stored_path FROM shared_files WHERE expires_at IS NOT NULL AND expires_at < ?`)
    .all(now);
  const ids = expired.map((r: any) => r.id);
  const paths = expired.map((r: any) => r.stored_path);
  if (ids.length > 0) {
    for (const id of ids) {
      db.run(`DELETE FROM shared_files WHERE id=?`, id);
    }
  }
  return paths;
}

export type ClientDbRow = Omit<Partial<ClientInfo>, "online"> & {
  id: string;
  lastSeen?: number;
  online?: number;
};

export function upsertClientRow(
  partial: ClientDbRow,
) {
  const now = partial.lastSeen ?? Date.now();
  db.run(
    `INSERT INTO clients (id, hwid, role, ip, host, os, arch, version, user, nickname, custom_tag, custom_tag_note, monitors, country, last_seen, online, ping_ms, build_tag, built_by_user_id, enrollment_status, public_key, key_fingerprint, cpu, gpu, ram, battery_percent, battery_charging, is_admin, elevation, permissions)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 0), ?, ?)
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
      build_tag=COALESCE(excluded.build_tag, clients.build_tag),
      built_by_user_id=COALESCE(excluded.built_by_user_id, clients.built_by_user_id),
       enrollment_status=CASE WHEN excluded.enrollment_status <> 'pending' THEN excluded.enrollment_status ELSE COALESCE(clients.enrollment_status, 'pending') END,
       public_key=COALESCE(excluded.public_key, clients.public_key),
       key_fingerprint=COALESCE(excluded.key_fingerprint, clients.key_fingerprint),
       cpu=COALESCE(excluded.cpu, clients.cpu),
       gpu=COALESCE(excluded.gpu, clients.gpu),
       ram=COALESCE(excluded.ram, clients.ram),
       battery_percent=COALESCE(excluded.battery_percent, clients.battery_percent),
       battery_charging=COALESCE(excluded.battery_charging, clients.battery_charging),
       is_admin=COALESCE(excluded.is_admin, clients.is_admin),
       elevation=COALESCE(excluded.elevation, clients.elevation),
       permissions=COALESCE(excluded.permissions, clients.permissions)
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
    partial.buildTag ?? null,
    partial.builtByUserId ?? null,
    partial.enrollmentStatus ?? "pending",
    partial.publicKey ?? null,
    partial.keyFingerprint ?? null,
    partial.cpu ?? null,
    partial.gpu ?? null,
    partial.ram ?? null,
    partial.batteryPercent ?? null,
    partial.batteryCharging !== undefined && partial.batteryCharging !== null ? (partial.batteryCharging ? 1 : 0) : null,
    partial.isAdmin !== undefined ? (partial.isAdmin ? 1 : 0) : null,
    partial.elevation ?? null,
    partial.permissions ? JSON.stringify(partial.permissions) : null,
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

export interface ClientGroup {
  id: number;
  name: string;
  color: string;
  createdAt: number;
  clientCount?: number;
}

export function listGroups(): ClientGroup[] {
  const rows = db.query<any>(
    `SELECT g.id, g.name, g.color, g.created_at as createdAt,
            COUNT(c.id) as clientCount
     FROM client_groups g
     LEFT JOIN clients c ON c.group_id = g.id
     GROUP BY g.id
     ORDER BY g.name ASC`,
  ).all();
  return rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    color: r.color,
    createdAt: r.createdAt,
    clientCount: r.clientCount ?? 0,
  }));
}

export function getGroup(id: number): ClientGroup | null {
  const row = db.query<any>(
    `SELECT id, name, color, created_at as createdAt FROM client_groups WHERE id=?`,
  ).get(id);
  return row ? { id: row.id, name: row.name, color: row.color, createdAt: row.createdAt } : null;
}

export function createGroup(name: string, color: string): ClientGroup {
  const now = Date.now();
  const result = db.run(
    `INSERT INTO client_groups (name, color, created_at) VALUES (?, ?, ?)`,
    name.trim(),
    color,
    now,
  );
  return { id: Number(result.lastInsertRowid), name: name.trim(), color, createdAt: now };
}

export function updateGroup(id: number, name: string, color: string): boolean {
  const result = db.run(
    `UPDATE client_groups SET name=?, color=? WHERE id=?`,
    name.trim(),
    color,
    id,
  );
  return ((result as any)?.changes || 0) > 0;
}

export function deleteGroup(id: number): boolean {
  db.run(`UPDATE clients SET group_id=NULL WHERE group_id=?`, id);
  const result = db.run(`DELETE FROM client_groups WHERE id=?`, id);
  return ((result as any)?.changes || 0) > 0;
}

export function setClientGroup(clientId: string, groupId: number | null): boolean {
  const result = db.run(
    `UPDATE clients SET group_id=? WHERE id=?`,
    groupId,
    clientId,
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

export function persistRevokedTokenHash(tokenHash: string, expiresAt: number): void {
  db.run(
    `INSERT OR IGNORE INTO revoked_tokens (token_hash, expires_at) VALUES (?, ?)`,
    tokenHash,
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

export type SessionRecord = {
  id: string;
  userId: number;
  tokenHash: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: number;
  lastActivity: number;
  expiresAt: number;
  revoked: boolean;
};

export function createSession(session: {
  id: string;
  userId: number;
  tokenHash: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: number;
  expiresAt: number;
}): void {
  db.run(
    `INSERT INTO sessions (id, user_id, token_hash, ip, user_agent, created_at, last_activity, expires_at, revoked)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    session.id,
    session.userId,
    session.tokenHash,
    session.ip,
    session.userAgent,
    session.createdAt,
    session.createdAt,
    session.expiresAt,
  );
}

export function getSessionByTokenHash(tokenHash: string): SessionRecord | null {
  const row = db.query<any>(
    `SELECT * FROM sessions WHERE token_hash=? AND revoked=0`,
  ).get(tokenHash);
  if (!row) return null;
  return mapSessionRow(row);
}

export function getSessionById(id: string): SessionRecord | null {
  const row = db.query<any>(`SELECT * FROM sessions WHERE id=?`).get(id);
  if (!row) return null;
  return mapSessionRow(row);
}

export function listUserSessions(userId: number): SessionRecord[] {
  const rows = db.query<any>(
    `SELECT * FROM sessions WHERE user_id=? ORDER BY created_at DESC`,
  ).all(userId);
  return rows.map(mapSessionRow);
}

export function updateSessionActivity(tokenHash: string): void {
  const now = Math.floor(Date.now() / 1000);
  db.run(`UPDATE sessions SET last_activity=? WHERE token_hash=? AND revoked=0`, now, tokenHash);
}

export function revokeSessionByTokenHash(tokenHash: string): boolean {
  const result = db.run(`UPDATE sessions SET revoked=1 WHERE token_hash=? AND revoked=0`, tokenHash);
  return result.changes > 0;
}

export function revokeSessionById(sessionId: string): { tokenHash: string | null } {
  const row = db.query<{ token_hash: string }>(
    `SELECT token_hash FROM sessions WHERE id=? AND revoked=0`,
  ).get(sessionId);
  if (!row) return { tokenHash: null };
  db.run(`UPDATE sessions SET revoked=1 WHERE id=?`, sessionId);
  return { tokenHash: row.token_hash };
}

export function revokeAllUserSessions(userId: number): number {
  const result = db.run(`UPDATE sessions SET revoked=1 WHERE user_id=? AND revoked=0`, userId);
  return result.changes;
}

export function pruneExpiredSessions(): number {
  const now = Math.floor(Date.now() / 1000);
  const result = db.run(`DELETE FROM sessions WHERE expires_at <= ?`, now);
  return result.changes;
}

export function hashTokenForSession(token: string): string {
  return hashToken(token);
}

function mapSessionRow(row: any): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    ip: row.ip,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    lastActivity: row.last_activity,
    expiresAt: row.expires_at,
    revoked: !!row.revoked,
  };
}

export function markAllClientsOffline() {
  db.run(`UPDATE clients SET online=0`);
  console.log("[db] marked all clients as offline");
}

export const SUSPICIOUS_FLOOD_THRESHOLD = Math.max(2, Number(process.env.OVERLORD_SUSPICIOUS_FLOOD_THRESHOLD || 40));
const SUSPICIOUS_IP_FLOOD_WINDOW_MS = Math.max(60_000, Number(process.env.OVERLORD_SUSPICIOUS_IP_WINDOW_MS || 300_000));
const SUSPICIOUS_SCAN_MAX_CLIENTS = Math.max(0, Number(process.env.OVERLORD_SUSPICIOUS_SCAN_MAX_CLIENTS || 50_000));

export function getFloodedHwids(threshold = SUSPICIOUS_FLOOD_THRESHOLD): Set<string> {
  const rows = db
    .query<{ hwid: string }>(
      `SELECT hwid FROM clients WHERE hwid IS NOT NULL AND hwid != '' GROUP BY hwid HAVING COUNT(*) >= ?`,
    )
    .all(threshold);
  return new Set(rows.map((r) => r.hwid));
}

export function getFloodedHardware(threshold = SUSPICIOUS_FLOOD_THRESHOLD): Set<string> {
  const rows = db
    .query<{ cpu: string; gpu: string; ram: string; os: string }>(
      `SELECT cpu, gpu, ram, os FROM clients
       WHERE cpu IS NOT NULL AND cpu != '' AND os IS NOT NULL AND os != ''
       GROUP BY cpu, gpu, ram, os HAVING COUNT(*) >= ?`,
    )
    .all(threshold);
  const keys = new Set<string>();
  for (const r of rows) keys.add(`${r.cpu}|${r.gpu ?? ""}|${r.ram ?? ""}|${r.os}`);
  return keys;
}

export function getFloodedIps(threshold = SUSPICIOUS_FLOOD_THRESHOLD): Set<string> {
  const since = Date.now() - SUSPICIOUS_IP_FLOOD_WINDOW_MS;
  const rows = db
    .query<{ ip: string }>(
      `SELECT ip FROM clients WHERE ip IS NOT NULL AND ip != '' AND last_seen > ? GROUP BY ip HAVING COUNT(*) >= ?`,
    )
    .all(since, threshold);
  return new Set(rows.map((r) => r.ip));
}

const FLOOD_CACHE_TTL_MS = 30_000;
let _floodCacheTs = 0;
let _cachedFloodedHwids: Set<string> | null = null;
let _cachedFloodedHardware: Set<string> | null = null;
let _cachedFloodedIps: Set<string> | null = null;

function getFloodSetsWithCache(): { floodedHwids: Set<string>; floodedHardware: Set<string>; floodedIps: Set<string> } {
  const now = Date.now();
  if (now - _floodCacheTs > FLOOD_CACHE_TTL_MS) {
    _cachedFloodedHwids = getFloodedHwids();
    _cachedFloodedHardware = getFloodedHardware();
    _cachedFloodedIps = getFloodedIps();
    _floodCacheTs = now;
  }
  return { floodedHwids: _cachedFloodedHwids!, floodedHardware: _cachedFloodedHardware!, floodedIps: _cachedFloodedIps! };
}

function parseRamGb(ram: string | null | undefined): number | null {
  if (!ram) return null;
  const m = ram.match(/(\d+(?:\.\d+)?)\s*(tb|gb|mb|kb)/i);
  if (!m) return null;
  const val = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (unit === "tb") return val * 1024;
  if (unit === "gb") return val;
  if (unit === "mb") return val / 1024;
  if (unit === "kb") return val / (1024 * 1024);
  return null;
}

export type SuspiciousFlags = string[];

const VM_CPU_PATTERNS = [
  /\bqemu\b/i,
  /\bkvm\b/i,
  /\bvmware\b/i,
  /\bvirtualbox\b/i,
  /virtual\s+cpu/i,
  /\bhyper-v\b/i,
  /\bbochs\b/i,
  /\bxen\b/i,
];

const VM_GPU_PATTERNS = [
  /vmware/i,
  /virtualbox/i,
  /\bqemu\b/i,
  /microsoft\s+basic\s+(render|display)/i,
  /cirrus\s+logic/i,
  /standard\s+vga/i,
  /\bllvmpipe\b/i,
  /\bsoftpipe\b/i,
  /\bqxl\b/i,
  /\bvirtio\b/i,
  /hyper-v\s+video/i,
  /terminal\s+server/i,
  /remote\s+desktop/i,
  /parsec\s+display/i,
];

export function computeClientSuspiciousFlags(
  client: {
    id?: string;
    hwid?: string | null;
    cpu?: string | null;
    gpu?: string | null;
    ram?: string | null;
    os?: string | null;
    host?: string | null;
    user?: string | null;
    ip?: string | null;
    monitors?: number | null;
  },
  precomputed?: {
    floodedHwids?: Set<string>;
    floodedHardware?: Set<string>;
    floodedIps?: Set<string>;
  },
): SuspiciousFlags {
  const flags: string[] = [];
  const allProvided = precomputed?.floodedHwids !== undefined && precomputed?.floodedHardware !== undefined && precomputed?.floodedIps !== undefined;
  const sets = allProvided ? (precomputed as Required<typeof precomputed>) : getFloodSetsWithCache();
  const fHwids = sets.floodedHwids;
  const fHardware = sets.floodedHardware;
  const fIps = sets.floodedIps;

  if (client.hwid && fHwids.has(client.hwid)) flags.push("hwid_flood");

  if (client.cpu && client.os) {
    const hwKey = `${client.cpu}|${client.gpu ?? ""}|${client.ram ?? ""}|${client.os}`;
    if (fHardware.has(hwKey)) flags.push("hw_flood");
  }

  if (!client.host || !client.host.trim()) flags.push("no_hostname");
  if (!client.user || !client.user.trim()) flags.push("no_user");

  if (client.ip && fIps.has(client.ip)) flags.push("ip_flood");

  const cpuIsVm = !!client.cpu && VM_CPU_PATTERNS.some((p) => p.test(client.cpu!));
  const gpuIsVm = !!client.gpu && VM_GPU_PATTERNS.some((p) => p.test(client.gpu!));
  if (cpuIsVm || gpuIsVm) flags.push("vm_hardware");

  const ramGb = parseRamGb(client.ram);
  if (ramGb !== null && [0.25, 0.5, 1, 2, 4].some((s) => Math.abs(ramGb - s) < 0.05)) {
    flags.push("vm_ram");
  }

  if (typeof client.monitors === "number" && client.monitors === 0) {
    flags.push("no_monitors");
  }

  return flags;
}

const CLIENT_SEARCH_KEYS = [
  { name: "nickname", weight: 0.32 },
  { name: "host", weight: 0.28 },
  { name: "user", weight: 0.18 },
  { name: "id", weight: 0.18 },
  { name: "customTag", weight: 0.2 },
  { name: "customTagNote", weight: 0.1 },
  { name: "groupName", weight: 0.14 },
  { name: "os", weight: 0.12 },
  { name: "ip", weight: 0.1 },
  { name: "hwid", weight: 0.08 },
  { name: "country", weight: 0.06 },
  { name: "version", weight: 0.06 },
  { name: "buildTag", weight: 0.06 },
  { name: "cpu", weight: 0.05 },
  { name: "gpu", weight: 0.05 },
  { name: "ram", weight: 0.04 },
] as const;

const CLIENT_SEARCH_SQL_COLUMNS = [
  "COALESCE(c.nickname,'')",
  "COALESCE(c.host,'')",
  "COALESCE(c.user,'')",
  "c.id",
  "COALESCE(c.custom_tag,'')",
  "COALESCE(c.custom_tag_note,'')",
  "COALESCE(g.name,'')",
  "COALESCE(c.os,'')",
  "COALESCE(c.ip,'')",
  "COALESCE(c.hwid,'')",
  "COALESCE(c.country,'')",
  "COALESCE(c.version,'')",
  "COALESCE(c.build_tag,'')",
  "COALESCE(c.cpu,'')",
  "COALESCE(c.gpu,'')",
  "COALESCE(c.ram,'')",
] as const;

function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function buildFuzzyCandidateWhere(search: string): { sql: string; params: string[] } {
  const query = search.trim().toLowerCase();
  if (!query) return { sql: "", params: [] };

  const terms = Array.from(new Set([
    query,
    ...query.split(/[\s,;:|/\\]+/),
  ].map((term) => term.trim()).filter((term) => term.length >= 2))).slice(0, 8);

  if (!terms.length) return { sql: "", params: [] };

  const fieldClause = CLIENT_SEARCH_SQL_COLUMNS
    .map((column) => `LOWER(${column}) LIKE ? ESCAPE '\\'`)
    .join(" OR ");
  const sql = terms.map(() => `(${fieldClause})`).join(" OR ");
  const params = terms.flatMap((term) => {
    const like = `%${escapeLikeTerm(term)}%`;
    return CLIENT_SEARCH_SQL_COLUMNS.map(() => like);
  });

  return { sql: `(${sql})`, params };
}

function buildClientSearchFtsQuery(search: string): string {
  const terms = Array.from(new Set(
    search
      .trim()
      .split(/[\s,;:|/\\]+/)
      .map((term) => term.replace(/["*]/g, "").trim())
      .filter((term) => term.length >= 2),
  )).slice(0, 8);

  return terms.map((term) => `"${term}"*`).join(" OR ");
}

function getFtsClientSearchCandidateIds(search: string, limit: number): string[] | null {
  const ftsQuery = buildClientSearchFtsQuery(search);
  if (!ftsQuery) return [];

  try {
    return db
      .query<{ id: string }>(
        `SELECT id
         FROM client_search_fts
         WHERE client_search_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsQuery, limit)
      .map((row) => row.id)
      .filter(Boolean);
  } catch {
    return null;
  }
}

function fuzzySearchClientRows(rows: any[], search: string): any[] {
  const query = search.trim();
  if (!query) return rows;

  const fuse = new Fuse(rows, {
    keys: CLIENT_SEARCH_KEYS as any,
    threshold: 0.36,
    distance: 120,
    ignoreLocation: true,
    shouldSort: true,
  });

  return fuse.search(query).map((result) => result.item);
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
    builtByUserId,
    requireBuildOwner,
    allowedClientIds,
    deniedClientIds,
    groupFilter,
  } = filters;
  const where: string[] = [];
  const params: any[] = [];

  if (statusFilter === "online") {
    where.push("c.online=1");
  } else if (statusFilter === "offline") {
    where.push("c.online=0");
  }

  if (enrollmentFilter && enrollmentFilter !== "all") {
    if (enrollmentFilter === "pending") {
      where.push("(c.enrollment_status='pending' OR c.enrollment_status IS NULL)");
    } else {
      where.push("c.enrollment_status=?");
      params.push(enrollmentFilter);
    }
  }

  if (osFilter && osFilter !== "all") {
    where.push("c.os=?");
    params.push(osFilter);
  }

  if (countryFilter && countryFilter !== "all") {
    where.push("UPPER(COALESCE(c.country,'ZZ'))=?");
    params.push(countryFilter.toUpperCase());
  }

  if (typeof builtByUserId === "number") {
    where.push("c.built_by_user_id=?");
    params.push(builtByUserId);
  }

  if (requireBuildOwner) {
    where.push("c.built_by_user_id IS NOT NULL");
  }

  if (Array.isArray(allowedClientIds)) {
    if (allowedClientIds.length === 0) {
      where.push("1=0");
    } else {
      where.push(`c.id IN (${allowedClientIds.map(() => "?").join(",")})`);
      params.push(...allowedClientIds);
    }
  }

  if (Array.isArray(deniedClientIds) && deniedClientIds.length > 0) {
    where.push(`c.id NOT IN (${deniedClientIds.map(() => "?").join(",")})`);
    params.push(...deniedClientIds);
  }

  if (groupFilter && groupFilter !== "all") {
    if (groupFilter === "none") {
      where.push("c.group_id IS NULL");
    } else {
      const gid = Number(groupFilter);
      if (Number.isFinite(gid)) {
        where.push("c.group_id=?");
        params.push(gid);
      }
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const needsGroupJoinForFilter =
    sort === "group_asc" ||
    sort === "group_desc" ||
    (groupFilter !== undefined && groupFilter !== "all");

  const orderBy = (() => {
    const online = "c.online DESC";
    const bookmark = "c.bookmarked DESC";
    switch (sort) {
      case "stable":
        return `ORDER BY ${online}, ${bookmark}, c.id ASC`;
      case "ping_asc":
        return `ORDER BY ${online}, ${bookmark}, c.ping_ms IS NULL, c.ping_ms ASC, c.id ASC`;
      case "ping_desc":
        return `ORDER BY ${online}, ${bookmark}, c.ping_ms IS NULL, c.ping_ms DESC, c.id ASC`;
      case "host_asc":
        return `ORDER BY ${online}, ${bookmark}, LOWER(COALESCE(c.nickname, c.host)) ASC, c.id ASC`;
      case "host_desc":
        return `ORDER BY ${online}, ${bookmark}, LOWER(COALESCE(c.nickname, c.host)) DESC, c.id ASC`;
      case "country_asc":
        return `ORDER BY ${online}, ${bookmark}, LOWER(COALESCE(c.country, 'zz')) ASC, c.id ASC`;
      case "country_desc":
        return `ORDER BY ${online}, ${bookmark}, LOWER(COALESCE(c.country, 'zz')) DESC, c.id ASC`;
      case "admin_first":
        return `ORDER BY ${online}, ${bookmark}, c.is_admin DESC, c.id ASC`;
      case "group_asc":
        return `ORDER BY ${online}, ${bookmark}, g.name IS NULL, LOWER(g.name) ASC, c.id ASC`;
      case "group_desc":
        return `ORDER BY ${online}, ${bookmark}, g.name IS NULL, LOWER(g.name) DESC, c.id ASC`;
      default:
        return `ORDER BY ${online}, ${bookmark}, c.last_seen DESC, c.id ASC`;
    }
  })();

  const offset = (page - 1) * pageSize;

  const clientFields =
    "c.id, c.hwid, c.role, c.ip, c.host, c.os, c.arch, c.version, c.user, c.nickname, c.custom_tag as customTag, c.custom_tag_note as customTagNote, c.monitors, c.country, c.last_seen as lastSeen, c.online, c.ping_ms as pingMs, c.bookmarked, c.build_tag as buildTag, c.built_by_user_id as builtByUserId, c.enrollment_status as enrollmentStatus, c.public_key as publicKey, c.key_fingerprint as keyFingerprint, c.cpu, c.gpu, c.ram, c.battery_percent as batteryPercent, c.battery_charging as batteryCharging, c.is_admin as isAdmin, c.elevation, c.permissions, c.disconnect_reason as disconnectReason, c.disconnect_detail as disconnectDetail, c.group_id as groupId, c.notifications_muted as notificationsMuted, c.deny_reason as denyReason";

  let rows: any[] | undefined;
  let totalCount = 0;
  let onlineCount = 0;

  if (search) {
    const searchWhere = [...where];
    const searchParams = [...params];
    const candidateLimit = Math.min(5000, Math.max(1000, offset + pageSize * 8));
    const ftsCandidateIds = getFtsClientSearchCandidateIds(search, candidateLimit);

    if (ftsCandidateIds) {
      if (!ftsCandidateIds.length) {
        rows = [];
        totalCount = 0;
        onlineCount = 0;
      } else {
        searchWhere.push(`c.id IN (${ftsCandidateIds.map(() => "?").join(",")})`);
        searchParams.push(...ftsCandidateIds);
      }
    } else {
      const searchCandidate = buildFuzzyCandidateWhere(search);
      if (searchCandidate.sql) {
        searchWhere.push(searchCandidate.sql);
        searchParams.push(...searchCandidate.params);
      }
    }

    if (rows === undefined) {
      const searchWhereSql = searchWhere.length ? `WHERE ${searchWhere.join(" AND ")}` : "";
      const candidates = db
        .query<any>(
          `SELECT ${clientFields}, g.name as groupName, g.color as groupColor
           FROM clients c
           LEFT JOIN client_groups g ON g.id = c.group_id
           ${searchWhereSql}
           ${orderBy}`,
        )
        .all(...searchParams);
      const matches = fuzzySearchClientRows(candidates, search);
      totalCount = matches.length;
      onlineCount = matches.filter((row: any) => row.online === 1).length;
      rows = matches.slice(offset, offset + pageSize);
    }
  } else {
    const countJoinSql = needsGroupJoinForFilter ? "LEFT JOIN client_groups g ON g.id = c.group_id" : "";
    const totalRow = db
      .query<{ c: number }>(`SELECT COUNT(*) as c FROM clients c ${countJoinSql} ${whereSql}`)
      .get(...params) ?? { c: 0 };
    const onlineRow = db
      .query<{ c: number }>(
        `SELECT COUNT(*) as c FROM clients c ${countJoinSql} ${whereSql ? `${whereSql} AND c.online=1` : "WHERE c.online=1"}`,
      )
      .get(...params) ?? { c: 0 };
    totalCount = totalRow.c;
    onlineCount = onlineRow.c;

    rows = needsGroupJoinForFilter
      ? db
        .query<any>(
          `SELECT ${clientFields}, g.name as groupName, g.color as groupColor
           FROM clients c
           LEFT JOIN client_groups g ON g.id = c.group_id
           ${whereSql}
           ${orderBy}
           LIMIT ? OFFSET ?`,
        )
        .all(...params, pageSize, offset)
      : db
        .query<any>(
          `WITH page_clients AS (
             SELECT ${clientFields}
             FROM clients c
             ${whereSql}
             ${orderBy}
             LIMIT ? OFFSET ?
           )
           SELECT pc.*, g.name as groupName, g.color as groupColor
           FROM page_clients pc
           LEFT JOIN client_groups g ON g.id = pc.groupId`,
        )
        .all(...params, pageSize, offset);
  }

  const shouldScanSuspicious = !search && (SUSPICIOUS_SCAN_MAX_CLIENTS === 0 || totalCount <= SUSPICIOUS_SCAN_MAX_CLIENTS);
  const suspiciousSets = shouldScanSuspicious
    ? getFloodSetsWithCache()
    : { floodedHwids: new Set<string>(), floodedHardware: new Set<string>(), floodedIps: new Set<string>() };
  rows = rows || [];
  const thumbnailSummaries = getThumbnailSummaries(rows.map((row: any) => row.id));

  const items = rows.map((c: any) => {
    const thumbnail = thumbnailSummaries.get(c.id);
    return {
      id: c.id,
      hwid: c.hwid,
      role: (c.role as ClientRole) || "client",
      ip: c.ip || null,
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
      buildTag: c.buildTag || null,
      builtByUserId: typeof c.builtByUserId === "number" ? c.builtByUserId : null,
      enrollmentStatus: c.enrollmentStatus || "pending",
      publicKey: c.publicKey || null,
      keyFingerprint: c.keyFingerprint || null,
      cpu: c.cpu || null,
      gpu: c.gpu || null,
      ram: c.ram || null,
      batteryPercent: typeof c.batteryPercent === "number" ? c.batteryPercent : null,
      batteryCharging: c.batteryCharging === null || c.batteryCharging === undefined ? null : c.batteryCharging === 1,
      isAdmin: c.isAdmin === 1,
      elevation: c.elevation || null,
      permissions: c.permissions ? (() => { try { return JSON.parse(c.permissions); } catch { return null; } })() : null,
      disconnectReason: c.disconnectReason || null,
      disconnectDetail: c.disconnectDetail || null,
      groupId: typeof c.groupId === "number" ? c.groupId : null,
      groupName: c.groupName || null,
      groupColor: c.groupColor || null,
      notificationsMuted: c.notificationsMuted === 1,
      denyReason: c.denyReason || null,
      hasThumbnail: thumbnail?.hasThumbnail ?? false,
      thumbnailVersion: thumbnail?.thumbnailVersion ?? 0,
      suspiciousFlags: shouldScanSuspicious ? computeClientSuspiciousFlags(c, suspiciousSets) : [],
    };
  });

  return { page, pageSize, total: totalCount, online: onlineCount, items };
}

export type ClientMetricsSummary = {
  total: number;
  online: number;
  byOS: Record<string, number>;
  byCountry: Record<string, number>;
  byOSOnline: Record<string, number>;
  byCountryOnline: Record<string, number>;
};

const CLIENT_METRICS_SUMMARY_TTL_MS = 4_000;
let clientMetricsSummaryCache: { expiresAt: number; summary: ClientMetricsSummary } | null = null;
const userClientMetricsSummaryCache = new Map<number, { expiresAt: number; summary: ClientMetricsSummary }>();

function cloneClientMetricsSummary(summary: ClientMetricsSummary): ClientMetricsSummary {
  return {
    total: summary.total,
    online: summary.online,
    byOS: { ...summary.byOS },
    byCountry: { ...summary.byCountry },
    byOSOnline: { ...summary.byOSOnline },
    byCountryOnline: { ...summary.byCountryOnline },
  };
}

function makeClientMetricsSummary(
  counts: { total: number | null; online: number | null },
  osRows: { key: string; total: number; online: number | null }[],
  countryRows: { key: string; total: number; online: number | null }[],
): ClientMetricsSummary {
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

export function getClientMetricsSummary(): ClientMetricsSummary {
  const now = Date.now();
  if (clientMetricsSummaryCache && clientMetricsSummaryCache.expiresAt > now) {
    return cloneClientMetricsSummary(clientMetricsSummaryCache.summary);
  }

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

  const summary = makeClientMetricsSummary(counts, osRows, countryRows);
  clientMetricsSummaryCache = {
    expiresAt: now + CLIENT_METRICS_SUMMARY_TTL_MS,
    summary,
  };
  return cloneClientMetricsSummary(summary);
}

export function getClientMetricsSummaryForUser(userId: number): ClientMetricsSummary {
  const now = Date.now();
  const cached = userClientMetricsSummaryCache.get(userId);
  if (cached && cached.expiresAt > now) {
    return cloneClientMetricsSummary(cached.summary);
  }

  const filter = `WHERE built_by_user_id = ?`;

  const counts = db
    .query<{ total: number; online: number }>(
      `SELECT COUNT(*) as total, SUM(CASE WHEN online=1 THEN 1 ELSE 0 END) as online FROM clients ${filter}`,
    )
    .get(userId) ?? { total: 0, online: 0 };

  const osRows = db
    .query<{ key: string; total: number; online: number }>(
      `SELECT
         COALESCE(NULLIF(os, ''), 'unknown') as key,
         COUNT(*) as total,
         SUM(CASE WHEN online=1 THEN 1 ELSE 0 END) as online
       FROM clients ${filter}
       GROUP BY COALESCE(NULLIF(os, ''), 'unknown')`,
    )
    .all(userId);

  const countryRows = db
    .query<{ key: string; total: number; online: number }>(
      `SELECT
         COALESCE(NULLIF(country, ''), 'ZZ') as key,
         COUNT(*) as total,
         SUM(CASE WHEN online=1 THEN 1 ELSE 0 END) as online
       FROM clients ${filter}
       GROUP BY COALESCE(NULLIF(country, ''), 'ZZ')`,
    )
    .all(userId);

  const summary = makeClientMetricsSummary(counts, osRows, countryRows);
  userClientMetricsSummaryCache.set(userId, {
    expiresAt: now + CLIENT_METRICS_SUMMARY_TTL_MS,
    summary,
  });
  return cloneClientMetricsSummary(summary);
}

export function getOnlineClientCountForUser(userId: number): number {
  const row = db
    .query<{ online: number }>(
      `SELECT SUM(CASE WHEN online=1 THEN 1 ELSE 0 END) as online FROM clients WHERE built_by_user_id = ?`,
    )
    .get(userId);
  return Number(row?.online) || 0;
}

export function countBuildsForUser(userId: number): number {
  const row = db
    .query<{ c: number }>(`SELECT COUNT(*) as c FROM builds WHERE built_by_user_id = ?`)
    .get(userId);
  return row?.c ?? 0;
}

export function getOldestBuildForUser(userId: number): BuildRecord | null {
  const row = db
    .query<any>(`SELECT * FROM builds WHERE built_by_user_id = ? ORDER BY start_time ASC LIMIT 1`)
    .get(userId);
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

export function deleteInactiveSessions(userId: number): number {
  const now = Math.floor(Date.now() / 1000);
  const result = db.run(
    `DELETE FROM sessions WHERE user_id = ? AND (revoked = 1 OR expires_at <= ?)`,
    userId,
    now,
  );
  return result.changes;
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

export function setClientNotificationsMuted(id: string, muted: boolean): boolean {
  const result = db.run(
    `UPDATE clients SET notifications_muted=? WHERE id=?`,
    muted ? 1 : 0,
    id,
  );
  return ((result as any)?.changes || 0) > 0;
}

export function isClientNotificationsMuted(id: string): boolean {
  const row = db.query<{ notifications_muted: number }>(
    `SELECT notifications_muted FROM clients WHERE id=?`,
  ).get(id);
  return row?.notifications_muted === 1;
}

export interface BuildProfileRecord {
  userId: number;
  name: string;
  profileJson: string;
  createdAt: number;
  updatedAt: number;
}

export function listBuildProfilesForUser(userId: number): BuildProfileRecord[] {
  return db
    .query<any>(
      `SELECT user_id, name, profile_json, created_at, updated_at
       FROM build_profiles
       WHERE user_id = ?
       ORDER BY updated_at DESC, name ASC`,
    )
    .all(userId)
    .map((row: any) => ({
      userId: row.user_id,
      name: row.name,
      profileJson: row.profile_json,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
}

export function saveBuildProfileForUser(userId: number, name: string, profileJson: string): void {
  const now = Date.now();
  db.run(
    `INSERT INTO build_profiles (user_id, name, profile_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, name) DO UPDATE SET
       profile_json = excluded.profile_json,
       updated_at = excluded.updated_at`,
    userId,
    name,
    profileJson,
    now,
    now,
  );
}

export function deleteBuildProfileForUser(userId: number, name: string): boolean {
  const result = db.run(
    `DELETE FROM build_profiles WHERE user_id = ? AND name = ?`,
    userId,
    name,
  );
  return ((result as any)?.changes || 0) > 0;
}

export interface SavedScriptRecord {
  id: string;
  userId: number;
  name: string;
  content: string;
  scriptType: string;
  createdAt: number;
  updatedAt: number;
}

export function listSavedScriptsForUser(userId: number): SavedScriptRecord[] {
  return db
    .query<any>(
      `SELECT id, user_id, name, content, script_type, created_at, updated_at
       FROM saved_scripts
       WHERE user_id = ?
       ORDER BY updated_at DESC`,
    )
    .all(userId)
    .map((row: any) => ({
      id: row.id,
      userId: row.user_id,
      name: row.name,
      content: row.content,
      scriptType: row.script_type,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
}

export function saveSavedScript(
  id: string,
  userId: number,
  name: string,
  content: string,
  scriptType: string,
): SavedScriptRecord | null {
  const owner = db
    .query<{ user_id: number }>(
      `SELECT user_id FROM saved_scripts WHERE id = ?`,
    )
    .get(id);
  if (owner && owner.user_id !== userId) {
    return null;
  }
  const now = Date.now();
  db.run(
    `INSERT INTO saved_scripts (id, user_id, name, content, script_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       content = excluded.content,
       script_type = excluded.script_type,
       updated_at = excluded.updated_at
     WHERE saved_scripts.user_id = excluded.user_id`,
    id,
    userId,
    name,
    content,
    scriptType,
    now,
    now,
  );
  return { id, userId, name, content, scriptType, createdAt: now, updatedAt: now };
}

export function deleteSavedScript(userId: number, scriptId: string): boolean {
  const result = db.run(
    `DELETE FROM saved_scripts WHERE id = ? AND user_id = ?`,
    scriptId,
    userId,
  );
  return ((result as any)?.changes || 0) > 0;
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
  blocked?: boolean;
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

function mapBuildRow(row: any): BuildRecord {
  return {
    id: row.id,
    status: row.status,
    startTime: row.start_time,
    expiresAt: row.expires_at,
    files: JSON.parse(row.files),
    buildTag: row.build_tag || undefined,
    builtByUserId: row.built_by_user_id || undefined,
    blocked: row.blocked === 1,
  };
}

export function getBuild(id: string): BuildRecord | null {
  const row = db.query<any>(`SELECT * FROM builds WHERE id = ?`).get(id);
  if (!row) return null;
  return mapBuildRow(row);
}

export function getBuildByTag(buildTag: string): BuildRecord | null {
  const row = db.query<any>(`SELECT * FROM builds WHERE build_tag = ?`).get(buildTag);
  if (!row) return null;
  return mapBuildRow(row);
}

export function isBuildTagBlocked(buildTag: string): boolean {
  if (!buildTag) return false;
  const row = db.query<{ blocked: number }>(
    `SELECT blocked FROM builds WHERE build_tag = ?`,
  ).get(buildTag);
  return !!row && row.blocked === 1;
}

export function setBuildBlocked(buildId: string, blocked: boolean): boolean {
  const result = db.run(
    `UPDATE builds SET blocked = ? WHERE id = ?`,
    blocked ? 1 : 0,
    buildId,
  );
  return ((result as any)?.changes || 0) > 0;
}

export function listClientIdsByBuildTag(buildTag: string): string[] {
  if (!buildTag) return [];
  const rows = db.query<{ id: string }>(
    `SELECT id FROM clients WHERE build_tag = ?`,
  ).all(buildTag);
  return rows.map((r) => r.id);
}

export function recordBuildClaim(buildId: string, keyFingerprint: string): boolean {
  if (!buildId || !keyFingerprint) return false;
  try {
    const result = db.run(
      `INSERT OR IGNORE INTO build_claims (build_id, key_fingerprint, claimed_at) VALUES (?, ?, ?)`,
      buildId,
      keyFingerprint,
      Date.now(),
    );
    return ((result as any)?.changes || 0) > 0;
  } catch {
    return false;
  }
}

/** Number of distinct agent fingerprints that have ever claimed this build's tag. */
export function countBuildClaims(buildId: string): number {
  if (!buildId) return 0;
  const row = db.query<{ count: number }>(
    `SELECT COUNT(*) as count FROM build_claims WHERE build_id = ?`,
  ).get(buildId);
  return row?.count ?? 0;
}

/** Batch helper — returns Map<buildId, claimCount> for the given build IDs. */
export function countBuildClaimsBatch(buildIds: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (buildIds.length === 0) return out;
  // SQLite has a host-parameter limit (~999 by default); chunk to be safe.
  for (let i = 0; i < buildIds.length; i += 500) {
    const chunk = buildIds.slice(i, i + 500);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db.query<{ build_id: string; count: number }>(
      `SELECT build_id, COUNT(*) as count FROM build_claims WHERE build_id IN (${placeholders}) GROUP BY build_id`,
    ).all(...chunk);
    for (const r of rows) out.set(r.build_id, r.count);
  }
  // Ensure every requested ID is in the map (default 0).
  for (const id of buildIds) if (!out.has(id)) out.set(id, 0);
  return out;
}

export function getAllBuilds(userId?: number, role?: string): BuildRecord[] {
  if (role !== undefined && role !== "admin") {
    if (userId == null) {
      return [];
    }
    const rows = db
      .query<any>(`SELECT * FROM builds WHERE built_by_user_id = ? ORDER BY start_time DESC`)
      .all(userId);
    return rows.map(mapBuildRow);
  }
  const rows = db
    .query<any>("SELECT * FROM builds ORDER BY start_time DESC")
    .all();
  return rows.map(mapBuildRow);
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

export type NotificationRow = {
  id: string;
  clientId: string;
  host?: string;
  user?: string;
  os?: string;
  title: string;
  process?: string;
  processPath?: string;
  pid?: number;
  keyword?: string;
  category: string;
  ts: number;
  screenshotId?: string;
};

export function saveNotification(record: NotificationRow) {
  db.run(
    `INSERT OR REPLACE INTO notifications
      (id, client_id, host, user, os, title, process, process_path, pid, keyword, category, ts, screenshot_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    record.id,
    record.clientId,
    record.host ?? null,
    record.user ?? null,
    record.os ?? null,
    record.title,
    record.process ?? null,
    record.processPath ?? null,
    record.pid ?? null,
    record.keyword ?? null,
    record.category,
    record.ts,
    record.screenshotId ?? null,
  );
}

export function updateNotificationScreenshotId(notificationId: string, screenshotId: string) {
  db.run(
    `UPDATE notifications SET screenshot_id = ? WHERE id = ?`,
    screenshotId,
    notificationId,
  );
}

export function getNotificationHistory(limit: number = 500): NotificationRow[] {
  const rows = db
    .query<any>(`SELECT * FROM notifications ORDER BY ts DESC LIMIT ?`)
    .all(limit);
  return rows.map((row: any) => ({
    id: row.id,
    clientId: row.client_id,
    host: row.host ?? undefined,
    user: row.user ?? undefined,
    os: row.os ?? undefined,
    title: row.title,
    process: row.process ?? undefined,
    processPath: row.process_path ?? undefined,
    pid: row.pid ?? undefined,
    keyword: row.keyword ?? undefined,
    category: row.category,
    ts: row.ts,
    screenshotId: row.screenshot_id ?? undefined,
  }));
}

const NOTIFICATION_RETENTION_DAYS = 3;
const NOTIFICATION_RETENTION_MS = NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export function pruneOldNotifications() {
  const cutoff = Date.now() - NOTIFICATION_RETENTION_MS;
  db.run(`DELETE FROM notification_screenshots WHERE notification_id IN (SELECT id FROM notifications WHERE ts < ?)`, cutoff);
  db.run(`DELETE FROM notification_screenshots WHERE ts < ?`, cutoff);
  db.run(`DELETE FROM notification_screenshots WHERE notification_id NOT IN (SELECT id FROM notifications)`);
  const result = db.run(`DELETE FROM notifications WHERE ts < ?`, cutoff);
  if (result.changes > 0) {
    console.log(`[db] pruned ${result.changes} notifications older than ${NOTIFICATION_RETENTION_DAYS} days`);
  }
}

export function clearNotifications() {
  db.run(`DELETE FROM notifications`);
  db.run(`DELETE FROM notification_screenshots`);
  console.log("[db] cleared all notifications and screenshots");
}

export function deleteNotificationsForClient(clientId: string): number {
  db.run(`DELETE FROM notification_screenshots WHERE client_id = ?`, clientId);
  const result = db.run(`DELETE FROM notifications WHERE client_id = ?`, clientId);
  return (result as any)?.changes || 0;
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
  denyReason?: string,
): boolean {
  const result = db.run(
    `UPDATE clients SET enrollment_status=?, enrolled_at=?, enrolled_by=?, deny_reason=? WHERE id=?`,
    status,
    status === "approved" ? Date.now() : null,
    status === "approved" ? (approvedBy ?? null) : null,
    status === "denied" ? (denyReason ?? null) : null,
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

export function getEnrollmentStats(opts?: {
  allowedClientIds?: string[];
  deniedClientIds?: string[];
  builtByUserId?: number;
  requireBuildOwner?: boolean;
}): {
  pending: number;
  approved: number;
  denied: number;
} {
  let sql = `SELECT COALESCE(enrollment_status,'pending') as status, COUNT(*) as c FROM clients`;
  const params: any[] = [];

  const where: string[] = [];
  if (opts?.allowedClientIds) {
    if (opts.allowedClientIds.length === 0) return { pending: 0, approved: 0, denied: 0 };
    const placeholders = opts.allowedClientIds.map(() => "?").join(",");
    where.push(`id IN (${placeholders})`);
    params.push(...opts.allowedClientIds);
  }
  if (opts?.deniedClientIds && opts.deniedClientIds.length > 0) {
    const placeholders = opts.deniedClientIds.map(() => "?").join(",");
    where.push(`id NOT IN (${placeholders})`);
    params.push(...opts.deniedClientIds);
  }
  if (typeof opts?.builtByUserId === "number") {
    where.push("built_by_user_id = ?");
    params.push(opts.builtByUserId);
  }
  if (opts?.requireBuildOwner) {
    where.push("built_by_user_id IS NOT NULL");
  }

  if (where.length > 0) {
    sql += ` WHERE ${where.join(" AND ")}`;
  }

  sql += ` GROUP BY enrollment_status`;

  const rows = db.query<{ status: string; c: number }>(sql).all(...params);
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

export function deletePushSubscriptionForUser(userId: number, endpoint: string): boolean {
  const result = db.run(
    `DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?`,
    endpoint,
    userId,
  );
  return ((result as any)?.changes || 0) > 0;
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

export function getPendingClients(opts?: {
  allowedClientIds?: string[];
  deniedClientIds?: string[];
  builtByUserId?: number;
  requireBuildOwner?: boolean;
}): {
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
  let sql = `SELECT id, host, os, user, ip, country, public_key as publicKey, key_fingerprint as keyFingerprint, last_seen as lastSeen
       FROM clients WHERE (enrollment_status='pending' OR enrollment_status IS NULL)`;
  const params: any[] = [];

  if (opts?.allowedClientIds) {
    if (opts.allowedClientIds.length === 0) return [];
    const placeholders = opts.allowedClientIds.map(() => "?").join(",");
    sql += ` AND id IN (${placeholders})`;
    params.push(...opts.allowedClientIds);
  }
  if (opts?.deniedClientIds && opts.deniedClientIds.length > 0) {
    const placeholders = opts.deniedClientIds.map(() => "?").join(",");
    sql += ` AND id NOT IN (${placeholders})`;
    params.push(...opts.deniedClientIds);
  }
  if (typeof opts?.builtByUserId === "number") {
    sql += ` AND built_by_user_id = ?`;
    params.push(opts.builtByUserId);
  }
  if (opts?.requireBuildOwner) {
    sql += ` AND built_by_user_id IS NOT NULL`;
  }

  sql += ` ORDER BY last_seen DESC`;

  return db
    .query<any>(sql)
    .all(...params)
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

export function getClientBuildOwnership(
  id: string,
): { buildTag: string | null; builtByUserId: number | null } | null {
  const row = db
    .query<{ build_tag: string | null; built_by_user_id: number | null }>(
      `SELECT build_tag, built_by_user_id FROM clients WHERE id=?`,
    )
    .get(id);
  if (!row) return null;
  return {
    buildTag: row.build_tag ?? null,
    builtByUserId:
      typeof row.built_by_user_id === "number" ? row.built_by_user_id : null,
  };
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

export function getDatabaseFileSizeBytes(): number {
  try {
    return Bun.file(dbPath).size;
  } catch {
    return 0;
  }
}

