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
import { metrics } from "./metrics";
import { flushQueuedClientDbUpdates, queueClientDbUpdate, shouldSyncClientToDb } from "./client-db-sync";
import { setClientDisconnectInfo } from "./db";

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
  const lastCrashReason = sanitizeInfoString((payload as any).lastCrashReason, 64);
  const lastCrashDetail = sanitizeInfoString((payload as any).lastCrashDetail, 1200);

  queueClientDbUpdate({
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
  if (lastCrashReason) {
    flushQueuedClientDbUpdates();
    setClientDisconnectInfo(info.id, lastCrashReason, lastCrashDetail);
  }

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
  const ts = typeof payload.ts === "number" && Number.isFinite(payload.ts)
    ? payload.ts
    : Date.now();
  ws.send(encodeMessage({ type: "pong", ts }));
}

export function sendPingRequest(
  info: ClientInfo,
  ws: any,
  reason: string,
  minIntervalMs = 1_000,
): boolean {
  const now = Date.now();
  if (minIntervalMs > 0 && info.lastPingSent && now - info.lastPingSent < minIntervalMs) {
    return false;
  }
  const nonce = now + Math.floor(Math.random() * 1000);
  info.lastPingSent = now;
  info.lastPingNonce = nonce;
  //console.log(`[ping] send ping to client=${info.id} reason=${reason} nonce=${nonce}`);
  ws.send(encodeMessage({ type: "ping", ts: nonce }));
  return true;
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
    if (shouldSyncClientToDb(info.id, nowTs)) {
      queueClientDbUpdate({
        id: info.id,
        pingMs: info.pingMs,
        lastSeen: info.lastSeen,
        online: 1,
        isAdmin: info.isAdmin,
      });
    }

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

export function handleScreenshotThumbnailResult(info: ClientInfo, payload: any): boolean {
  const requested = isThumbnailRequested(info.id);
  if (!requested || payload?.error) return false;

  let bytes: Uint8Array | null = null;
  if (payload?.data instanceof Uint8Array) {
    bytes = payload.data;
  } else if (payload?.data instanceof ArrayBuffer) {
    bytes = new Uint8Array(payload.data);
  } else if (ArrayBuffer.isView(payload?.data)) {
    bytes = new Uint8Array(payload.data.buffer, payload.data.byteOffset, payload.data.byteLength);
  }
  if (!bytes?.byteLength) return false;

  const rawFormat = String(payload?.format || "jpeg").toLowerCase();
  const format = rawFormat === "jpg" ? "jpeg" : rawFormat;
  if (format !== "jpeg" && format !== "webp") return false;

  setLatestFrame(info.id, bytes, format);
  void requestThumbnailRegen(info.id).then((ok) => {
    if (ok) notifyThumbnailGenerated(info.id);
  });
  return true;
}

export function shouldRelayFrameToViewers(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || !("header" in payload)) return false;
  const header = payload.header;
  if (!header || typeof header !== "object" || !("fps" in header)) return false;
  return Number(header.fps) > 0;
}

export function handleFrame(info: ClientInfo, payload: unknown, relayToViewers = true): boolean {
  const frame = payload && typeof payload === "object"
    ? payload as Record<string, unknown>
    : {};
  const rawData = frame.data;
  const bytes = rawData instanceof Uint8Array
    ? rawData
    : rawData instanceof ArrayBuffer
      ? new Uint8Array(rawData)
      : new Uint8Array();
  const header = frame.header && typeof frame.header === "object"
    ? frame.header as Record<string, unknown>
    : {};
  const allowedFormats = ["jpeg", "jpg", "webp"];
  const fmt = String(header.format || "").toLowerCase();
  const safeFormat = allowedFormats.includes(fmt) ? fmt : "";

  metrics.recordBytesReceived(bytes.length);

  let handledByViewerRelay = false;
  if (relayToViewers) {
    try {
      const runtime = globalThis as unknown as {
        __webcamBroadcast?: (clientId: string, data: Uint8Array, frameHeader: Record<string, unknown>) => boolean;
        __backstageBroadcast?: (clientId: string, data: Uint8Array, frameHeader: Record<string, unknown>) => boolean;
        __rdBroadcast?: (clientId: string, data: Uint8Array, frameHeader: Record<string, unknown>) => boolean;
      };
      if (header.webcam) {
        handledByViewerRelay = runtime.__webcamBroadcast?.(info.id, bytes, header) ?? false;
      } else if (header.backstage) {
        handledByViewerRelay = runtime.__backstageBroadcast?.(info.id, bytes, header) ?? false;
      } else {
        handledByViewerRelay = runtime.__rdBroadcast?.(info.id, bytes, header) ?? false;
      }
    } catch {}
  }

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
  return handledByViewerRelay || safeFormat !== "";
}
