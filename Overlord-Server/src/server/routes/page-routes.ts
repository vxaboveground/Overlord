import { authenticateRequest } from "../../auth";
import { getConfig } from "../../config";
import { consumeLoginPageRateLimit } from "../../rateLimit";
import { getPermissionDescription, requirePermission, type Permission } from "../../rbac";
import { canUserAccessClient, canUserAccessFeature, getUserById, type FeatureName, type UserRole } from "../../users";
import { renderAccessDeniedPage, type AccessDeniedKind } from "../ui/access-denied-view";
import { htmlResponse } from "../ui/html";

type PageRouteDeps = {
  PUBLIC_ROOT: string;
  secureHeaders: (contentType?: string) => Record<string, string>;
  mimeType: (path: string) => string;
  requestIP?: (req: Request) => { address?: string } | null | undefined;
};

function tooManyRequestsResponse(retryAfter = 60): Response {
  return new Response("Too many requests", {
    status: 429,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Retry-After": String(retryAfter),
    },
  });
}

async function serveLoginOrUnauthorized(req: Request, deps: PageRouteDeps): Promise<Response> {
  const ip = deps.requestIP?.(req)?.address || "unknown";
  const limited = consumeLoginPageRateLimit(ip);
  if (limited.limited) return tooManyRequestsResponse(limited.retryAfter);

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
  feature?: FeatureName;
  permission?: Permission;
};

type QueryClientPageDef = {
  path: string;
  file: string;
  feature?: FeatureName;
  permission?: Permission;
};

/** Static pages: each entry maps a URL path to its HTML file + access rules. */
const STATIC_PAGES: StaticPageDef[] = [
  { path: "/metrics",            file: "metrics.html",             access: "any",              checkPasswordChange: true },
  { path: "/graph",              file: "graph.html",               access: "any",              checkPasswordChange: true },
  { path: "/screenshots",        file: "screenshots.html",         access: "no-viewer",        checkPasswordChange: true },
  { path: "/settings",           file: "settings.html",            access: "any",              checkPasswordChange: true },
  { path: "/logs",               file: "logs.html",                access: "any",              checkPasswordChange: true, permission: "audit:view" },
  { path: "/notifications",      file: "notifications.html",       access: "admin-or-operator", checkPasswordChange: true },
  { path: "/users",              file: "users.html",               access: "any",               checkPasswordChange: true, permission: "users:manage" },
  { path: "/user-client-access", file: "user-client-access.html",  access: "any",               checkPasswordChange: true, permission: "users:manage" },
  { path: "/build",              file: "build.html",               access: "any",               permission: "clients:build" },
  { path: "/sol-publish",        file: "sol-publish.html",         access: "any",               permission: "system:configure" },
  { path: "/plugins",            file: "plugins.html",             access: "any",               permission: "plugins:manage" },
  { path: "/scripts",            file: "scripts.html",             access: "any",               permission: "scripts:manage" },
  { path: "/deploy",             file: "deploy.html",              access: "any",               permission: "deploys:manage" },
  { path: "/socks5-manager",     file: "socks5-manager.html",      access: "no-viewer",        checkPasswordChange: true },
  { path: "/file-share",          file: "file-share.html",          access: "no-viewer",        checkPasswordChange: true },
  { path: "/purgatory",          file: "purgatory.html",           access: "any",              checkPasswordChange: true, permission: "clients:enroll" },
];

/** Client-scoped pages accessed via query param ?clientId=... */
const QUERY_CLIENT_PAGES: QueryClientPageDef[] = [
  { path: "/remotedesktop", file: "remotedesktop.html", feature: "remote_desktop" },
  { path: "/webcam",        file: "webcam.html",        feature: "webcam" },
  { path: "/backstage",     file: "backstage.html",     feature: "backstage" },
  { path: "/voice",         file: "voice.html",         feature: "voice" },
  { path: "/winre",         file: "winre.html",         permission: "clients:winre" },
];

/** Client-scoped pages accessed via path /:clientId/feature */
const PATH_CLIENT_PAGES: ClientPageDef[] = [
  { pattern: /^\/(.+)\/console$/,    file: "console.html",     clientIdGroup: 1, feature: "console" },
  { pattern: /^\/(.+)\/files$/,      file: "filebrowser.html", clientIdGroup: 1, feature: "file_browser" },
  { pattern: /^\/(.+)\/processes$/,  file: "processes.html",   clientIdGroup: 1, feature: "processes" },
  { pattern: /^\/(.+)\/keylogger$/,  file: "keylogger.html",   clientIdGroup: 1, feature: "keylogger" },
];

function accessDeniedResponse(
  deps: PageRouteDeps,
  options: {
    kind: AccessDeniedKind;
    title?: string;
    message: string;
    detail?: string;
    detailLabel?: string;
  },
): Response {
  return htmlResponse(renderAccessDeniedPage(options), {
    status: 403,
    headers: deps.secureHeaders("text/html; charset=utf-8"),
  });
}

function permissionDeniedResponse(deps: PageRouteDeps, permission: Permission): Response {
  return accessDeniedResponse(deps, {
    kind: "permission",
    message: `This page requires permission to ${getPermissionDescription(permission).toLowerCase()}.`,
    detail: permission,
    detailLabel: "Missing permission",
  });
}

