import { describe, expect, test } from "bun:test";
import {
  consumeHttpDownloadPayload,
  STREAM_MAX_CHUNK_BYTES,
  STREAM_OUTPUT_QUEUE_MAX_CHUNKS,
  type PendingHttpDownload,
} from "./http-download-consumer";

function pendingDownload(overrides: Partial<PendingHttpDownload> = {}) {
  let resolved = false;
  let streamError = "";
  const pending: PendingHttpDownload = {
    commandId: "cmd",
    clientId: "client",
    path: "/tmp/file",
    fileName: "file",
    total: 0,
    receivedBytes: 0,
    receivedOffsets: new Set(),
    receivedChunks: new Set(),
    chunkSize: 0,
    expectedChunks: 0,
    tmpPath: "",
    fileHandle: null as any,
    resolve: () => { resolved = true; },
    reject: () => {},
    timeout: setTimeout(() => {}, 60_000),
    streamController: {
      enqueue() {},
      close() {},
      error(error: Error) { streamError = error.message; },
    } as any,
    ...overrides,
  };
  return { pending, state: () => ({ resolved, streamError }) };
}

describe("HTTP download stream limits", () => {
  test("rejects chunks larger than the agent protocol maximum", async () => {
    const fixture = pendingDownload();
    const entries = new Map([[fixture.pending.commandId, fixture.pending]]);
    await consumeHttpDownloadPayload({
      commandId: "cmd", offset: 0, total: STREAM_MAX_CHUNK_BYTES + 1,
      data: new Uint8Array(STREAM_MAX_CHUNK_BYTES + 1),
    }, entries);
    clearTimeout(fixture.pending.timeout);
    expect(entries.has("cmd")).toBeFalse();
    expect(fixture.state().streamError).toContain("chunk exceeded");
  });

  test("enforces preview byte budgets from total metadata", async () => {
    const fixture = pendingDownload({ maxBytes: 1024 });
    const entries = new Map([[fixture.pending.commandId, fixture.pending]]);
    await consumeHttpDownloadPayload({ commandId: "cmd", total: 2048 }, entries);
    clearTimeout(fixture.pending.timeout);
    expect(entries.has("cmd")).toBeFalse();
    expect(fixture.state().streamError).toContain("requested byte limit");
  });

  test("bounds queued output when the HTTP receiver stops consuming", async () => {
    const fixture = pendingDownload({
      streamController: {
        desiredSize: -STREAM_OUTPUT_QUEUE_MAX_CHUNKS,
        enqueue() {},
        close() {},
        error(error: Error) { fixtureError = error.message; },
      } as any,
    });
    let fixtureError = "";
    const entries = new Map([[fixture.pending.commandId, fixture.pending]]);
    await consumeHttpDownloadPayload({
      commandId: "cmd", offset: 0, total: 4, data: new Uint8Array(4),
    }, entries);
    clearTimeout(fixture.pending.timeout);
    expect(entries.has("cmd")).toBeFalse();
    expect(fixtureError).toContain("not consuming");
  });

  test("rejects malformed encoded chunks without throwing", async () => {
    const fixture = pendingDownload();
    const entries = new Map([[fixture.pending.commandId, fixture.pending]]);
    await consumeHttpDownloadPayload({ commandId: "cmd", data: "%%%not-base64%%%" }, entries);
    clearTimeout(fixture.pending.timeout);
    expect(entries.has("cmd")).toBeFalse();
    expect(fixture.state().streamError).toContain("encoding");
  });
});
