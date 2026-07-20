import { authenticateRequest, extractTokenFromRequest } from "../../auth";
import { AuditAction, logAudit } from "../../auditLog";
import {
  deleteInactiveSessions,
  getSessionById,
  hashTokenForSession,
  listUserSessions,
  persistRevokedTokenHash,
  revokeSessionById,
} from "../../db";
import { htmlResponse } from "../ui/html";
import { requirePermission } from "../../rbac";
import { renderSessionsFrame } from "../ui/sessions-view";
import { renderPermissionsOverviewFrame } from "../ui/permissions-overview-view";
import { makeAuthCookieClear } from "./auth-cookie";

type UiRouteServer = {
  requestIP: (req: Request) => { address?: string } | null | undefined;
};

function redirectToLogin(req: Request): Response {
  return Response.redirect(new URL("/login.html", req.url), 303);
}

function currentTokenHash(req: Request): string | null {
  const token = extractTokenFromRequest(req);
  return token ? hashTokenForSession(token) : null;
}

export async function handleUiRoutes(
  req: Request,
  url: URL,
  server: UiRouteServer,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/ui/")) return null;

  const user = await authenticateRequest(req);
  if (!user) return redirectToLogin(req);

  if (req.method === "GET" && url.pathname === "/ui/settings/sessions") {
    return htmlResponse(renderSessionsFrame(
      listUserSessions(user.userId),
      currentTokenHash(req),
    ));
  }

  if (req.method === "GET" && url.pathname === "/ui/settings/permissions-overview") {
    try {
      requirePermission(user, "users:manage");
    } catch (error) {
      if (error instanceof Response) return error;
      throw error;
    }
    return htmlResponse(renderPermissionsOverviewFrame(user));
  }

  if (req.method === "POST" && url.pathname === "/ui/settings/sessions/inactive") {
    const removed = deleteInactiveSessions(user.userId);
    logAudit({
      timestamp: Date.now(),
      username: user.username,
      ip: server.requestIP(req)?.address || "unknown",
      action: AuditAction.LOGOUT,
      details: `Removed ${removed} inactive session(s)`,
      success: true,
    });
    return htmlResponse(renderSessionsFrame(
      listUserSessions(user.userId),
      currentTokenHash(req),
      { text: `Removed ${removed} inactive session(s).` },
    ));
  }

  const revokeMatch = req.method === "POST"
    ? url.pathname.match(/^\/ui\/settings\/sessions\/([^/]+)\/revoke$/)
    : null;
  if (revokeMatch) {
    let sessionId = "";
    try {
      sessionId = decodeURIComponent(revokeMatch[1]);
    } catch {
      return htmlResponse(renderSessionsFrame(
        listUserSessions(user.userId),
        currentTokenHash(req),
        { text: "Invalid session identifier.", type: "error" },
      ), { status: 400 });
    }

    const session = getSessionById(sessionId);
    if (!session || session.userId !== user.userId) {
      return htmlResponse(renderSessionsFrame(
        listUserSessions(user.userId),
        currentTokenHash(req),
        { text: "Session not found.", type: "error" },
      ), { status: 404 });
    }

    const tokenHash = currentTokenHash(req);
    const revokingCurrentSession = session.tokenHash === tokenHash;
    const result = revokeSessionById(sessionId);
    if (result.tokenHash) persistRevokedTokenHash(result.tokenHash, session.expiresAt);

    logAudit({
      timestamp: Date.now(),
      username: user.username,
      ip: server.requestIP(req)?.address || "unknown",
      action: AuditAction.LOGOUT,
      details: `Revoked session ${sessionId}`,
      success: true,
    });

    if (revokingCurrentSession) {
      return new Response(null, {
        status: 303,
        headers: {
          "Location": "/",
          "Set-Cookie": makeAuthCookieClear(req),
        },
      });
    }

    return htmlResponse(renderSessionsFrame(
      listUserSessions(user.userId),
      tokenHash,
      { text: "Session revoked successfully." },
    ));
  }

  return htmlResponse("<h1>Not found</h1>", { status: 404 });
}
