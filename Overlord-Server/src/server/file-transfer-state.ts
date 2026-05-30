import fs from "fs/promises";
import type { FileHandle } from "fs/promises";
import path from "path";
import { v4 as uuidv4 } from "uuid";

export type PendingHttpDownload = {
  commandId: string;
  clientId: string;
  path: string;
  fileName: string;
  total: number;
  receivedBytes: number;
  receivedOffsets: Set<number>;
  receivedChunks: Set<number>;
  chunkSize: number;
  expectedChunks: number;
  loggedTotal?: boolean;
  loggedFirstChunk?: boolean;
  tmpPath: string;
  fileHandle: any;
  resolve: (entry: PendingHttpDownload) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  streamController?: ReadableStreamDefaultController<Uint8Array>;
  reorderBuffer?: Map<number, Uint8Array>;
  nextExpectedOffset?: number;
  streamErrored?: boolean;
  onFirstChunk?: () => void;
  firstChunkSignaled?: boolean;
};

export type DownloadIntent = {
  id: string;
  userId: number;
  clientId: string;
  path: string;
  expiresAt: number;
  timeout: ReturnType<typeof setTimeout>;
};

export type UploadIntent = {
  id: string;
  userId: number;
  clientId: string;
  path: string;
  fileName: string;
  expiresAt: number;
  timeout: ReturnType<typeof setTimeout>;
};

export type StreamingPullState = {
  size: number;
  done: boolean;
  error: Error | null;
  waiters: Array<() => void>;
};

export type UploadPull = {
  id: string;
  clientId: string;
  path: string;
  fileName: string;
  tmpPath: string;
  size: number;
  expiresAt: number;
  timeout: ReturnType<typeof setTimeout>;
  deleteFile: boolean;
  state?: StreamingPullState;
  expectedTotal?: number;
};

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export const UUID_TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// WAN uploads can be significantly slower than LAN transfers.
export const FILE_UPLOAD_INTENT_TTL_MS = parsePositiveIntEnv(
  "OVERLORD_FILE_UPLOAD_INTENT_TTL_MS",
  30 * 60_000,
);
export const FILE_UPLOAD_PULL_TTL_MS = parsePositiveIntEnv(
  "OVERLORD_FILE_UPLOAD_PULL_TTL_MS",
  30 * 60_000,
);

export const uploadIntents = new Map<string, UploadIntent>();
export const uploadPulls = new Map<string, UploadPull>();

export function isSafeRemotePath(value: string): boolean {
  if (!value || value.length > 4096) return false;
  if (/[\x00-\x1F\x7F]/.test(value)) return false;
  if (/(\.\.([\/\\]|$))/.test(value)) return false;
  return true;
}

export function notifyPullWaiters(state: StreamingPullState) {
  const list = state.waiters.splice(0);
  for (const w of list) {
    try { w(); } catch {}
  }
}

export function waitForPullProgress(state: StreamingPullState): Promise<void> {
  if (state.done) return Promise.resolve();
  return new Promise<void>((resolve) => state.waiters.push(resolve));
}

export function makeIncrementalPullStream(pull: UploadPull): ReadableStream<Uint8Array> {
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const state = pull.state;
      if (!state) {
        controller.close();
        return;
      }
      let fh: FileHandle | null = null;
      try {
        fh = await fs.open(pull.tmpPath, "r");
        let pos = 0;
        const READ_CHUNK = 256 * 1024;
        while (!cancelled) {
          while (pos < state.size && !cancelled) {
            const remaining = state.size - pos;
            const buf = new Uint8Array(Math.min(remaining, READ_CHUNK));
            const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
            if (bytesRead === 0) break;
            controller.enqueue(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
            pos += bytesRead;
          }
          if (cancelled) return;
          if (state.error) {
            controller.error(state.error);
            return;
          }
          if (state.done) {
            controller.close();
            return;
          }
          await Promise.race([
            waitForPullProgress(state),
            new Promise<void>((res) => setTimeout(res, 5000)),
          ]);
        }
      } catch (err) {
        try { controller.error(err); } catch {}
      } finally {
        if (fh) {
          try { await fh.close(); } catch {}
        }
      }
    },
    cancel() {
      cancelled = true;
      if (pull.state) {
        notifyPullWaiters(pull.state);
      }
    },
  });
}

export function streamFileAndDelete(tmpPath: string): ReadableStream<Uint8Array> {
  const reader = Bun.file(tmpPath).stream().getReader();
  let cleaned = false;

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try { await reader.cancel(); } catch {}
    await fs.unlink(tmpPath).catch(() => {});
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          await cleanup();
          controller.close();
          return;
        }
        if (value) {
          controller.enqueue(value);
        }
      } catch (err) {
        controller.error(err);
        await cleanup();
      }
    },
    async cancel() {
      try {
        await reader.cancel();
      } catch {}
      await cleanup();
    },
  });
}

export function streamFileRangeWithCleanup(
  tmpPath: string,
  start: number,
  endInclusive: number,
  cleanupOnComplete: () => void | Promise<void>,
): ReadableStream<Uint8Array> {
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let fh: FileHandle | null = null;
      try {
        fh = await fs.open(tmpPath, "r");
        let pos = start;
        const READ_CHUNK = 256 * 1024;
        while (!cancelled && pos <= endInclusive) {
          const remaining = endInclusive - pos + 1;
          const buf = new Uint8Array(Math.min(remaining, READ_CHUNK));
          const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
          if (bytesRead === 0) break;
          controller.enqueue(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
          pos += bytesRead;
        }
        if (cancelled) return;
        await cleanupOnComplete();
        controller.close();
      } catch (err) {
        try { controller.error(err); } catch {}
      } finally {
        if (fh) {
          try { await fh.close(); } catch {}
        }
      }
    },
    cancel() {
      cancelled = true;
    },
  });
}

export async function cleanupFileTransferTempFiles(dataDir: string): Promise<void> {
  const uploadsDir = path.join(dataDir, "uploads");
  const downloadsDir = path.join(dataDir, "downloads");
  await fs.rm(uploadsDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(downloadsDir, { recursive: true, force: true }).catch(() => {});
}

export function createUploadPull(opts: {
  clientId: string;
  filePath: string;
  fileName: string;
  size: number;
  ttlMs?: number;
}): string {
  const pullId = uuidv4();
  const ttl = opts.ttlMs ?? FILE_UPLOAD_PULL_TTL_MS;
  const expiresAt = Date.now() + ttl;
  const pullTimeout = setTimeout(() => {
    uploadPulls.delete(pullId);
  }, ttl);
  uploadPulls.set(pullId, {
    id: pullId,
    clientId: opts.clientId,
    path: opts.filePath,
    fileName: opts.fileName,
    tmpPath: opts.filePath,
    size: opts.size,
    expiresAt,
    timeout: pullTimeout,
    deleteFile: false,
  });
  return pullId;
}
