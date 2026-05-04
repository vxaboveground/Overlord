import { logger } from "../logger";
import { sendPingRequest } from "../wsHandlers";
import type { ClientInfo } from "../types";
import { pruneStaleClients } from "./stale-prune";

type StartMaintenanceParams = {
  getClients: () => Map<string, ClientInfo>;
  setOnlineState: (id: string, online: boolean) => void;
  deleteClient: (id: string) => void;
  staleMs: number;
  pruneBatch: number;
  heartbeatIntervalMs: number;
  disconnectTimeoutMs: number;
};

export function startMaintenanceLoops(params: StartMaintenanceParams): void {
  setInterval(() => {
    pruneStaleClients({
      clients: params.getClients(),
      staleMs: params.staleMs,
      pruneBatch: params.pruneBatch,
      setOnlineState: params.setOnlineState,
      deleteClient: params.deleteClient,
    });
  }, 5000);

  const livenessTimeoutMs = Math.max(
    params.heartbeatIntervalMs * 4 + params.disconnectTimeoutMs,
    60_000,
  );

  setInterval(() => {
    const now = Date.now();
    for (const [id, info] of params.getClients().entries()) {
      if (info.role !== "client") continue;
      const lastActivity = info.lastSeen || 0;
      if (lastActivity && now - lastActivity > livenessTimeoutMs) {
        logger.warn(
          `[ping] no activity from ${id} for ${now - lastActivity}ms; closing socket`,
        );
        try {
          info.ws.close(4001, "ping timeout");
        } catch (err) {
          logger.debug(`[ping] close failed for ${id}`, err);
        }
        continue;
      }
      try {
        sendPingRequest(info, info.ws, "heartbeat");
      } catch (err) {
        logger.debug(`[ping] heartbeat failed for ${id}`, err);
      }
    }
  }, params.heartbeatIntervalMs);
}
