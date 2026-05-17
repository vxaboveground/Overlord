import { describe, expect, test } from "bun:test";
import { mimeType, secureHeaders } from "./http-utils";
import { SECURITY_HEADERS } from "./http-security";

describe("mimeType", () => {
  test("maps common web extensions", () => {
    expect(mimeType("index.html")).toBe("text/html; charset=utf-8");
    expect(mimeType("app.css")).toBe("text/css; charset=utf-8");
    expect(mimeType("bundle.js")).toBe("text/javascript; charset=utf-8");
    expect(mimeType("worker.mjs")).toBe("text/javascript; charset=utf-8");
    expect(mimeType("data.json")).toBe("application/json");
  });

  test("maps image extensions", () => {
    expect(mimeType("a.png")).toBe("image/png");
    expect(mimeType("a.jpg")).toBe("image/jpeg");
    expect(mimeType("a.jpeg")).toBe("image/jpeg");
    expect(mimeType("a.webp")).toBe("image/webp");
    expect(mimeType("a.svg")).toBe("image/svg+xml");
    expect(mimeType("a.ico")).toBe("image/x-icon");
  });

  test("maps font extensions", () => {
    expect(mimeType("Inter.woff")).toBe("font/woff");
    expect(mimeType("Inter.woff2")).toBe("font/woff2");
    expect(mimeType("Inter.ttf")).toBe("font/ttf");
  });

  test("is case insensitive on the extension", () => {
    expect(mimeType("PIC.PNG")).toBe("image/png");
    expect(mimeType("Style.CSS")).toBe("text/css; charset=utf-8");
  });

  test("uses only the final extension", () => {
    expect(mimeType("archive.tar.gz")).toBe("application/octet-stream");
    expect(mimeType("script.min.js")).toBe("text/javascript; charset=utf-8");
  });

  test("returns octet-stream for unknown extensions", () => {
    expect(mimeType("file.xyz")).toBe("application/octet-stream");
    expect(mimeType("binary.bin")).toBe("application/octet-stream");
  });

  test("returns octet-stream when there is no extension", () => {
    expect(mimeType("README")).toBe("application/octet-stream");
    expect(mimeType("")).toBe("application/octet-stream");
  });

  test("handles full paths", () => {
    expect(mimeType("/var/www/index.html")).toBe("text/html; charset=utf-8");
    expect(mimeType("C:\\dist\\app.js")).toBe("text/javascript; charset=utf-8");
  });
});

describe("secureHeaders", () => {
  test("includes every security header by default", () => {
    const headers = secureHeaders();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(headers[name as keyof typeof headers]).toBe(value);
    }
  });

  test("omits Content-Type when none provided", () => {
    const headers = secureHeaders();
    expect((headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  test("adds Content-Type when provided", () => {
    const headers = secureHeaders("application/json");
    expect((headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  test("returns a fresh object each call (no shared mutation)", () => {
    const a = secureHeaders("text/plain") as Record<string, string>;
    const b = secureHeaders("text/html") as Record<string, string>;
    a["Content-Type"] = "mutated";
    expect(b["Content-Type"]).toBe("text/html");
  });
});
