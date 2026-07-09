import { logger } from "../logger";
import { metrics } from "../metrics";
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

function nonNegativeIntEnv(name: string, fallback: number): number {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

const HEARTBEAT_SWEEP_TICK_MS = Math.max(
  250,
  nonNegativeIntEnv("OVERLORD_HEARTBEAT_SWEEP_TICK_MS", 1_000),
);
const HEARTBEAT_BATCH_SIZE = nonNegativeIntEnv("OVERLORD_HEARTBEAT_BATCH_SIZE", 0);

export function getHeartbeatBatchSize(totalClients: number, heartbeatIntervalMs: number): number {
  if (totalClients <= 0) return 0;
  if (HEARTBEAT_BATCH_SIZE > 0) return Math.min(totalClients, HEARTBEAT_BATCH_SIZE);
  const ticksPerSweep = Math.max(1, Math.floor(heartbeatIntervalMs / HEARTBEAT_SWEEP_TICK_MS));
  return Math.max(1, Math.ceil(totalClients / ticksPerSweep));
}

export function shouldSendHeartbeatPing(
  info: Pick<ClientInfo, "lastPingSent">,
  now: number,
  heartbeatIntervalMs: number,
): boolean {
  if (heartbeatIntervalMs <= 0) return false;
  if (!info.lastPingSent) return true;
  return now - info.lastPingSent >= heartbeatIntervalMs;
}

export function startMaintenanceLoops(params: StartMaintenanceParams): void {
  setInterval(() => {
    const startedAt = Date.now();
    pruneStaleClients({
      clients: params.getClients(),
      staleMs: params.staleMs,
      pruneBatch: params.pruneBatch,
      setOnlineState: params.setOnlineState,
      deleteClient: params.deleteClient,
    });
    metrics.recordInternalTask("stale-prune", Date.now() - startedAt);
  }, 5000);

  const livenessTimeoutMs = Math.max(
    params.heartbeatIntervalMs * 4 + params.disconnectTimeoutMs,
    60_000,
  );

  let heartbeatCursor = 0;
  setInterval(() => {
    const startedAt = Date.now();
    const now = Date.now();
    const clients = Array.from(params.getClients().entries()).filter(
      ([, info]) => info.role === "client",
    );
    if (clients.length === 0) {
      heartbeatCursor = 0;
      metrics.recordInternalTask("heartbeat-sweep", Date.now() - startedAt);
      return;
    }
    if (heartbeatCursor >= clients.length) heartbeatCursor = 0;

    const batchSize = getHeartbeatBatchSize(clients.length, params.heartbeatIntervalMs);
    for (let i = 0; i < batchSize; i++) {
      const [id, info] = clients[(heartbeatCursor + i) % clients.length];
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
      if (!shouldSendHeartbeatPing(info, now, params.heartbeatIntervalMs)) {
        continue;
      }
      try {
        sendPingRequest(info, info.ws, "heartbeat", params.heartbeatIntervalMs);
      } catch (err) {
        logger.debug(`[ping] heartbeat failed for ${id}`, err);
      }
    }
    heartbeatCursor = (heartbeatCursor + batchSize) % clients.length;
    metrics.recordInternalTask("heartbeat-sweep", Date.now() - startedAt);
  }, HEARTBEAT_SWEEP_TICK_MS);
}
