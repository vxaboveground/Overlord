import { describe, expect, test, beforeEach } from "bun:test";
import { metrics } from "./metrics";

beforeEach(() => {
  metrics.reset();
});

describe("MetricsCollector", () => {
  describe("connection tracking", () => {
    test("records connections and disconnections", () => {
      metrics.recordConnection();
      metrics.recordConnection();
      metrics.recordDisconnection();

      const snap = metrics.getSnapshot();
      expect(snap.connections.totalConnections).toBe(2);
      expect(snap.connections.totalDisconnections).toBe(1);
      expect(snap.connections.activeConnections).toBe(1);
    });

    test("active connections can go to zero", () => {
      const before = metrics.getSnapshot();
      const baseConns = before.connections.totalConnections;
      const baseDisconns = before.connections.totalDisconnections;

      metrics.recordConnection();
      metrics.recordDisconnection();

      const snap = metrics.getSnapshot();
      expect(snap.connections.totalConnections).toBe(baseConns + 1);
      expect(snap.connections.totalDisconnections).toBe(baseDisconns + 1);
      expect(snap.connections.activeConnections).toBe(before.connections.activeConnections);
    });
  });

  describe("command tracking", () => {
    test("records command count and type breakdown", () => {
      metrics.recordCommand("console");
      metrics.recordCommand("console");
      metrics.recordCommand("desktop_start");

      const snap = metrics.getSnapshot();
      expect(snap.commands.total).toBe(3);
      expect(snap.commands.byType["console"]).toBe(2);
      expect(snap.commands.byType["desktop_start"]).toBe(1);
    });

    test("commands within last minute are counted", () => {
      metrics.recordCommand("test");

      const snap = metrics.getSnapshot();
      expect(snap.commands.lastMinute).toBeGreaterThanOrEqual(1);
      expect(snap.commands.lastHour).toBeGreaterThanOrEqual(1);
    });
  });

  describe("bandwidth tracking", () => {
    test("records bytes sent and received", () => {
      metrics.recordBytesSent(1024);
      metrics.recordBytesSent(2048);
      metrics.recordBytesReceived(512);

      const snap = metrics.getSnapshot();
      expect(snap.bandwidth.sent).toBe(3072);
      expect(snap.bandwidth.received).toBe(512);
    });
  });

  describe("ping tracking", () => {
    test("returns null stats when no pings recorded", () => {
      const snap = metrics.getSnapshot();
      expect(snap.ping.min).toBeNull();
      expect(snap.ping.max).toBeNull();
      expect(snap.ping.avg).toBeNull();
      expect(snap.ping.count).toBe(0);
    });

    test("computes min/max/avg correctly", () => {
      metrics.recordPing(10);
      metrics.recordPing(20);
      metrics.recordPing(30);

      const snap = metrics.getSnapshot();
      expect(snap.ping.min).toBe(10);
      expect(snap.ping.max).toBe(30);
      expect(snap.ping.avg).toBe(20);
      expect(snap.ping.count).toBe(3);
    });

    test("single ping has same min/max/avg", () => {
      metrics.recordPing(42);

      const snap = metrics.getSnapshot();
      expect(snap.ping.min).toBe(42);
      expect(snap.ping.max).toBe(42);
      expect(snap.ping.avg).toBe(42);
      expect(snap.ping.count).toBe(1);
    });
  });

  describe("HTTP request tracking", () => {
    test("records total HTTP requests", () => {
      metrics.recordHttpRequest(10, 200);
      metrics.recordHttpRequest(20, 200);
      metrics.recordHttpRequest(5, 404);

      const snap = metrics.getSnapshot();
      expect(snap.http.total).toBe(3);
    });

    test("tracks error responses in last minute", () => {
      metrics.recordHttpRequest(10, 200);
      metrics.recordHttpRequest(20, 500);
      metrics.recordHttpRequest(5, 404);

      const snap = metrics.getSnapshot();
      expect(snap.http.lastMinuteErrors).toBeGreaterThanOrEqual(2);
    });

    test("computes latency avg and p95", () => {
      for (let i = 1; i <= 100; i++) {
        metrics.recordHttpRequest(i, 200);
      }

      const snap = metrics.getSnapshot();
      expect(snap.http.latencyAvg).toBeCloseTo(50.5, 0);
      expect(snap.http.latencyP95).toBeGreaterThanOrEqual(90);
    });
  });

  describe("snapshot structure", () => {
    test("returns expected top-level keys", () => {
      const snap = metrics.getSnapshot();
      expect(snap).toHaveProperty("timestamp");
      expect(snap).toHaveProperty("clients");
      expect(snap).toHaveProperty("connections");
      expect(snap).toHaveProperty("commands");
      expect(snap).toHaveProperty("sessions");
      expect(snap).toHaveProperty("bandwidth");
      expect(snap).toHaveProperty("server");
      expect(snap).toHaveProperty("ping");
      expect(snap).toHaveProperty("http");
      expect(snap).toHaveProperty("eventLoop");
    });

    test("server uptime is positive", () => {
      const snap = metrics.getSnapshot();
      expect(snap.server.uptime).toBeGreaterThanOrEqual(0);
      expect(snap.server.startTime).toBeGreaterThan(0);
    });

    test("system memory values are reasonable", () => {
      const snap = metrics.getSnapshot();
      expect(snap.server.systemMemory.total).toBeGreaterThan(0);
      expect(snap.server.systemMemory.free).toBeGreaterThanOrEqual(0);
      expect(snap.server.systemMemory.usedPercent).toBeGreaterThanOrEqual(0);
      expect(snap.server.systemMemory.usedPercent).toBeLessThanOrEqual(100);
    });

    test("cpu cores is positive", () => {
      const snap = metrics.getSnapshot();
      expect(snap.server.cpu.cores).toBeGreaterThan(0);
    });
  });

  describe("history", () => {
    test("starts empty", () => {
      expect(metrics.getHistory()).toEqual([]);
    });

    test("recordHistoryEntry adds to history", () => {
      const snap = metrics.getSnapshot();
      metrics.recordHistoryEntry(snap);

      const history = metrics.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].timestamp).toBe(snap.timestamp);
    });

    test("history is capped at maxHistoryPoints", () => {
      for (let i = 0; i < 100; i++) {
        const snap = metrics.getSnapshot();
        metrics.recordHistoryEntry(snap);
      }

      const history = metrics.getHistory();
      expect(history.length).toBeLessThanOrEqual(60);
    });

    test("getHistory returns a copy", () => {
      const snap = metrics.getSnapshot();
      metrics.recordHistoryEntry(snap);

      const h1 = metrics.getHistory();
      const h2 = metrics.getHistory();
      expect(h1).not.toBe(h2);
      expect(h1).toEqual(h2);
    });
  });

  describe("reset", () => {
    test("clears resettable counters", () => {
      metrics.recordCommand("test");
      metrics.recordBytesSent(100);
      metrics.recordBytesReceived(200);
      metrics.recordPing(50);
      metrics.recordHttpRequest(10, 200);

      metrics.reset();

      const snap = metrics.getSnapshot();
      // Note: connection counters are cumulative and not cleared by reset()
      expect(snap.commands.total).toBe(0);
      expect(snap.bandwidth.sent).toBe(0);
      expect(snap.bandwidth.received).toBe(0);
      expect(snap.ping.count).toBe(0);
      expect(snap.http.total).toBe(0);
    });
  });
});
