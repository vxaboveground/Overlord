import { describe, expect, test } from "bun:test";
import {
  FILE_BROWSER_MAX_ICON_ITEMS,
  validateFileBrowserCommandPayload,
} from "./file-browser-security";

describe("file browser command payload validation", () => {
  test("caps read and peek sizes", () => {
    expect(validateFileBrowserCommandPayload("file_read", { path: "C:\\ok.txt", maxSize: 99_999_999 })?.maxSize)
      .toBe(10 * 1024 * 1024);
    expect(validateFileBrowserCommandPayload("file_peek", { path: "/tmp/ok", bytes: 99_999 })?.bytes)
      .toBe(4096);
  });

  test("rejects control characters and oversized paths", () => {
    expect(validateFileBrowserCommandPayload("file_read", { path: "C:\\bad\0.txt" })).toBeNull();
    expect(validateFileBrowserCommandPayload("file_read", { path: "x".repeat(4097) })).toBeNull();
  });

  test("bounds icon and thumbnail batches", () => {
    const icons = Array.from({ length: FILE_BROWSER_MAX_ICON_ITEMS + 1 }, (_, i) => ({ key: `ext:${i}`, ext: "txt" }));
    expect(validateFileBrowserCommandPayload("file_icon", { items: icons })).toBeNull();
    expect(validateFileBrowserCommandPayload("file_thumb", {
      items: [{ key: "thumb:ok", path: "C:\\ok.png", size: 96 }],
    })).not.toBeNull();
  });

  test("only permits agent upload pulls served by this application", () => {
    expect(validateFileBrowserCommandPayload("file_upload_http", {
      path: "C:\\ok.bin",
      url: "/api/file/upload/pull/123e4567-e89b-42d3-a456-426614174000",
      total: 10,
    })).not.toBeNull();
    expect(validateFileBrowserCommandPayload("file_upload_http", {
      path: "C:\\ok.bin", url: "https://attacker.invalid/payload", total: 10,
    })).toBeNull();
  });
});
