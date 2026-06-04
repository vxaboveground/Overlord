const THUMBNAIL_WIDTH = Math.max(64, Number(process.env.OVERLORD_THUMBNAIL_WIDTH || 1920));
const THUMBNAIL_HEIGHT = Math.max(48, Number(process.env.OVERLORD_THUMBNAIL_HEIGHT || 1080));
const THUMBNAIL_QUALITY = Math.min(95, Math.max(40, Number(process.env.OVERLORD_THUMBNAIL_QUALITY || 88)));
const MAX_THUMBNAIL_SOURCE_BYTES = Math.max(
  256 * 1024,
  Number(process.env.OVERLORD_THUMBNAIL_MAX_SOURCE_BYTES || 16 * 1024 * 1024),
);
const THUMBNAIL_CACHE_MAX = Math.max(
  64,
  Number(process.env.OVERLORD_THUMBNAIL_CACHE_MAX || 2000),
);
const MAX_CONCURRENT_THUMBNAIL_GEN = Math.max(
  1,
  Number(process.env.OVERLORD_THUMBNAIL_CONCURRENCY || 4),
);
let _activeThumbnailGen = 0;
const _thumbnailGenQueue: Array<() => void> = [];

function withThumbnailSlot<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      _activeThumbnailGen++;
      fn().then(resolve, reject).finally(() => {
        _activeThumbnailGen--;
        const next = _thumbnailGenQueue.shift();
        if (next) next();
      });
    };
    if (_activeThumbnailGen < MAX_CONCURRENT_THUMBNAIL_GEN) {
      run();
    } else {
      _thumbnailGenQueue.push(run);
    }
  });
}

type ThumbnailRecord = {
  bytes: Uint8Array;
  contentType: string;
  version: number;
  updatedAt: number;
};

const thumbnails = new Map<string, ThumbnailRecord>();
const latestFrames = new Map<string, { bytes: Uint8Array; format: string; capturedAt: number }>();
const thumbnailRequests = new Map<string, number>();
const thumbnailVersionHWM = new Map<string, number>();

function touchThumbnailLRU(id: string) {
  const existing = thumbnails.get(id);
  if (!existing) return;
  thumbnails.delete(id);
  thumbnails.set(id, existing);
}

function evictThumbnailsIfFull() {
  while (thumbnails.size > THUMBNAIL_CACHE_MAX) {
    const oldestKey = thumbnails.keys().next().value;
    if (oldestKey === undefined) break;
    thumbnails.delete(oldestKey);
  }
}

export function hasThumbnail(id: string): boolean {
  return thumbnails.has(id);
}

export function getThumbnailRecord(id: string): ThumbnailRecord | null {
  const rec = thumbnails.get(id);
  if (!rec) return null;
  touchThumbnailLRU(id);
  return rec;
}

export function getThumbnailVersion(id: string): number {
  return thumbnails.get(id)?.version ?? 0;
}

export type ThumbnailSummary = {
  hasThumbnail: boolean;
  thumbnailVersion: number;
};

export function getThumbnailSummaries(ids: readonly string[]): Map<string, ThumbnailSummary> {
  const summaries = new Map<string, ThumbnailSummary>();
  for (const id of ids) {
    const thumbnail = thumbnails.get(id);
    summaries.set(id, {
      hasThumbnail: !!thumbnail,
      thumbnailVersion: thumbnail?.version ?? 0,
    });
  }
  return summaries;
}

export function clearThumbnail(id: string) {
  thumbnails.delete(id);
  latestFrames.delete(id);
  thumbnailRequests.delete(id);
}

export function setLatestFrame(id: string, bytes: Uint8Array, format: string) {
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_THUMBNAIL_SOURCE_BYTES) {
    latestFrames.delete(id);
    return;
  }
  latestFrames.set(id, { bytes, format, capturedAt: Date.now() });
}

async function buildThumbnailBytes(bytes: Uint8Array, format: string): Promise<Uint8Array | null> {
  if (!bytes || bytes.byteLength === 0) {
    return null;
  }

  const inputFormat = format === "jpg" ? "jpeg" : format;
  if (!["jpeg", "webp"].includes(inputFormat)) {
    return null;
  }

  if (typeof Bun.Image !== "function") {
    return null;
  }

  const output = await new Bun.Image(bytes, {
    autoOrient: true,
    maxPixels: THUMBNAIL_WIDTH * THUMBNAIL_HEIGHT * 16,
  })
    .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: THUMBNAIL_QUALITY })
    .bytes();

  return new Uint8Array(output);
}

