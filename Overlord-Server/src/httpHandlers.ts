import { listClients, setOnlineState, upsertClientRow } from "./db";
import * as clientManager from "./clientManager";
import { ClientRole, ClientInfo } from "./types";
import { encodeMessage } from "./protocol";
import { v4 as uuidv4 } from "uuid";
import { metrics } from "./metrics";
import { logAudit, AuditAction } from "./auditLog";

const DEFAULT_PAGE_SIZE = 12;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function handleClientsRequest(req: Request): Response {
  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const pageSize = Math.max(1, Number(url.searchParams.get("pageSize") || DEFAULT_PAGE_SIZE));
  const search = (url.searchParams.get("q") || "").toLowerCase().trim();
  const sort = url.searchParams.get("sort") || "last_seen_desc";
  const statusFilter = url.searchParams.get("status") || "all";
  const osFilter = url.searchParams.get("os") || "all";

  const result = listClients({ page, pageSize, search, sort, statusFilter, osFilter, enrollmentFilter: "approved" });
  const items = result.items.map((item) => {
    const live = clientManager.getClient(item.id);
    if (live) {
      return {
        ...item,
        isAdmin: live.isAdmin ?? item.isAdmin,
        elevation: live.elevation ?? item.elevation,
        permissions: live.permissions ?? item.permissions,
        ...(live.monitorInfo?.length ? {
          monitors: live.monitorInfo.length,
          monitorInfo: live.monitorInfo,
        } : {}),
      };
    }
    return item;
  });
  return Response.json({ ...result, items }, { headers: CORS_HEADERS });
}

const SIMPLE_COMMANDS = new Set([
  "desktop_start", "desktop_stop", "disconnect", "reconnect",
]);
const PAYLOAD_COMMANDS: Record<string, Record<string, unknown>> = {
  desktop_select_display: { display: 0 },
  desktop_enable_mouse:   { enabled: true },
  desktop_enable_keyboard:{ enabled: true },
};
const FILE_COMMANDS = new Set([
  "file_list", "file_download", "file_delete", "file_mkdir", "file_zip",
]);

const OK = () => Response.json({ ok: true });

export function handleCommand(target: ClientInfo, action: string, req: Request) {
  console.log(`[command] action=${action} clientId=${target.id}`);
  metrics.recordCommand(action);

  if (action === "ping") {
    const nonce = Date.now() + Math.floor(Math.random() * 1000);
    target.lastPingSent = Date.now();
    target.lastPingNonce = nonce;
    target.ws.send(encodeMessage({ type: "ping", ts: nonce }));
    return OK();
  }

  if (SIMPLE_COMMANDS.has(action)) {
    target.ws.send(encodeMessage({ type: "command", commandType: action as any, id: uuidv4() }));
    return OK();
  }

  if (action in PAYLOAD_COMMANDS) {
    target.ws.send(encodeMessage({ type: "command", commandType: action as any, id: uuidv4(), payload: PAYLOAD_COMMANDS[action] }));
    return OK();
  }

  if (FILE_COMMANDS.has(action)) {
    const path = new URL(req.url).searchParams.get("path") || "";
    target.ws.send(encodeMessage({ type: "command", commandType: action as any, id: uuidv4(), payload: { path } }));
    return OK();
  }

  return new Response("Bad request", { status: 400 });
}

export function markOffline(id: string) {
  setOnlineState(id, false);
}

export function markOnline(info: ClientInfo) {
  upsertClientRow({ id: info.id, role: info.role, lastSeen: info.lastSeen, online: 1 as any });
}
