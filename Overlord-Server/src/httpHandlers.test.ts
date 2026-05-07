import { describe, expect, test, afterEach } from "bun:test";
import { handleCommand, handleClientsRequest } from "./httpHandlers";
import * as clientManager from "./clientManager";
import type { ClientInfo } from "./types";

function makeClient(id: string, overrides: Partial<ClientInfo> = {}): ClientInfo {
  const sent: any[] = [];
  return {
    id,
    lastSeen: Date.now(),
    role: "client",
    ws: {
      send(data: any) { sent.push(data); },
      close() {},
      _sent: sent,
    },
    ...overrides,
  };
}

function uniqueId(): string {
  return `hh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

describe("handleCommand", () => {
  const ids: string[] = [];

  afterEach(() => {
    for (const id of ids) clientManager.deleteClient(id);
    ids.length = 0;
  });

  function tracked(id: string) {
    ids.push(id);
    return id;
  }

  test("ping sets lastPingSent and lastPingNonce on the target", () => {
    const id = tracked(uniqueId());
    const client = makeClient(id);
    clientManager.addClient(id, client);

    const req = new Request("https://localhost/api/command?action=ping");
    const res = handleCommand(client, "ping", req);
    expect(res.status).toBe(200);
    expect(client.lastPingSent).toBeGreaterThan(0);
    expect(typeof client.lastPingNonce).toBe("number");
    expect((client.ws as any)._sent.length).toBe(1);
  });

  test("simple commands return ok and send message", () => {
    for (const action of ["desktop_start", "desktop_stop", "disconnect", "reconnect"]) {
      const id = tracked(uniqueId());
      const client = makeClient(id);

      const req = new Request(`https://localhost/api/command?action=${action}`);
      const res = handleCommand(client, action, req);
      expect(res.status).toBe(200);
      expect((client.ws as any)._sent.length).toBe(1);
    }
  });

  test("payload commands return ok", () => {
    for (const action of ["desktop_select_display", "desktop_enable_mouse", "desktop_enable_keyboard"]) {
      const id = tracked(uniqueId());
      const client = makeClient(id);

      const req = new Request(`https://localhost/api/command?action=${action}`);
      const res = handleCommand(client, action, req);
      expect(res.status).toBe(200);
      expect((client.ws as any)._sent.length).toBe(1);
    }
  });

  test("file commands pass path from query string", () => {
    for (const action of ["file_list", "file_download", "file_delete", "file_mkdir", "file_zip"]) {
      const id = tracked(uniqueId());
      const client = makeClient(id);

      const req = new Request(`https://localhost/api/command?action=${action}&path=C%3A%5CUsers`);
      const res = handleCommand(client, action, req);
      expect(res.status).toBe(200);
      expect((client.ws as any)._sent.length).toBe(1);
    }
  });

  test("unknown action returns 400", () => {
    const id = tracked(uniqueId());
    const client = makeClient(id);

    const req = new Request("https://localhost/api/command?action=bogus_action");
    const res = handleCommand(client, "bogus_action", req);
    expect(res.status).toBe(400);
    expect((client.ws as any)._sent.length).toBe(0);
  });
});

describe("handleClientsRequest", () => {
  test("returns valid JSON with expected shape", () => {
    const req = new Request("https://localhost/api/clients?page=1&pageSize=5");
    const res = handleClientsRequest(req);
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") || "";
    expect(ct).toContain("json");
  });
});
