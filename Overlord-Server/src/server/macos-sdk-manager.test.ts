import { describe, expect, test } from "bun:test";
import {
  claimMacosSdkUpload,
  cleanupMacosSdkUpload,
  stageMacosSdkUpload,
} from "./macos-sdk-manager";

function uploadRequest(body = "archive", overrides: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/build/macos-sdk/upload", {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-overlord-filename": "MacOSX26.5.sdk.tar.xz",
      "x-overlord-sdk-rights": "confirmed",
      ...overrides,
    },
    body,
  });
}

describe("macOS SDK uploads", () => {
  test("requires the user rights confirmation", async () => {
    await expect(stageMacosSdkUpload(uploadRequest("archive", { "x-overlord-sdk-rights": "" }), 7))
      .rejects.toThrow("right to use");
  });

  test("rejects unsupported archive formats", async () => {
    await expect(stageMacosSdkUpload(uploadRequest("archive", { "x-overlord-filename": "MacOSX.sdk.zip" }), 7))
      .rejects.toThrow(".tar");
  });

  test("is user-owned and can only be claimed once", async () => {
    const upload = await stageMacosSdkUpload(uploadRequest(), 41);
    let claimed: ReturnType<typeof claimMacosSdkUpload> | undefined;
    try {
      expect(() => claimMacosSdkUpload(upload.id, 42)).toThrow("not found");
      claimed = claimMacosSdkUpload(upload.id, 41);
      expect(claimed.size).toBe(7);
      expect(() => claimMacosSdkUpload(upload.id, 41)).toThrow("already been used");
    } finally {
      cleanupMacosSdkUpload(claimed?.uploadDir);
    }
  });
});
