import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  isTrustProxyEnabled,
  resetTrustProxyCacheForTests,
  resolveForwardedIp,
  wrapServerWithClientIp,
} from "./client-ip";

const ENV_KEYS = ["OVERLORD_TRUST_PROXY", "OVERLORD_TLS_OFFLOAD"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  resetTrustProxyCacheForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetTrustProxyCacheForTests();
});

function makeReq(headers: Record<string, string>): Request {
  return new Request("https://example.com/", { headers });
}

describe("isTrustProxyEnabled", () => {
  test("off by default", () => {
    expect(isTrustProxyEnabled()).toBe(false);
  });

  test("on when OVERLORD_TRUST_PROXY=true", () => {
    process.env.OVERLORD_TRUST_PROXY = "true";
    resetTrustProxyCacheForTests();
    expect(isTrustProxyEnabled()).toBe(true);
  });

  test("on when OVERLORD_TLS_OFFLOAD=true (implies trusted proxy)", () => {
    process.env.OVERLORD_TLS_OFFLOAD = "true";
    resetTrustProxyCacheForTests();
    expect(isTrustProxyEnabled()).toBe(true);
  });
});

describe("resolveForwardedIp - trust disabled", () => {
  test("returns peer when trust is off, ignoring X-Forwarded-For", () => {
    const req = makeReq({ "x-forwarded-for": "1.2.3.4" });
    expect(resolveForwardedIp(req, "172.18.0.1")).toBe("172.18.0.1");
  });
});

describe("resolveForwardedIp - trust enabled", () => {
  beforeEach(() => {
    process.env.OVERLORD_TRUST_PROXY = "true";
    resetTrustProxyCacheForTests();
  });

  test("picks leftmost public IP from X-Forwarded-For", () => {
    const req = makeReq({ "x-forwarded-for": "203.0.113.42, 10.0.0.1, 172.17.0.1" });
    expect(resolveForwardedIp(req, "172.17.0.1")).toBe("203.0.113.42");
  });

  test("skips private hops and picks the public client", () => {
    const req = makeReq({ "x-forwarded-for": "10.0.0.5, 203.0.113.99" });
    expect(resolveForwardedIp(req, "172.17.0.1")).toBe("203.0.113.99");
  });

  test("falls back to leftmost when all hops are private", () => {
    const req = makeReq({ "x-forwarded-for": "10.0.0.1, 172.17.0.1" });
    expect(resolveForwardedIp(req, "172.17.0.1")).toBe("10.0.0.1");
  });

  test("honors X-Real-IP when no X-Forwarded-For", () => {
    const req = makeReq({ "x-real-ip": "198.51.100.7" });
    expect(resolveForwardedIp(req, "172.17.0.1")).toBe("198.51.100.7");
  });

  test("honors CF-Connecting-IP as last resort", () => {
    const req = makeReq({ "cf-connecting-ip": "198.51.100.8" });
    expect(resolveForwardedIp(req, "172.17.0.1")).toBe("198.51.100.8");
  });

  test("falls back to peer when no forwarded headers present", () => {
    const req = makeReq({});
    expect(resolveForwardedIp(req, "172.17.0.1")).toBe("172.17.0.1");
  });

  test("strips ports and IPv6 brackets", () => {
    const req = makeReq({ "x-forwarded-for": "203.0.113.42:51234" });
    expect(resolveForwardedIp(req, "172.17.0.1")).toBe("203.0.113.42");

    const req2 = makeReq({ "x-forwarded-for": "[2001:db8::1]:443" });
    expect(resolveForwardedIp(req2, "172.17.0.1")).toBe("2001:db8::1");
  });

  test("classifies 172.17.x as private (Docker bridge)", () => {
    const req = makeReq({ "x-forwarded-for": "172.17.0.5, 203.0.113.10" });
    expect(resolveForwardedIp(req, "172.17.0.1")).toBe("203.0.113.10");
  });
});

describe("wrapServerWithClientIp", () => {
  test("requestIP returns forwarded address when trust enabled", () => {
    process.env.OVERLORD_TRUST_PROXY = "true";
    resetTrustProxyCacheForTests();

    let upgradeCalled = false;
    const fakeServer = {
      requestIP: (_req: Request) => ({ address: "172.18.0.1" }),
      upgrade: (_req: Request, _data: any) => {
        upgradeCalled = true;
        return true;
      },
    };

    const wrapped = wrapServerWithClientIp(fakeServer);
    const req = makeReq({ "x-forwarded-for": "203.0.113.55" });
    expect(wrapped.requestIP(req)?.address).toBe("203.0.113.55");

    wrapped.upgrade(req, { foo: 1 });
    expect(upgradeCalled).toBe(true);
  });

  test("requestIP returns peer when trust disabled", () => {
    const fakeServer = {
      requestIP: (_req: Request) => ({ address: "172.18.0.1" }),
      upgrade: (_req: Request, _data: any) => true,
    };
    const wrapped = wrapServerWithClientIp(fakeServer);
    const req = makeReq({ "x-forwarded-for": "203.0.113.55" });
    expect(wrapped.requestIP(req)?.address).toBe("172.18.0.1");
  });
});
