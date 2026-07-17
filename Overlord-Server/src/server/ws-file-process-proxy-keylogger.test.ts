import { describe, expect, test } from "bun:test";
import { handleFileBrowserMessage } from "./ws-file-process-proxy-keylogger";

describe("file browser agent download routing", () => {
  test("only consumes pending HTTP downloads for the matching client", () => {
    let consumed = 0;
    const payload = { type: "file_download", commandId: "download-1", data: new Uint8Array([1]) };
    const deps = {
      pendingHttpDownloads: new Map([["download-1", { clientId: "client-a" }]]),
      consumeHttpDownloadPayload: () => { consumed += 1; },
    };

    handleFileBrowserMessage("client-b", payload, deps);
    expect(consumed).toBe(0);

    handleFileBrowserMessage("client-a", payload, deps);
    expect(consumed).toBe(1);
  });

  test("drops unsolicited download payloads", () => {
    let consumed = 0;
    handleFileBrowserMessage(
      "client-a",
      { type: "file_download", commandId: "unknown", data: new Uint8Array([1]) },
      {
        pendingHttpDownloads: new Map(),
        consumeHttpDownloadPayload: () => { consumed += 1; },
      },
    );
    expect(consumed).toBe(0);
  });
});
