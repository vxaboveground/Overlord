import fs from "fs/promises";
import type { FileHandle } from "fs/promises";
import { logger } from "../logger";

export const STREAM_REORDER_BUFFER_LIMIT = 16;
export const STREAM_REORDER_BUFFER_MAX_BYTES = 32 * 1024 * 1024;
export const STREAM_MAX_CHUNK_BYTES = 4 * 1024 * 1024;
export const STREAM_OUTPUT_QUEUE_MAX_CHUNKS = 16;

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
  fileHandle: FileHandle;
  resolve: (entry: PendingHttpDownload) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  streamController?: ReadableStreamDefaultController<Uint8Array>;
  reorderBuffer?: Map<number, Uint8Array>;
  nextExpectedOffset?: number;
  streamErrored?: boolean;
  onFirstChunk?: () => void;
  onFirstChunkError?: (error: Error) => void;
  firstChunkSignaled?: boolean;
  userId?: number;
  maxBytes?: number;
};

function isStreamMode(pending: PendingHttpDownload): boolean {
  return !!pending.streamController;
}

async function failStream(pending: PendingHttpDownload, err: Error): Promise<void> {
  if (pending.streamErrored) return;
  pending.streamErrored = true;
  try {
    pending.streamController?.error(err);
  } catch {}
  pending.reorderBuffer?.clear();
  if (!pending.firstChunkSignaled && pending.onFirstChunkError) {
    pending.firstChunkSignaled = true;
    try { pending.onFirstChunkError(err); } catch {}
  }
}

function enqueueOrdered(pending: PendingHttpDownload, offset: number, data: Uint8Array): boolean {
  if (!pending.streamController || pending.streamErrored) return false;
  const outputQueueFull = () => {
    const desiredSize = pending.streamController?.desiredSize;
    if (typeof desiredSize !== "number" || desiredSize > -STREAM_OUTPUT_QUEUE_MAX_CHUNKS) return false;
    void failStream(pending, new Error("download receiver is not consuming data fast enough"));
    return true;
  };
  if (offset === (pending.nextExpectedOffset ?? 0)) {
    if (outputQueueFull()) return false;
    try {
      pending.streamController.enqueue(data);
    } catch (err) {
      void failStream(pending, err as Error);
      return false;
    }
    pending.nextExpectedOffset = (pending.nextExpectedOffset ?? 0) + data.length;
    if (pending.reorderBuffer && pending.reorderBuffer.size > 0) {
      while (true) {
        const next = pending.reorderBuffer.get(pending.nextExpectedOffset ?? 0);
        if (!next) break;
        pending.reorderBuffer.delete(pending.nextExpectedOffset ?? 0);
        if (outputQueueFull()) return false;
        try {
          pending.streamController.enqueue(next);
        } catch (err) {
          void failStream(pending, err as Error);
          return false;
        }
        pending.nextExpectedOffset = (pending.nextExpectedOffset ?? 0) + next.length;
      }
    }
    return true;
  }
  if (!pending.reorderBuffer) pending.reorderBuffer = new Map();
  if (!pending.reorderBuffer.has(offset)) {
    pending.reorderBuffer.set(offset, data);
  }
  if (pending.reorderBuffer.size > STREAM_REORDER_BUFFER_LIMIT) {
    void failStream(pending, new Error("download chunks arrived too far out of order"));
    return false;
  }
  let bufferedBytes = 0;
  for (const chunk of pending.reorderBuffer.values()) bufferedBytes += chunk.byteLength;
  if (bufferedBytes > STREAM_REORDER_BUFFER_MAX_BYTES) {
    void failStream(pending, new Error("download reorder buffer byte limit exceeded"));
    return false;
  }
  return true;
}

async function teardownPending(pending: PendingHttpDownload, pendingHttpDownloads: Map<string, PendingHttpDownload>): Promise<void> {
  clearTimeout(pending.timeout);
  pendingHttpDownloads.delete(pending.commandId);
  if (isStreamMode(pending)) {
    return;
  }
  try {
    await pending.fileHandle.close();
  } catch {}
  try {
    await fs.unlink(pending.tmpPath);
  } catch {}
}

