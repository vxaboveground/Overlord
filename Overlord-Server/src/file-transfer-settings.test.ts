import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getConfig, updateFileTransfersConfig, type Config } from "./config";
import { getFileTransferLimits } from "./server/file-transfer-state";

let original: Config["fileTransfers"];

beforeAll(() => {
  original = { ...getConfig().fileTransfers };
});

afterAll(async () => {
  await updateFileTransfersConfig(original);
});

describe("file transfer settings", () => {
  test("saved limits are visible to transfer handlers immediately", async () => {
    await updateFileTransfersConfig({
      maxFileBytes: 25 * 1024 * 1024,
      maxStagedBytes: 100 * 1024 * 1024,
      maxActiveGlobal: 8,
      maxActivePerUser: 2,
      uploadIntentTtlMs: 5 * 60_000,
      uploadPullTtlMs: 10 * 60_000,
    });

    expect(getFileTransferLimits()).toEqual({
      maxFileBytes: 25 * 1024 * 1024,
      maxStagedBytes: 100 * 1024 * 1024,
      maxActiveGlobal: 8,
      maxActivePerUser: 2,
      uploadIntentTtlMs: 5 * 60_000,
      uploadPullTtlMs: 10 * 60_000,
    });
  });

  test("dependent limits are clamped to safe relationships", async () => {
    const updated = await updateFileTransfersConfig({
      maxFileBytes: 20 * 1024 * 1024,
      maxStagedBytes: 10 * 1024 * 1024,
      maxActiveGlobal: 3,
      maxActivePerUser: 20,
      uploadIntentTtlMs: 1,
      uploadPullTtlMs: 1,
    });

    expect(updated.maxStagedBytes).toBe(updated.maxFileBytes);
    expect(updated.maxActivePerUser).toBe(updated.maxActiveGlobal);
    expect(updated.uploadIntentTtlMs).toBe(60_000);
    expect(updated.uploadPullTtlMs).toBe(60_000);
  });
});