function checkAccess(deps: PageRouteDeps, role: UserRole, access: AccessLevel): Response | null {
  switch (access) {
    case "any":
      return null;
    case "no-viewer":
      if (role === "viewer") {
        return accessDeniedResponse(deps, {
          kind: "role",
          message: "Viewer accounts can inspect data, but cannot open interactive control features.",
          detail: "Operator or administrator role",
        });
      }
      return null;
    case "admin":
      if (role !== "admin") {
        return accessDeniedResponse(deps, {
          kind: "role",
          message: "This area is reserved for administrators.",
          detail: "Administrator role",
        });
      }
      return null;
    case "admin-or-operator":
      if (role !== "admin" && role !== "operator") {
        return accessDeniedResponse(deps, {
          kind: "role",
          message: "This interactive area is available to operators and administrators.",
          detail: "Operator or administrator role",
        });
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
      if (!authed) {
        const limited = consumeLoginPageRateLimit(deps.requestIP?.(req)?.address || "unknown");
        if (limited.limited) return tooManyRequestsResponse(limited.retryAfter);
      }
      return new Response(file, { headers: deps.secureHeaders(deps.mimeType(filePath)) });
    }
  }

  // ---- Explicit login page ----
  if (url.pathname === "/login.html") {
    return serveLoginOrUnauthorized(req, deps);
  }

  // ---- Change password (always accessible) ----
  if (url.pathname === "/change-password.html") {
    return serveFile(deps, "change-password.html");
  }

  // ---- Registration page (always accessible, no auth needed) ----
  if (url.pathname === "/register.html") {
    return serveFile(deps, "register.html");
  }

  // ---- Static pages (table-driven) ----
  for (const page of STATIC_PAGES) {
    if (url.pathname !== page.path) continue;

    const user = await authenticateRequest(req);
    if (!user) return serveLoginOrUnauthorized(req, deps);

    if (page.path === "/screenshots" && !getConfig().thumbnails.wallEnabled) {
      return accessDeniedResponse(deps, {
        kind: "unavailable",
        message: "The screenshot wall has been disabled in server settings.",
        detail: "Screenshot wall disabled",
        detailLabel: "Current status",
      });
    }

    if (page.checkPasswordChange) {
      const maybeChange = await serveChangePasswordIfRequired(deps, user.userId);
      if (maybeChange) return maybeChange;
    }

    const accessDenied = checkAccess(deps, user.role, page.access);
    if (accessDenied) return accessDenied;

    if (page.permission) {
      try {
        requirePermission(user, page.permission);
      } catch (error) {
        if (error instanceof Response && error.status === 403) {
          return permissionDeniedResponse(deps, page.permission);
        }
        return new Response("Forbidden", { status: 403 });
      }
    }

    return serveFile(deps, page.file);
  }

  // ---- Client pages via query param (?clientId=...) ----
  for (const page of QUERY_CLIENT_PAGES) {
    if (url.pathname !== page.path) continue;

    const user = await authenticateRequest(req);
    if (!user) return serveLoginOrUnauthorized(req, deps);

    const maybeChange = await serveChangePasswordIfRequired(deps, user.userId);
    if (maybeChange) return maybeChange;

    if (page.permission) {
      try {
        requirePermission(user, page.permission);
      } catch (error) {
        if (error instanceof Response && error.status === 403) {
          return permissionDeniedResponse(deps, page.permission);
        }
        return new Response("Forbidden", { status: 403 });
      }
    }

    if (page.feature && !canUserAccessFeature(user.userId, user.role, page.feature)) {
      return accessDeniedResponse(deps, {
        kind: "feature",
        title: "This feature isn't enabled for you",
        message: "Your account's feature access does not include this client tool.",
        detail: page.feature,
        detailLabel: "Restricted feature",
      });
    }

    const clientId = (url.searchParams.get("clientId") || "").trim();
    if (!canAccessClientPage(user.userId, user.role, clientId)) {
      return accessDeniedResponse(deps, {
        kind: "client",
        title: "Client access restricted",
        message: clientId
          ? "This client is outside the scope assigned to your account."
          : "Choose a client from the dashboard before opening this tool.",
        detail: clientId || "No client selected",
        detailLabel: "Client",
      });
    }

    return serveFile(deps, page.file);
  }

  // ---- Client pages via path (/:clientId/feature) ----
  for (const page of PATH_CLIENT_PAGES) {
    const match = url.pathname.match(page.pattern);
    if (!match) continue;

    const user = await authenticateRequest(req);
    if (!user) return serveLoginOrUnauthorized(req, deps);

    if (page.permission) {
      try {
        requirePermission(user, page.permission);
      } catch (error) {
        if (error instanceof Response && error.status === 403) {
          return permissionDeniedResponse(deps, page.permission);
        }
        return new Response("Forbidden", { status: 403 });
      }
    }

    if (page.feature && !canUserAccessFeature(user.userId, user.role, page.feature)) {
      return accessDeniedResponse(deps, {
        kind: "feature",
        title: "This feature isn't enabled for you",
        message: "Your account's feature access does not include this client tool.",
        detail: page.feature,
        detailLabel: "Restricted feature",
      });
    }

    const clientId = match[page.clientIdGroup];
    if (!canAccessClientPage(user.userId, user.role, clientId)) {
      return accessDeniedResponse(deps, {
        kind: "client",
        title: "Client access restricted",
        message: "This client is outside the scope assigned to your account.",
        detail: clientId,
        detailLabel: "Client",
      });
    }

    return serveFile(deps, page.file);
  }

  return null;
}
