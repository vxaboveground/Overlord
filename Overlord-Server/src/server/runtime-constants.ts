export const HEARTBEAT_INTERVAL_MS = 15_000;
export const STALE_MS = 5 * 60_000;
export const DISCONNECT_TIMEOUT_MS = 10_000;

export const PRUNE_BATCH = Number(process.env.PRUNE_BATCH || 500);
export const MAX_WS_MESSAGE_BYTES_VIEWER = Number(
  process.env.MAX_WS_MESSAGE_BYTES_VIEWER || 1_000_000,
);
export const MAX_WS_MESSAGE_BYTES_CLIENT = Number(
  process.env.MAX_WS_MESSAGE_BYTES_CLIENT || 16_000_000,
);
