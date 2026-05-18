let _sharp: any = null;
let _sharpLoadAttempted = false;

async function getSharp(): Promise<any> {
  if (_sharp) return _sharp;
  if (_sharpLoadAttempted) throw new Error("sharp module unavailable");
  _sharpLoadAttempted = true;
  try {
    _sharp = (await import("sharp")).default as any;
    return _sharp!;
  } catch (err) {
    console.error("[thumbnails] Failed to load sharp module. Thumbnails will be unavailable.", err);
    throw err;
  }
}

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

type ThumbnailRecord = {
  bytes: Uint8Array;
  contentType: string;
  version: number;
  updatedAt: number;
};

const thumbnails = new Map<string, ThumbnailRecord>();
const latestFrames = new Map<string, { bytes: Uint8Array; format: string; capturedAt: number }>();
const thumbnailRequests = new Map<string, number>();

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

  const sharp = await getSharp();
  const output = await sharp(Buffer.from(bytes), { failOn: "none" })
    .rotate()
    .resize({
      width: THUMBNAIL_WIDTH,
      height: THUMBNAIL_HEIGHT,
      fit: "inside",
      withoutEnlargement: true,
      fastShrinkOnLoad: true,
    })
    .webp({ quality: THUMBNAIL_QUALITY })
    .toBuffer();

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
    if (prior) thumbnails.delete(id);
    thumbnails.set(id, {
      bytes: out,
      contentType: "image/webp",
      version: (prior?.version ?? 0) + 1,
      updatedAt: now,
    });
    evictThumbnailsIfFull();
    latestFrames.delete(id);
    return true;
  } catch (err) {
    console.error(`[thumbnails] Failed to generate thumbnail for client ${id}:`, err);
    return false;
  }
}

export function markThumbnailRequested(id: string) {
  thumbnailRequests.set(id, Date.now());
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
