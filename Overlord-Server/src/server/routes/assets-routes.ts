import path from "path";
import { getConfig } from "../../config";

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

const STATIC_ASSET_CACHE = "public, max-age=3600, stale-while-revalidate=86400";
const MUTABLE_ASSET_CACHE = "public, max-age=60, stale-while-revalidate=300";
const NO_CACHE = "no-cache";

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

async function compressedResponse(
  req: Request,
  body: Uint8Array | ArrayBuffer,
  headers: Record<string, string>,
): Promise<Response> {
  if (!isCompressible(headers["Content-Type"] ?? "") || !acceptsGzip(req) || body.byteLength < 1024) {
    return new Response(body, { headers });
  }
  const compressed = Bun.gzipSync(new Uint8Array(body instanceof ArrayBuffer ? body : body));
  return new Response(compressed, {
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

  if (req.method === "GET" && url.pathname === "/favicon.ico") {
    const file = Bun.file(path.join(deps.PUBLIC_ROOT, "assets", "favicon.ico"));
    if (await file.exists()) {
      const headers = { ...deps.secureHeaders("image/x-icon"), "Cache-Control": STATIC_ASSET_CACHE };
      return new Response(file, { headers });
    }
    return new Response("Not found", { status: 404 });
  }

  if (!(req.method === "GET" && url.pathname.startsWith("/assets/"))) {
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

  const assetsRoot = path.join(deps.PUBLIC_ROOT, "assets");
  const relativePath = decodedPath.replace(/^\/assets\//, "");
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
      const bytes = await file.arrayBuffer();
      return compressedResponse(req, bytes, headers);
    }
    return new Response(file, { headers });
  }
  return new Response("Not found", { status: 404 });
}
