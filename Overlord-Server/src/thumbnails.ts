let _sharp: typeof import("sharp") extends { default: infer D } ? D : never;
async function getSharp() {
  if (!_sharp) {
    _sharp = (await import("sharp")).default;
  }
  return _sharp;
}

const THUMBNAIL_WIDTH = Math.max(64, Number(process.env.OVERLORD_THUMBNAIL_WIDTH || 640));
const THUMBNAIL_HEIGHT = Math.max(48, Number(process.env.OVERLORD_THUMBNAIL_HEIGHT || 360));
const THUMBNAIL_QUALITY = Math.min(90, Math.max(40, Number(process.env.OVERLORD_THUMBNAIL_QUALITY || 72)));
const MAX_THUMBNAIL_SOURCE_BYTES = Math.max(
  256 * 1024,
  Number(process.env.OVERLORD_THUMBNAIL_MAX_SOURCE_BYTES || 16 * 1024 * 1024),
);

const thumbnails = new Map<string, string>();
const latestFrames = new Map<string, { bytes: Uint8Array; format: string; capturedAt: number }>();
const thumbnailRequests = new Map<string, number>();

export function setThumbnail(id: string, dataUrl: string) {
  thumbnails.set(id, dataUrl);
}

export function getThumbnail(id: string) {
  return thumbnails.get(id) ?? null;
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

async function buildThumbnailDataUrl(bytes: Uint8Array, format: string): Promise<string | null> {
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

  return `data:image/webp;base64,${output.toString("base64")}`;
}

export async function generateThumbnail(id: string): Promise<boolean> {
  const frameData = latestFrames.get(id);
  if (!frameData) {
    return false;
  }

  try {
    const dataUrl = await buildThumbnailDataUrl(frameData.bytes, frameData.format);
    if (!dataUrl) {
      return false;
    }
    thumbnails.set(id, dataUrl);
    latestFrames.delete(id);
    return true;
  } catch {
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
