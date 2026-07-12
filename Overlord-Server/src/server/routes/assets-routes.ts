import path from "path";
import { getConfig } from "../../config";
import { getBrandingImage } from "../../db";

type AssetsRouteDeps = {
  PUBLIC_ROOT: string;
  secureHeaders: (contentType?: string) => Record<string, string>;
  mimeType: (path: string) => string;
};

const COMPRESSIBLE_TYPES = new Set(["text/html", "text/css", "text/javascript", "application/json", "image/svg+xml"]);

function isCompressible(contentType: string): boolean {
  for (const t of COMPRESSIBLE_TYPES) {
    if (contentType.startsWith(t)) return true;
  }
  return false;
}

function acceptsGzip(req: Request): boolean {
  return (req.headers.get("accept-encoding") ?? "").includes("gzip");
}

const STATIC_ASSET_CACHE = "public, max-age=31536000, immutable";
const MUTABLE_ASSET_CACHE = "public, max-age=86400, stale-while-revalidate=604800";
const NO_CACHE = "no-cache";
const MAX_GZIP_CACHE_ENTRIES = 128;
const MAX_GZIP_CACHE_BYTES = 16 * 1024 * 1024;

type GzipCacheEntry = {
  bytes: ArrayBuffer;
  size: number;
};

const gzipAssetCache = new Map<string, GzipCacheEntry>();
let gzipAssetCacheBytes = 0;

function assetCacheControl(relativePath: string): string {
  if (relativePath === "custom.css") return NO_CACHE;
  if (relativePath === "notification-sw.js") return NO_CACHE;
  if (relativePath.endsWith(".min.js") || relativePath.endsWith(".min.css")) {
    return STATIC_ASSET_CACHE;
  }
  if (/\.(ico|png|jpg|jpeg|gif|webp|woff2?|ttf|eot|svg)$/.test(relativePath)) {
    return STATIC_ASSET_CACHE;
  }
  return MUTABLE_ASSET_CACHE;
}

function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function rememberCompressedAsset(cacheKey: string, bytes: Uint8Array): ArrayBuffer {
  const existing = gzipAssetCache.get(cacheKey);
  if (existing) {
    gzipAssetCacheBytes -= existing.size;
  }

  const cachedBytes = toExactArrayBuffer(bytes);
  gzipAssetCache.set(cacheKey, { bytes: cachedBytes, size: bytes.byteLength });
  gzipAssetCacheBytes += bytes.byteLength;

  while (
    gzipAssetCache.size > MAX_GZIP_CACHE_ENTRIES ||
    gzipAssetCacheBytes > MAX_GZIP_CACHE_BYTES
  ) {
    const oldestKey = gzipAssetCache.keys().next().value;
    if (!oldestKey) break;
    const oldest = gzipAssetCache.get(oldestKey);
    if (oldest) gzipAssetCacheBytes -= oldest.size;
    gzipAssetCache.delete(oldestKey);
  }

  return cachedBytes;
}

async function compressedResponse(
  cacheKey: string,
  file: ReturnType<typeof Bun.file>,
  headers: Record<string, string>,
): Promise<Response> {
  const cached = gzipAssetCache.get(cacheKey);
  if (cached) {
    gzipAssetCache.delete(cacheKey);
    gzipAssetCache.set(cacheKey, cached);
    return new Response(cached.bytes, {
      headers: { ...headers, "Content-Encoding": "gzip", "Vary": "Accept-Encoding" },
    });
  }

  const body = await file.arrayBuffer();
  if (body.byteLength < 1024) {
    return new Response(body, { headers });
  }

  const compressed = Bun.gzipSync(new Uint8Array(body));
  const compressedBody = rememberCompressedAsset(cacheKey, compressed);
  return new Response(compressedBody, {
    headers: { ...headers, "Content-Encoding": "gzip", "Vary": "Accept-Encoding" },
  });
}

export async function handleAssetsRoutes(
  req: Request,
  url: URL,
  deps: AssetsRouteDeps,
): Promise<Response | null> {
  if (req.method === "GET" && url.pathname === "/assets/custom.css") {
    const css = getConfig().appearance?.customCSS || "";
    return new Response(css, {
      headers: {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": NO_CACHE,
      },
    });
  }

  const brandingMatch = req.method === "GET" && url.pathname.match(/^\/api\/branding\/image\/(nav-logo|login-logo|hero-image|tab-icon|dashboard-background)$/);
  if (brandingMatch) {
    const image = getBrandingImage(brandingMatch[1]);
    if (!image) return new Response("Not found", { status: 404 });
    const etag = `\"${image.updatedAt.toString(36)}-${image.bytes.byteLength.toString(36)}\"`;
    const headers = {
      ...deps.secureHeaders(image.contentType),
      "Cache-Control": NO_CACHE,
      "ETag": etag,
    };
    if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
    return new Response(toExactArrayBuffer(image.bytes), { headers });
  }

  if (req.method === "GET" && url.pathname === "/favicon.ico") {
    const file = Bun.file(path.join(deps.PUBLIC_ROOT, "assets", "favicon.ico"));
    if (await file.exists()) {
      const headers = { ...deps.secureHeaders("image/x-icon"), "Cache-Control": STATIC_ASSET_CACHE };
      return new Response(file, { headers });
    }
    return new Response("Not found", { status: 404 });
  }

  const isAssets = req.method === "GET" && url.pathname.startsWith("/assets/");
  const isVendor = req.method === "GET" && url.pathname.startsWith("/vendor/");
  if (!isAssets && !isVendor) {
    return null;
  }

  let decodedPath = url.pathname;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  if (decodedPath.includes("\u0000")) {
    return new Response("Not found", { status: 404 });
  }

  const subdir = isVendor ? "vendor" : "assets";
  const prefix = isVendor ? /^\/vendor\// : /^\/assets\//;
  const assetsRoot = path.join(deps.PUBLIC_ROOT, subdir);
  const relativePath = decodedPath.replace(prefix, "");
  const resolvedPath = path.resolve(assetsRoot, relativePath);
  const rootWithSep = assetsRoot.endsWith(path.sep) ? assetsRoot : `${assetsRoot}${path.sep}`;

  if (!resolvedPath.startsWith(rootWithSep)) {
    return new Response("Not found", { status: 404 });
  }

  const file = Bun.file(resolvedPath);
  if (await file.exists()) {
    const contentType = deps.mimeType(url.pathname);
    const headers: Record<string, string> = {
      ...deps.secureHeaders(contentType),
      "Cache-Control": assetCacheControl(relativePath),
    };
    if (relativePath === "notification-sw.js") {
      headers["Service-Worker-Allowed"] = "/";
    }

    const stat = file;
    const etag = `"${stat.size.toString(36)}-${stat.lastModified.toString(36)}"`;
    headers["ETag"] = etag;
    if (req.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers });
    }

    if (isCompressible(contentType) && acceptsGzip(req)) {
      return compressedResponse(`${resolvedPath}:${etag}`, file, headers);
    }
    return new Response(file, { headers });
  }
  return new Response("Not found", { status: 404 });
}
