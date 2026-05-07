import { describe, expect, test, afterEach } from "bun:test";
import { isAuthorizedAgentRequest } from "./agent-auth";

function makeReq(headers: Record<string, string> = {}): Request {
  return new Request("https://localhost/ws", { headers });
}

function makeUrl(query: Record<string, string> = {}): URL {
  const u = new URL("https://localhost/ws");
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u;
}

describe("isAuthorizedAgentRequest", () => {
  const originalEnv: Record<string, string | undefined> = {};

  function setEnv(key: string, value: string | undefined) {
    if (!(key in originalEnv)) originalEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const k of Object.keys(originalEnv)) delete originalEnv[k];
  });

  test("returns true when agentToken is empty/undefined", () => {
    expect(isAuthorizedAgentRequest(makeReq(), makeUrl(), "")).toBe(true);
    expect(isAuthorizedAgentRequest(makeReq(), makeUrl(), undefined)).toBe(true);
  });

  test("authenticates via x-agent-token header", () => {
    const token = "secret-agent-token-abc123";
    const req = makeReq({ "x-agent-token": token });
    expect(isAuthorizedAgentRequest(req, makeUrl(), token)).toBe(true);
  });

  test("authenticates via query string token", () => {
    const token = "secret-agent-token-abc123";
    const url = makeUrl({ token });
    expect(isAuthorizedAgentRequest(makeReq(), url, token)).toBe(true);
  });

  test("rejects wrong header token", () => {
    const req = makeReq({ "x-agent-token": "wrong" });
    expect(isAuthorizedAgentRequest(req, makeUrl(), "correct-token")).toBe(false);
  });

  test("rejects wrong query token", () => {
    const url = makeUrl({ token: "wrong" });
    expect(isAuthorizedAgentRequest(makeReq(), url, "correct-token")).toBe(false);
  });

  test("rejects when no token is provided but agentToken is set", () => {
    expect(isAuthorizedAgentRequest(makeReq(), makeUrl(), "required-token")).toBe(false);
  });

  test("OVERLORD_DISABLE_AGENT_AUTH bypasses in non-production", () => {
    setEnv("OVERLORD_DISABLE_AGENT_AUTH", "true");
    setEnv("NODE_ENV", "development");
    expect(isAuthorizedAgentRequest(makeReq(), makeUrl(), "secret")).toBe(true);
  });

  test("OVERLORD_DISABLE_AGENT_AUTH is ignored in production", () => {
    setEnv("OVERLORD_DISABLE_AGENT_AUTH", "true");
    setEnv("NODE_ENV", "production");
    expect(isAuthorizedAgentRequest(makeReq(), makeUrl(), "secret")).toBe(false);
  });

  test("header token takes priority when both header and query are present", () => {
    const token = "the-real-token";
    const req = makeReq({ "x-agent-token": token });
    const url = makeUrl({ token: "wrong-query-token" });
    expect(isAuthorizedAgentRequest(req, url, token)).toBe(true);
  });
});