export async function consumeHttpDownloadPayload(
  payload: any,
  pendingHttpDownloads: Map<string, PendingHttpDownload>,
): Promise<void> {
  const commandId = typeof payload?.commandId === "string" ? payload.commandId : "";
  if (!commandId) return;

  const pending = pendingHttpDownloads.get(commandId);
  if (!pending) return;

  if (payload?.error) {
    const err = new Error(String(payload.error).slice(0, 1024));
    if (isStreamMode(pending)) {
      await failStream(pending, err);
      clearTimeout(pending.timeout);
      pendingHttpDownloads.delete(commandId);
      pending.resolve(pending);
    } else {
      await teardownPending(pending, pendingHttpDownloads);
      pending.reject(err);
    }
    return;
  }

  const toNumber = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isSafeInteger(value)) return value;
    if (typeof value === "bigint") {
      const asNumber = Number(value);
      if (Number.isSafeInteger(asNumber)) return asNumber;
    }
    return null;
  };

  const rawTotal = payload?.total;
  if (!pending.total) {
    const total = toNumber(rawTotal);
    if (total && total > 0) {
      pending.total = total;
    }
  }
  if (pending.maxBytes && pending.total > pending.maxBytes) {
    await failStream(pending, new Error("download exceeded requested byte limit"));
    clearTimeout(pending.timeout);
    pendingHttpDownloads.delete(commandId);
    pending.resolve(pending);
    return;
  }
  if (pending.total > 0 && !pending.loggedTotal) {
    pending.loggedTotal = true;
    logger.debug("[filebrowser] http download total", {
      commandId,
      total: pending.total,
      rawTotalType: typeof rawTotal,
      mode: isStreamMode(pending) ? "stream" : "buffer",
    });
  }

  if (payload?.data) {
    let data = payload.data;
    try {
      if (data instanceof ArrayBuffer) {
        data = new Uint8Array(data);
      } else if (typeof data === "string") {
        data = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      } else if (ArrayBuffer.isView(data)) {
        data = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      }
    } catch {
      await failStream(pending, new Error("invalid download chunk encoding"));
      clearTimeout(pending.timeout);
      pendingHttpDownloads.delete(commandId);
      pending.resolve(pending);
      return;
    }

    if (data instanceof Uint8Array) {
      const offset = toNumber(payload?.offset);
      const chunkIndex = toNumber(payload?.chunkIndex);
      const chunksTotal = toNumber(payload?.chunksTotal);

      if (data.byteLength > STREAM_MAX_CHUNK_BYTES) {
        await failStream(pending, new Error("download chunk exceeded size limit"));
        clearTimeout(pending.timeout);
        pendingHttpDownloads.delete(commandId);
        pending.resolve(pending);
        return;
      }
      if (pending.maxBytes && pending.receivedBytes + data.byteLength > pending.maxBytes) {
        await failStream(pending, new Error("download exceeded requested byte limit"));
        clearTimeout(pending.timeout);
        pendingHttpDownloads.delete(commandId);
        pending.resolve(pending);
        return;
      }

      if (offset === null) {
        logger.debug("[filebrowser] http download missing offset", {
          commandId,
          rawOffsetType: typeof payload?.offset,
        });
      }

      if (!pending.chunkSize && data.length > 0) {
        pending.chunkSize = data.length;
      }
      if (pending.expectedChunks === 0) {
        if (chunksTotal && chunksTotal > 0) {
          pending.expectedChunks = chunksTotal;
        } else if (pending.total > 0 && pending.chunkSize > 0) {
          pending.expectedChunks = Math.ceil(pending.total / pending.chunkSize);
        }
      }

      if (!pending.loggedFirstChunk) {
        pending.loggedFirstChunk = true;
        logger.debug("[filebrowser] http download first chunk", {
          commandId,
          size: data.length,
          offset,
          chunkIndex,
          chunksTotal,
          expectedChunks: pending.expectedChunks,
          mode: isStreamMode(pending) ? "stream" : "buffer",
        });
      }

      const effectiveOffset = offset ?? 0;
      if (effectiveOffset < 0
          || !Number.isSafeInteger(effectiveOffset)
          || (pending.total > 0 && effectiveOffset + data.byteLength > pending.total)) {
        await failStream(pending, new Error("invalid download chunk offset"));
        clearTimeout(pending.timeout);
        pendingHttpDownloads.delete(commandId);
        pending.resolve(pending);
        return;
      }
      const shouldWrite = chunkIndex !== null
        ? !pending.receivedChunks.has(chunkIndex)
        : !pending.receivedOffsets.has(effectiveOffset);

      if (shouldWrite) {
        if (isStreamMode(pending)) {
          const accepted = enqueueOrdered(pending, effectiveOffset, data);
          if (!accepted) {
            clearTimeout(pending.timeout);
            pendingHttpDownloads.delete(commandId);
            pending.resolve(pending);
            return;
          }
        } else {
          try {
            await pending.fileHandle.write(data, 0, data.length, effectiveOffset);
          } catch (err) {
            await teardownPending(pending, pendingHttpDownloads);
            pending.reject(err as Error);
            return;
          }
        }
        if (chunkIndex !== null) {
          pending.receivedChunks.add(chunkIndex);
        } else {
          pending.receivedOffsets.add(effectiveOffset);
        }
        pending.receivedBytes += data.length;

        if (!pending.firstChunkSignaled && pending.onFirstChunk) {
          pending.firstChunkSignaled = true;
          try { pending.onFirstChunk(); } catch {}
        }
      }
    }
  }

  const receivedChunkCount = pending.receivedChunks.size + pending.receivedOffsets.size;
  const hasAllChunks = pending.expectedChunks > 0
    ? receivedChunkCount >= pending.expectedChunks
    : pending.total > 0 && pending.receivedBytes >= pending.total;

  if ((pending.total > 0 ? pending.receivedBytes >= pending.total : hasAllChunks && pending.receivedBytes > 0) && hasAllChunks) {
    clearTimeout(pending.timeout);
    pendingHttpDownloads.delete(commandId);
    if (isStreamMode(pending)) {
      if (pending.reorderBuffer && pending.reorderBuffer.size > 0 && !pending.streamErrored) {
        await failStream(pending, new Error("download completed with gaps in chunk stream"));
      } else if (!pending.streamErrored) {
        try { pending.streamController?.close(); } catch {}
      }
    } else {
      try {
        await pending.fileHandle.close();
      } catch {}
    }
    pending.resolve(pending);
  }
}
