import { logger } from "../logger";
import type { ClientInfo } from "../types";

type PruneStaleClientsParams = {
  clients: Map<string, ClientInfo>;
  staleMs: number;
  pruneBatch: number;
  setOnlineState: (id: string, online: boolean) => void;
  deleteClient: (id: string) => void;
};

export function pruneStaleClients(params: PruneStaleClientsParams): void {
  const now = Date.now();
  let processed = 0;

  for (const [id, info] of params.clients.entries()) {
    if (now - info.lastSeen <= params.staleMs) continue;

    try {
      if (info.role === "client") {
        info.ws.close(4000, "stale");
        params.setOnlineState(id, false);
        params.deleteClient(id);
        processed += 1;
        continue;
      }
      info.ws.close();
    } catch (err) {
      logger.error(`[prune] close failed for ${id}`, err);
    }

    params.deleteClient(id);
    params.setOnlineState(id, false);
    processed += 1;

    if (processed >= params.pruneBatch) {
      logger.debug(`[prune] paused after ${processed} stale sockets; will continue next sweep`);
      break;
    }
  }
}
