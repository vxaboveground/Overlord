import { describe, expect, test } from "bun:test";
import type { ClientInfo } from "./types";
import { decodeMessage } from "./protocol";
import { metrics } from "./metrics";
import { handleFrame, handlePing, handlePong, sendPingRequest, shouldRelayFrameToViewers } from "./wsHandlers";

type MockWs = { sent: Uint8Array[]; send: (msg: Uint8Array) => void };

describe("wsHandlers ping/pong", () => {
  test("sendPingRequest sends a ping once per outstanding nonce", () => {
    const ws: MockWs = {
      sent: [],
      send(msg) {
        this.sent.push(msg);
      },
    };
    const info = {
      id: "client-1",
      role: "client",
      ws,
      lastSeen: Date.now(),
    } as any;

    sendPingRequest(info, ws, "test");
    expect(ws.sent.length).toBe(1);
    const payload = decodeMessage(ws.sent[0]) as any;
    expect(payload.type).toBe("ping");
    expect(typeof payload.ts).toBe("number");

    sendPingRequest(info, ws, "test");
    expect(ws.sent.length).toBe(1);
  });

  test("sendPingRequest can bypass the interval for manual pings", () => {
    const ws: MockWs = {
      sent: [],
      send(msg) {
        this.sent.push(msg);
      },
    };
    const info = {
      id: "client-manual-ping",
      role: "client",
      ws,
      lastSeen: Date.now(),
    } as any;

    expect(sendPingRequest(info, ws, "test")).toBe(true);
    expect(sendPingRequest(info, ws, "manual", 0)).toBe(true);
    expect(ws.sent.length).toBe(2);
  });

  test("handlePing responds with pong without starting another server ping", () => {
    const ws: MockWs = {
      sent: [],
      send(msg) {
        this.sent.push(msg);
      },
    };
    const info = {
      id: "client-ping",
      role: "client",
      ws,
      lastSeen: Date.now(),
    } as any;

    handlePing(info, { type: "ping", ts: 9876 } as any, ws);

    expect(ws.sent.length).toBe(1);
    const payload = decodeMessage(ws.sent[0]) as any;
    expect(payload.type).toBe("pong");
    expect(payload.ts).toBe(9876);
    expect(info.lastPingNonce).toBeUndefined();
  });

  test("handlePing preserves zero timestamps", () => {
    const ws: MockWs = {
      sent: [],
      send(msg) {
        this.sent.push(msg);
      },
    };
    const info = {
      id: "client-zero-ping",
      role: "client",
      ws,
      lastSeen: Date.now(),
    } as any;

    handlePing(info, { type: "ping", ts: 0 } as any, ws);

    const payload = decodeMessage(ws.sent[0]) as any;
    expect(payload.type).toBe("pong");
    expect(payload.ts).toBe(0);
  });

  test("handlePing falls back for invalid timestamps", () => {
    const ws: MockWs = {
      sent: [],
      send(msg) {
        this.sent.push(msg);
      },
    };
    const info = {
      id: "client-invalid-ping",
      role: "client",
      ws,
      lastSeen: Date.now(),
    } as any;
    const before = Date.now();

    handlePing(info, { type: "ping", ts: "bad" } as any, ws);

    const payload = decodeMessage(ws.sent[0]) as any;
    expect(payload.type).toBe("pong");
    expect(payload.ts).toBeGreaterThanOrEqual(before);
    expect(payload.ts).toBeLessThanOrEqual(Date.now());
  });

  test("handlePong clears nonce and records ping", () => {
    metrics.reset();
    const ws: MockWs = {
      sent: [],
      send(msg) {
        this.sent.push(msg);
      },
    };
    const now = Date.now();
    const info = {
      id: "client-2",
      role: "client",
      ws,
      lastSeen: now,
      lastPingSent: now - 10,
      lastPingNonce: 1234,
    } as any;

    handlePong(info, { type: "pong", ts: 1234 } as any);
    expect(info.lastPingNonce).toBeUndefined();
    expect(typeof info.pingMs).toBe("number");
    const snapshot = metrics.getSnapshot();
    expect(snapshot.ping.count).toBeGreaterThan(0);
  });

  test("handlePong ignores mismatched nonces", () => {
    const now = Date.now();
    const info = {
      id: "client-3",
      role: "client",
      ws: { sent: [], send() {} },
      lastSeen: now,
      lastPingSent: now - 10,
      lastPingNonce: 2222,
    } as any;

    handlePong(info, { type: "pong", ts: 3333 } as any);
    expect(info.lastPingNonce).toBe(2222);
  });

  test("handlePong clears matching nonce even when pong is late", () => {
    metrics.reset();
    const now = Date.now();
    const info = {
      id: "client-4",
      role: "client",
      ws: { sent: [], send() {} },
      lastSeen: now - 60_000,
      online: false,
      lastPingSent: now - 20_000,
      lastPingNonce: 4444,
    } as any;

    handlePong(info, { type: "pong", ts: 4444 } as any);

    expect(info.lastPingNonce).toBeUndefined();
    expect(info.online).toBe(true);
    expect(info.lastSeen).toBeGreaterThan(now - 5_000);
    const snapshot = metrics.getSnapshot();
    expect(snapshot.ping.count).toBe(0);
  });
});

describe("wsHandlers frame routing", () => {
  test("keeps screenshot frames out of remote desktop viewers", () => {
    const broadcasts: unknown[] = [];
    const runtime = globalThis as unknown as {
      __rdBroadcast?: (clientId: string, bytes: Uint8Array, header: unknown) => boolean;
    };
    runtime.__rdBroadcast = (clientId, bytes, header) => {
      broadcasts.push({ clientId, bytes, header });
      return true;
    };
    const client = {
      id: "screenshot-client",
      lastSeen: Date.now(),
      online: true,
      isAdmin: false,
    } as unknown as ClientInfo;
    const screenshotFrame = {
      type: "frame",
      header: { fps: 0, format: "h264", width: 1920, height: 1080 },
      data: new Uint8Array([1, 2, 3]),
    };

    try {
      expect(shouldRelayFrameToViewers(screenshotFrame)).toBe(false);
      handleFrame(client, screenshotFrame, shouldRelayFrameToViewers(screenshotFrame));
      expect(broadcasts).toHaveLength(0);

      const liveFrame = { ...screenshotFrame, header: { ...screenshotFrame.header, fps: 60 } };
      expect(shouldRelayFrameToViewers(liveFrame)).toBe(true);
      handleFrame(client, liveFrame, shouldRelayFrameToViewers(liveFrame));
      expect(broadcasts).toHaveLength(1);
    } finally {
      delete runtime.__rdBroadcast;
    }
  });
});
