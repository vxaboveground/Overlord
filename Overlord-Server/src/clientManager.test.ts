import { describe, expect, test, afterEach } from "bun:test";
import {
  addClient,
  getClient,
  deleteClient,
  hasClient,
  getAllClients,
  getClientCount,
  getOnlineClients,
} from "./clientManager";
import type { ClientInfo } from "./types";

function makeClient(id: string, overrides: Partial<ClientInfo> = {}): ClientInfo {
  return {
    id,
    lastSeen: Date.now(),
    role: "client",
    ws: { send: () => {}, close: () => {} },
    ...overrides,
  };
}

function uniqueId(): string {
  return `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

describe("clientManager", () => {
  const ids: string[] = [];

  function tracked(id: string) {
    ids.push(id);
    return id;
  }

  afterEach(() => {
    for (const id of ids) deleteClient(id);
    ids.length = 0;
  });

  test("addClient + getClient round-trip", () => {
    const id = tracked(uniqueId());
    const info = makeClient(id);
    addClient(id, info);
    expect(getClient(id)).toBe(info);
  });

  test("getClient returns undefined for unknown id", () => {
    expect(getClient("nonexistent-client-xyz")).toBeUndefined();
  });

  test("hasClient returns true/false correctly", () => {
    const id = tracked(uniqueId());
    expect(hasClient(id)).toBe(false);
    addClient(id, makeClient(id));
    expect(hasClient(id)).toBe(true);
  });

  test("deleteClient removes and returns true", () => {
    const id = tracked(uniqueId());
    addClient(id, makeClient(id));
    expect(deleteClient(id)).toBe(true);
    expect(hasClient(id)).toBe(false);
  });

  test("deleteClient returns false for unknown id", () => {
    expect(deleteClient("nonexistent-client-xyz")).toBe(false);
  });

  test("getClientCount reflects add/delete", () => {
    const before = getClientCount();
    const id = tracked(uniqueId());
    addClient(id, makeClient(id));
    expect(getClientCount()).toBe(before + 1);
    deleteClient(id);
    expect(getClientCount()).toBe(before);
  });

  test("getAllClients returns the backing map", () => {
    const id = tracked(uniqueId());
    addClient(id, makeClient(id));
    const all = getAllClients();
    expect(all instanceof Map).toBe(true);
    expect(all.has(id)).toBe(true);
  });

  test("addClient overwrites existing entry", () => {
    const id = tracked(uniqueId());
    const first = makeClient(id, { host: "first" });
    const second = makeClient(id, { host: "second" });
    addClient(id, first);
    addClient(id, second);
    expect(getClient(id)?.host).toBe("second");
  });

  test("getOnlineClients only returns recently-seen clients", () => {
    const freshId = tracked(uniqueId());
    const staleId = tracked(uniqueId());

    addClient(freshId, makeClient(freshId, { lastSeen: Date.now() }));
    addClient(staleId, makeClient(staleId, { lastSeen: Date.now() - 120_000 }));

    const online = getOnlineClients();
    const onlineIds = online.map((c) => c.id);
    expect(onlineIds).toContain(freshId);
    expect(onlineIds).not.toContain(staleId);
  });

  test("getOnlineClients returns empty when no clients are recent", () => {
    const id = tracked(uniqueId());
    addClient(id, makeClient(id, { lastSeen: Date.now() - 120_000 }));
    const online = getOnlineClients();
    expect(online.find((c) => c.id === id)).toBeUndefined();
  });
});
