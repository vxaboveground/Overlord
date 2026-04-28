let _sharp: (typeof import("sharp") extends { default: infer D } ? D : never) | null = null;
let _sharpLoadAttempted = false;

async function getSharp(): Promise<typeof import("sharp") extends { default: infer D } ? D : never> {
  if (_sharp) return _sharp;
  if (_sharpLoadAttempted) throw new Error("sharp module unavailable");
  _sharpLoadAttempted = true;
  try {
    _sharp = (await import("sharp")).default as any;
    return _sharp!;
  } catch (bareErr) {
    try {
      const { createRequire } = await import("node:module");
      const path = await import("node:path");
      const root = process.env.OVERLORD_ROOT || process.cwd();
      const req = createRequire(path.join(root, "noop.js"));
      const candidates = [
        path.join(root, "node_modules", "sharp"),
        "sharp",
      ];
      let lastErr: unknown = bareErr;
      for (const id of candidates) {
        try {
          const mod = req(id);
          _sharp = (mod && (mod.default ?? mod)) as any;
          return _sharp!;
        } catch (err) {
          lastErr = err;
        }
      }
      console.error("[thumbnails] Failed to load sharp module. Thumbnails will be unavailable.", lastErr);
      throw lastErr;
    } catch (err) {
      console.error("[thumbnails] Failed to load sharp module. Thumbnails will be unavailable.", err);
      throw err;
    }
  }
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
