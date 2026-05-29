import type { ServerWebSocket } from "bun";
import { getChatHistory, insertChatMessage, getOnlineClientCountForUser } from "../db";
import { getUserById } from "../users";
import { hasPermission } from "../rbac";
import { getConfig } from "../config";
import * as sessionManager from "../sessions/sessionManager";
import type { SocketData } from "../sessions/types";

export function handleChatViewerOpen(ws: ServerWebSocket<SocketData>): void {
  const id = crypto.randomUUID();
  ws.data.sessionId = id;
  const userId = ws.data.userId;
  const userRole = ws.data.userRole || "viewer";
  const user = userId ? getUserById(userId) : null;
  const username = user?.username || "Unknown";
  sessionManager.addChatSession({
    id,
    viewer: ws,
    createdAt: Date.now(),
    userId: userId || 0,
    username,
    userRole,
  });
  const retDays = getConfig().chat?.retentionDays ?? 30;
  const retMs = retDays > 0 ? retDays * 24 * 60 * 60 * 1000 : undefined;
  const history = getChatHistory(undefined, 50, retMs);
  const enrichedHistory = history.map((m) => ({
    ...m,
    onlineClients: m.userId ? getOnlineClientCountForUser(m.userId) : 0,
  }));
  const canWrite = userId ? hasPermission(userRole as any, "chat:write", userId) : false;
  ws.send(JSON.stringify({ type: "chat_ready", history: enrichedHistory, canWrite, userId: userId || 0 }));
}

export function handleChatViewerMessage(
  ws: ServerWebSocket<SocketData>,
  raw: string | ArrayBuffer | Uint8Array,
): void {
  try {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer);
    const parsed = JSON.parse(text);
    if (parsed.type !== "chat_send" || typeof parsed.message !== "string") return;
    const userId = ws.data.userId;
    const userRole = ws.data.userRole || "viewer";
    if (!userId || !hasPermission(userRole as any, "chat:write", userId)) {
      ws.send(JSON.stringify({ type: "chat_error", error: "Permission denied" }));
      return;
    }
    const msg = parsed.message.trim();
    if (!msg || msg.length > 2000) {
      ws.send(JSON.stringify({ type: "chat_error", error: msg ? "Message too long (max 2000 chars)" : "Message is empty" }));
      return;
    }
    const user = getUserById(userId);
    const username = user?.username || "Unknown";
    const record = insertChatMessage(userId, username, userRole, msg);
    const onlineClients = getOnlineClientCountForUser(userId);
    sessionManager.broadcastChatMessage(JSON.stringify({ type: "chat_message", ...record, onlineClients }));
  } catch {}
}
