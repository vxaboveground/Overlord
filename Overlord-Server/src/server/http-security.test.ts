import { describe, expect, test } from "bun:test";
import { CORS_HEADERS, SECURITY_HEADERS } from "./http-security";

describe("CORS_HEADERS", () => {
  test("has restrictive Access-Control-Allow-Origin", () => {
    expect(CORS_HEADERS["Access-Control-Allow-Origin"]).toBe("null");
  });

  test("limits allowed methods", () => {
    expect(CORS_HEADERS["Access-Control-Allow-Methods"]).toContain("GET");
    expect(CORS_HEADERS["Access-Control-Allow-Methods"]).toContain("OPTIONS");
  });

  test("allows Content-Type header", () => {
    expect(CORS_HEADERS["Access-Control-Allow-Headers"]).toContain("Content-Type");
  });
});

describe("SECURITY_HEADERS", () => {
  test("sets Content-Security-Policy with self default-src", () => {
    const csp = SECURITY_HEADERS["Content-Security-Policy"];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("font-src 'self' data:");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  test("prevents MIME sniffing", () => {
    expect(SECURITY_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
  });

  test("denies framing", () => {
    expect(SECURITY_HEADERS["X-Frame-Options"]).toBe("DENY");
  });

  test("enables XSS protection", () => {
    expect(SECURITY_HEADERS["X-XSS-Protection"]).toBe("1; mode=block");
  });

  test("sets strict referrer policy", () => {
    expect(SECURITY_HEADERS["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  });

  test("enables HSTS with long max-age", () => {
    const hsts = SECURITY_HEADERS["Strict-Transport-Security"];
    expect(hsts).toContain("max-age=");
    expect(hsts).toContain("includeSubDomains");
    const maxAge = Number(hsts.match(/max-age=(\d+)/)?.[1] || 0);
    expect(maxAge).toBeGreaterThanOrEqual(31536000);
  });

  test("disables camera, geolocation, payment via Permissions-Policy", () => {
    const pp = SECURITY_HEADERS["Permissions-Policy"];
    expect(pp).toContain("camera=()");
    expect(pp).toContain("geolocation=()");
    expect(pp).toContain("payment=()");
  });
});