export async function generateThumbnail(id: string): Promise<boolean> {
  const frameData = latestFrames.get(id);
  if (!frameData) {
    return false;
  }

  try {
    const out = await buildThumbnailBytes(frameData.bytes, frameData.format);
    if (!out) {
      return false;
    }
    const prior = thumbnails.get(id);
    const now = Date.now();
    const hwm = thumbnailVersionHWM.get(id) ?? (prior?.version ?? 0);
    const newVersion = hwm + 1;
    thumbnailVersionHWM.set(id, newVersion);
    if (prior) thumbnails.delete(id);
    thumbnails.set(id, {
      bytes: out,
      contentType: "image/webp",
      version: newVersion,
      updatedAt: now,
    });
    evictThumbnailsIfFull();
    if (latestFrames.get(id) === frameData) {
      latestFrames.delete(id);
    }
    return true;
  } catch (err) {
    if (typeof Bun.Image === "function") {
      console.error(`[thumbnails] Failed to generate thumbnail for client ${id}:`, err);
    }
    return false;
  }
}

const thumbnailGenState = new Map<string, { inFlight: boolean; pending: boolean }>();

export async function requestThumbnailRegen(id: string): Promise<boolean> {
  let state = thumbnailGenState.get(id);
  if (!state) {
    state = { inFlight: false, pending: false };
    thumbnailGenState.set(id, state);
  }
  if (state.inFlight) {
    state.pending = true;
    return false;
  }
  state.inFlight = true;
  let didGenerate = false;
  try {
    await withThumbnailSlot(async () => {
      while (true) {
        state!.pending = false;
        const ok = await generateThumbnail(id);
        if (ok) didGenerate = true;
        if (!state!.pending) break;
      }
    });
  } finally {
    state.inFlight = false;
    if (thumbnailGenState.get(id) === state && !state.pending) {
      thumbnailGenState.delete(id);
    }
  }
  return didGenerate;
}

export function markThumbnailRequested(id: string) {
  thumbnailRequests.set(id, Date.now());
}

export function isThumbnailRequested(id: string, windowMs = 5000): boolean {
  const ts = thumbnailRequests.get(id);
  if (!ts) return false;
  if (Date.now() - ts > windowMs) {
    thumbnailRequests.delete(id);
    return false;
  }
  return true;
}

export function clearThumbnailRequest(id: string) {
  thumbnailRequests.delete(id);
}

export function getThumbnailStats(): {
  cachedCount: number;
  cachedBytes: number;
  pendingFrames: number;
  genActive: number;
  genQueued: number;
  genStateTracked: number;
  cacheMax: number;
} {
  let cachedBytes = 0;
  for (const rec of thumbnails.values()) cachedBytes += rec.bytes.byteLength;
  return {
    cachedCount: thumbnails.size,
    cachedBytes,
    pendingFrames: latestFrames.size,
    genActive: _activeThumbnailGen,
    genQueued: _thumbnailGenQueue.length,
    genStateTracked: thumbnailGenState.size,
    cacheMax: THUMBNAIL_CACHE_MAX,
  };
}

export function consumeThumbnailRequest(id: string, windowMs = 5000): boolean {
  const ts = thumbnailRequests.get(id);
  if (!ts) return false;
  if (Date.now() - ts > windowMs) {
    thumbnailRequests.delete(id);
    return false;
  }
  thumbnailRequests.delete(id);
  return true;
}

const thumbnailWaiters = new Map<string, Set<() => void>>();

export function notifyThumbnailGenerated(id: string) {
  const waiters = thumbnailWaiters.get(id);
  if (!waiters) return;
  thumbnailWaiters.delete(id);
  for (const cb of waiters) {
    try { cb(); } catch {}
  }
}

export function waitForThumbnail(id: string, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let callback: () => void;
    const finish = (fresh: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const set = thumbnailWaiters.get(id);
      if (set) {
        set.delete(callback);
        if (set.size === 0) thumbnailWaiters.delete(id);
      }
      resolve(fresh);
    };
    callback = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    let set = thumbnailWaiters.get(id);
    if (!set) {
      set = new Set();
      thumbnailWaiters.set(id, set);
    }
    set.add(callback);
  });
}
