export const FILE_BROWSER_MAX_PATH = 4096;
export const FILE_BROWSER_MAX_READ_BYTES = 10 * 1024 * 1024;
export const FILE_BROWSER_MAX_WRITE_CHARS = 10 * 1024 * 1024;
export const FILE_BROWSER_MAX_ICON_ITEMS = 32;
export const FILE_BROWSER_MAX_THUMB_ITEMS = 8;

const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const HASH_ALGORITHMS = new Set(["md5", "sha1", "sha256", "crc32"]);

function safeString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === "string"
    && value.length <= maxLength
    && (allowEmpty || value.length > 0)
    && !CONTROL_CHARS.test(value);
}

export function isSafeFileBrowserPath(value: unknown, allowEmpty = false): value is string {
  return safeString(value, FILE_BROWSER_MAX_PATH, allowEmpty);
}

function safeCommandId(value: unknown): value is string {
  return safeString(value, 128);
}

function safeItems(value: unknown, limit: number, thumbnail: boolean): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > limit) return false;
  return value.every((item) => {
    if (!item || typeof item !== "object") return false;
    const entry = item as Record<string, unknown>;
    if (!safeString(entry.key, FILE_BROWSER_MAX_PATH + 128)) return false;
    if (entry.path !== undefined && !isSafeFileBrowserPath(entry.path)) return false;
    if (entry.ext !== undefined && !safeString(entry.ext, 32, true)) return false;
    if (thumbnail && (!Number.isInteger(entry.size) || Number(entry.size) < 16 || Number(entry.size) > 512)) return false;
    return true;
  });
}

export function validateFileBrowserCommandPayload(
  commandType: string,
  value: unknown,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  const pathOk = () => isSafeFileBrowserPath(payload.path);

  switch (commandType) {
    case "file_read":
      if (!pathOk()) return null;
      return { ...payload, maxSize: Math.min(FILE_BROWSER_MAX_READ_BYTES, Math.max(1, Number(payload.maxSize) || FILE_BROWSER_MAX_READ_BYTES)) };
    case "file_write":
      if (!pathOk() || typeof payload.content !== "string" || payload.content.length > FILE_BROWSER_MAX_WRITE_CHARS) return null;
      return payload;
    case "file_request_access":
    case "file_execute":
    case "file_dirsize":
      return pathOk() ? payload : null;
    case "file_search": {
      if (!isSafeFileBrowserPath(payload.path, true) || !safeString(payload.pattern, 512)) return null;
      if (payload.searchId !== undefined && !safeCommandId(payload.searchId)) return null;
      return { ...payload, maxResults: Math.min(500, Math.max(1, Number(payload.maxResults) || 100)) };
    }
    case "file_copy":
    case "file_move":
      return isSafeFileBrowserPath(payload.source) && isSafeFileBrowserPath(payload.dest) ? payload : null;
    case "file_chmod":
      return pathOk() && safeString(payload.mode, 16) ? payload : null;
    case "file_icon":
      return safeItems(payload.items, FILE_BROWSER_MAX_ICON_ITEMS, false) ? payload : null;
    case "file_thumb":
      return safeItems(payload.items, FILE_BROWSER_MAX_THUMB_ITEMS, true) ? payload : null;
    case "file_peek":
      if (!pathOk()) return null;
      return { ...payload, bytes: Math.min(4096, Math.max(1, Number(payload.bytes) || 4096)) };
    case "file_hash": {
      const algorithm = String(payload.algorithm || "sha256").toLowerCase();
      return pathOk() && HASH_ALGORITHMS.has(algorithm) ? { ...payload, algorithm } : null;
    }
    case "file_upload_http":
      if (!pathOk() || typeof payload.url !== "string"
          || !/^\/api\/file\/upload\/pull\/[0-9a-f-]{36}$/i.test(payload.url)) return null;
      if (!Number.isSafeInteger(Number(payload.total)) || Number(payload.total) < 0) return null;
      return payload;
    default:
      return null;
  }
}

type RateState = {
  windowStart: number;
  commands: number;
  expensiveWindowStart: number;
  expensiveCommands: number;
};

const rateStates = new WeakMap<object, RateState>();
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_COMMANDS = 120;
const EXPENSIVE_WINDOW_MS = 60_000;
const RATE_MAX_EXPENSIVE = 20;

export function consumeFileBrowserCommandRateLimit(socket: object, expensive: boolean): boolean {
  const now = Date.now();
  let state = rateStates.get(socket);
  if (!state) {
    state = { windowStart: now, commands: 0, expensiveWindowStart: now, expensiveCommands: 0 };
    rateStates.set(socket, state);
  }
  if (now - state.windowStart >= RATE_WINDOW_MS) {
    state.windowStart = now;
    state.commands = 0;
  }
  if (now - state.expensiveWindowStart >= EXPENSIVE_WINDOW_MS) {
    state.expensiveWindowStart = now;
    state.expensiveCommands = 0;
  }
  state.commands++;
  if (expensive) state.expensiveCommands++;
  return state.commands <= RATE_MAX_COMMANDS && state.expensiveCommands <= RATE_MAX_EXPENSIVE;
}
