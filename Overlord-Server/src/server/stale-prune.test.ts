import { describe, expect, test } from "bun:test";
import { pruneStaleClients } from "./stale-prune";
import type { ClientInfo } from "../types";

function makeClient(id: string, lastSeen: number, role: "client" | "viewer" = "client"): ClientInfo {
  const calls: string[] = [];
  return {
    id,
    lastSeen,
    role,
    ws: {
      close(...args: any[]) { calls.push(`close:${args.join(",")}`); },
      send() {},
      _calls: calls,
    },
  } as any;
}

describe("pruneStaleClients", () => {
  test("does nothing when all clients are fresh", () => {
    const clients = new Map<string, ClientInfo>();
    clients.set("a", makeClient("a", Date.now()));

    const offlined: string[] = [];
    const deleted: string[] = [];

    pruneStaleClients({
      clients,
      staleMs: 60_000,
      pruneBatch: 10,
      setOnlineState: (id, online) => { if (!online) offlined.push(id); },
      deleteClient: (id) => { deleted.push(id); },
    });

    expect(offlined).toEqual([]);
    expect(deleted).toEqual([]);
  });

  test("closes and marks offline stale role=client entries without deleting", () => {
    const clients = new Map<string, ClientInfo>();
    const staleClient = makeClient("stale-c", Date.now() - 120_000, "client");
    clients.set("stale-c", staleClient);

    const offlined: string[] = [];
    const deleted: string[] = [];

    pruneStaleClients({
      clients,
      staleMs: 60_000,
      pruneBatch: 10,
      setOnlineState: (id, online) => { if (!online) offlined.push(id); },
      deleteClient: (id) => { deleted.push(id); },
    });

    expect(offlined).toContain("stale-c");
    expect(deleted).not.toContain("stale-c");
    expect((staleClient.ws as any)._calls[0]).toStartWith("close:");
  });

  test("closes and deletes stale non-client (viewer) entries", () => {
    const clients = new Map<string, ClientInfo>();
    const viewer = makeClient("stale-v", Date.now() - 120_000, "viewer");
    clients.set("stale-v", viewer);

    const offlined: string[] = [];
    const deleted: string[] = [];

    pruneStaleClients({
      clients,
      staleMs: 60_000,
      pruneBatch: 10,
      setOnlineState: (id, online) => { if (!online) offlined.push(id); },
      deleteClient: (id) => { deleted.push(id); },
    });

    expect(deleted).toContain("stale-v");
    expect(offlined).toContain("stale-v");
  });

  test("respects pruneBatch limit", () => {
    const clients = new Map<string, ClientInfo>();
    for (let i = 0; i < 5; i++) {
      clients.set(`s-${i}`, makeClient(`s-${i}`, Date.now() - 200_000, "viewer"));
    }

    let pruned = 0;

    pruneStaleClients({
      clients,
      staleMs: 60_000,
      pruneBatch: 2,
      setOnlineState: () => { pruned++; },
      deleteClient: () => {},
    });

    expect(pruned).toBe(2);
  });

  test("mixes fresh and stale correctly", () => {
    const clients = new Map<string, ClientInfo>();
    clients.set("fresh", makeClient("fresh", Date.now()));
    clients.set("stale", makeClient("stale", Date.now() - 200_000, "viewer"));

    const offlined: string[] = [];
    const deleted: string[] = [];

    pruneStaleClients({
      clients,
      staleMs: 60_000,
      pruneBatch: 10,
      setOnlineState: (id, online) => { if (!online) offlined.push(id); },
      deleteClient: (id) => { deleted.push(id); },
    });

    expect(offlined).toContain("stale");
    expect(offlined).not.toContain("fresh");
    expect(deleted).toContain("stale");
    expect(deleted).not.toContain("fresh");
  });
});
