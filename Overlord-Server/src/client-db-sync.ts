import { upsertClientRow, type ClientDbRow } from "./db";

export const CLIENT_DB_SYNC_INTERVAL_MS = Number(process.env.OVERLORD_CLIENT_DB_SYNC_MS || 5000);

const lastClientDbSync = new Map<string, number>();
const pendingClientDbUpdates = new Map<string, ClientDbRow>();

export function queueClientDbUpdate(partial: ClientDbRow): void {
  const existing = pendingClientDbUpdates.get(partial.id);
  if (!existing) {
    pendingClientDbUpdates.set(partial.id, { ...partial });
    return;
  }
  pendingClientDbUpdates.set(partial.id, {
    ...existing,
    ...partial,
    id: partial.id,
    lastSeen: partial.lastSeen ?? existing.lastSeen,
    online: partial.online ?? existing.online,
    pingMs: partial.pingMs ?? existing.pingMs,
  });
}

export function flushQueuedClientDbUpdates(): void {
  if (pendingClientDbUpdates.size === 0) return;
  for (const update of pendingClientDbUpdates.values()) {
    upsertClientRow(update);
  }
  pendingClientDbUpdates.clear();
}

setInterval(flushQueuedClientDbUpdates, CLIENT_DB_SYNC_INTERVAL_MS);

export function shouldSyncClientToDb(clientId: string, now: number): boolean {
  const last = lastClientDbSync.get(clientId) || 0;
  if (now - last < CLIENT_DB_SYNC_INTERVAL_MS) return false;
  lastClientDbSync.set(clientId, now);
  return true;
}

export function markClientDbSynced(clientId: string, now: number): void {
  lastClientDbSync.set(clientId, now);
}

export function clearClientSyncState(clientId: string): void {
  lastClientDbSync.delete(clientId);
  pendingClientDbUpdates.delete(clientId);
}
