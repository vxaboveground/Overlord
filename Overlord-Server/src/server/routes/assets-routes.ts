import path from "path";

type AssetsRouteDeps = {
  PUBLIC_ROOT: string;
  secureHeaders: (contentType?: string) => Record<string, string>;
  mimeType: (path: string) => string;
};

export async function handleAssetsRoutes(
  req: Request,
  url: URL,
  deps: AssetsRouteDeps,
): Promise<Response | null> {
  if (req.method === "GET" && url.pathname === "/favicon.ico") {
    const file = Bun.file(path.join(deps.PUBLIC_ROOT, "assets", "favicon.ico"));
    if (await file.exists()) {
      return new Response(file, { headers: deps.secureHeaders("image/x-icon") });
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
    return new Response(file, { headers: deps.secureHeaders(deps.mimeType(url.pathname)) });
  }
  return new Response("Not found", { status: 404 });
}
