import { afterAll, describe, expect, test } from "bun:test";
import { db } from "./db/connection";
import { deleteClientRow, getClientMetricsSummary, getEnrollmentStats, listClients, setClientBookmark, setClientTag, setClientWebcamInfo, upsertClientRow } from "./db";

const createdClientIds: string[] = [];

function createTempClient(
  id: string,
  options: {
    online: boolean;
    lastSeen: number;
    host: string;
    pingMs?: number;
    bookmarked?: boolean;
    os?: string;
    isAdmin?: boolean;
    elevation?: string;
  },
) {
  upsertClientRow({
    id,
    hwid: id,
    role: "client",
    host: options.host,
    os: options.os || "windows",
    arch: "amd64",
    version: "1.0.0",
    user: "tester",
    country: "US",
    lastSeen: options.lastSeen,
    online: options.online ? 1 : 0,
    pingMs: options.pingMs,
    isAdmin: options.isAdmin,
    elevation: options.elevation,
  });
  if (options.bookmarked) {
    setClientBookmark(id, true);
  }
  createdClientIds.push(id);
}

function cleanupCreatedClients() {
  while (createdClientIds.length > 0) {
    const id = createdClientIds.pop();
    if (id) {
      deleteClientRow(id);
    }
  }
}

afterAll(() => {
  cleanupCreatedClients();
});

describe("client list ordering", () => {
  test("default sort keeps online clients above offline clients on the first page", () => {
    try {
      const prefix = `order-default-${Date.now().toString(36)}`;
      const now = Date.now();

      for (let index = 0; index < 12; index += 1) {
        createTempClient(`${prefix}-offline-${index}`, {
          online: false,
          lastSeen: now - index,
          host: `offline-${index}`,
        });
      }

      createTempClient(`${prefix}-online`, {
        online: true,
        lastSeen: now - 60_000,
        host: "online-host",
      });

      const result = listClients({
        page: 1,
        pageSize: 12,
        search: prefix,
        sort: "last_seen_desc",
        statusFilter: "all",
        osFilter: "all",
        countryFilter: "all",
        enrollmentFilter: "all",
      });

      expect(result.items.length).toBe(12);
      expect(result.items[0]?.id).toBe(`${prefix}-online`);
      expect(result.items[0]?.online).toBe(true);
    } finally {
      cleanupCreatedClients();
    }
  });

  test("secondary sort modes still keep online clients above offline clients", () => {
    try {
      const prefix = `order-host-${Date.now().toString(36)}`;
      const now = Date.now();

      createTempClient(`${prefix}-offline-bookmarked`, {
        online: false,
        lastSeen: now,
        host: "aaa-offline",
        bookmarked: true,
      });
      createTempClient(`${prefix}-online`, {
        online: true,
        lastSeen: now - 1_000,
        host: "zzz-online",
      });

      const result = listClients({
        page: 1,
        pageSize: 12,
        search: prefix,
        sort: "host_asc",
        statusFilter: "all",
        osFilter: "all",
        countryFilter: "all",
        enrollmentFilter: "all",
      });

      expect(result.items[0]?.id).toBe(`${prefix}-online`);
      expect(result.items[0]?.online).toBe(true);
    } finally {
      cleanupCreatedClients();
    }
  });

  test("search tolerates typos across client metadata", () => {
    try {
      const prefix = `fuse-${Date.now().toString(36)}`;
      const id = `${prefix}-finance-terminal`;

      createTempClient(id, {
        online: true,
        lastSeen: Date.now(),
        host: "finance-terminal",
      });
      setClientTag(id, "Payroll Workstation", "Quarterly reporting machine");

      const result = listClients({
        page: 1,
        pageSize: 12,
        search: "payrol workstaton",
        sort: "last_seen_desc",
        statusFilter: "all",
        osFilter: "all",
        countryFilter: "all",
        enrollmentFilter: "all",
      });

      expect(result.items.some((item) => item.id === id)).toBe(true);
    } finally {
      cleanupCreatedClients();
    }
  });
});

describe("client metrics summary", () => {
  test("suspicious enrollment filter and stats scan the full matching set", () => {
    try {
      const prefix = `suspicious-filter-${Date.now().toString(36)}`;
      const suspiciousId = `${prefix}-missing-identity`;
      const normalId = `${prefix}-normal`;
      const uniqueOs = `${prefix}-os`;
      const beforeStats = getEnrollmentStats();

      upsertClientRow({
        id: suspiciousId,
        hwid: suspiciousId,
        role: "client",
        host: "",
        os: uniqueOs,
        arch: "amd64",
        version: "1.0.0",
        user: "",
        country: "US",
        lastSeen: Date.now(),
        online: 0,
        enrollmentStatus: "pending",
      });
      createdClientIds.push(suspiciousId);

      upsertClientRow({
        id: normalId,
        hwid: normalId,
        role: "client",
        host: "normal-host",
        os: uniqueOs,
        arch: "amd64",
        version: "1.0.0",
        user: "tester",
        country: "US",
        lastSeen: Date.now() - 1,
        online: 0,
        enrollmentStatus: "pending",
      });
      createdClientIds.push(normalId);

      const result = listClients({
        page: 1,
        pageSize: 12,
        search: "",
        sort: "last_seen_desc",
        statusFilter: "all",
        osFilter: uniqueOs,
        countryFilter: "all",
        enrollmentFilter: "suspicious",
      });
      const afterStats = getEnrollmentStats();

      expect(result.total).toBe(1);
      expect(result.items.map((item) => item.id)).toEqual([suspiciousId]);
      expect(result.items[0]?.suspiciousFlags).toContain("no_hostname");
      expect(result.items[0]?.suspiciousFlags).toContain("no_user");
      expect(afterStats.suspicious).toBe(beforeStats.suspicious + 1);
    } finally {
      cleanupCreatedClients();
    }
  });

  test("operating system breakdown excludes purgatory clients", () => {
    try {
      const prefix = `metrics-purgatory-${Date.now().toString(36)}`;
      const approvedOs = `${prefix}-approved-os`;
      const pendingOs = `${prefix}-pending-os`;
      const before = getClientMetricsSummary();

      upsertClientRow({
        id: `${prefix}-approved`,
        hwid: `${prefix}-approved`,
        role: "client",
        host: "approved-host",
        os: approvedOs,
        arch: "amd64",
        version: "1.0.0",
        user: "tester",
        country: "US",
        lastSeen: Date.now(),
        online: 1,
        enrollmentStatus: "approved",
      });
      createdClientIds.push(`${prefix}-approved`);

      upsertClientRow({
        id: `${prefix}-pending`,
        hwid: `${prefix}-pending`,
        role: "client",
        host: "pending-host",
        os: pendingOs,
        arch: "amd64",
        version: "1.0.0",
        user: "tester",
        country: "US",
        lastSeen: Date.now(),
        online: 0,
        enrollmentStatus: "pending",
      });
      createdClientIds.push(`${prefix}-pending`);

      const after = getClientMetricsSummary();

      expect(after.byOS[approvedOs]).toBe((before.byOS[approvedOs] || 0) + 1);
      expect(after.byOS[pendingOs] || 0).toBe(before.byOS[pendingOs] || 0);
    } finally {
      cleanupCreatedClients();
    }
  });

  test("webcam filter returns only clients with available webcam devices", () => {
    try {
      const prefix = `webcam-filter-${Date.now().toString(36)}`;
      const now = Date.now();
      const withWebcam = `${prefix}-with`;
      const withoutWebcam = `${prefix}-without`;
      const legacyWebcam = `${prefix}-legacy`;

      createTempClient(withWebcam, {
        online: true,
        lastSeen: now,
        host: "webcam-host",
      });
      createTempClient(withoutWebcam, {
        online: true,
        lastSeen: now - 1,
        host: "plain-host",
      });
      createTempClient(legacyWebcam, {
        online: true,
        lastSeen: now - 2,
        host: "legacy-webcam-host",
      });
      setClientWebcamInfo(withWebcam, true, [{ index: 0, name: "Integrated Camera" }]);
      db.run(
        `UPDATE clients SET webcam_available=0, webcam_devices=? WHERE id=?`,
        JSON.stringify([{ index: 1, name: "USB Camera" }]),
        legacyWebcam,
      );

      const result = listClients({
        page: 1,
        pageSize: 12,
        search: prefix,
        sort: "last_seen_desc",
        statusFilter: "all",
        osFilter: "all",
        countryFilter: "all",
        enrollmentFilter: "all",
        webcamFilter: "available",
      });

      expect(result.items.map((item) => item.id).sort()).toEqual([legacyWebcam, withWebcam].sort());
      expect(result.items.every((item) => item.webcamAvailable)).toBe(true);
    } finally {
      cleanupCreatedClients();
    }
  });

  test("general Windows OS filter includes Windows version variants", () => {
    try {
      const prefix = `windows-filter-${Date.now().toString(36)}`;
      const now = Date.now();
      const win24h2 = `${prefix}-24h2`;
      const win25h2 = `${prefix}-25h2`;
      const mac = `${prefix}-mac`;

      createTempClient(win24h2, {
        online: true,
        lastSeen: now,
        host: "win-24h2",
        os: "Windows 11 Pro 24H2",
      });
      createTempClient(win25h2, {
        online: true,
        lastSeen: now - 1,
        host: "win-25h2",
        os: "Windows 11 Pro 25H2",
      });
      createTempClient(mac, {
        online: true,
        lastSeen: now - 2,
        host: "mac-host",
        os: "macOS 15.5",
      });

      const result = listClients({
        page: 1,
        pageSize: 12,
        search: prefix,
        sort: "last_seen_desc",
        statusFilter: "all",
        osFilter: "windows",
        countryFilter: "all",
        enrollmentFilter: "all",
      });

      expect(result.items.map((item) => item.id).sort()).toEqual([win24h2, win25h2].sort());
    } finally {
      cleanupCreatedClients();
    }
  });

  test("elevated sort puts elevated clients before regular clients", () => {
    try {
      const prefix = `elevated-sort-${Date.now().toString(36)}`;
      const now = Date.now();
      const regular = `${prefix}-regular`;
      const system = `${prefix}-system`;
      const trustedInstaller = `${prefix}-ti`;

      createTempClient(regular, {
        online: true,
        lastSeen: now,
        host: "regular-host",
      });
      createTempClient(system, {
        online: true,
        lastSeen: now - 1,
        host: "system-host",
        isAdmin: true,
        elevation: "system",
      });
      createTempClient(trustedInstaller, {
        online: true,
        lastSeen: now - 2,
        host: "ti-host",
        isAdmin: true,
        elevation: "trustedinstaller",
      });

      const result = listClients({
        page: 1,
        pageSize: 12,
        search: prefix,
        sort: "elevated_first",
        statusFilter: "all",
        osFilter: "all",
        countryFilter: "all",
        enrollmentFilter: "all",
      });

      expect(result.items.map((item) => item.id)).toEqual([trustedInstaller, system, regular]);
    } finally {
      cleanupCreatedClients();
    }
  });
});

describe("client search index", () => {
  function getSearchIndexRow(id: string) {
    return db
      .query<{ id: string; host: string | null; customTag: string | null; customTagNote: string | null }>(
        `SELECT id, host, custom_tag as customTag, custom_tag_note as customTagNote
         FROM client_search_fts
         WHERE id = ?`,
      )
      .get(id);
  }

  test("keeps the FTS search index in sync when client metadata changes", () => {
    try {
      const id = `fts-sync-${Date.now().toString(36)}`;

      createTempClient(id, {
        online: true,
        lastSeen: Date.now(),
        host: "dispatch-terminal-old",
      });

      expect(getSearchIndexRow(id)?.host).toBe("dispatch-terminal-old");

      createTempClient(id, {
        online: true,
        lastSeen: Date.now(),
        host: "dispatch-terminal-new",
      });
      setClientTag(id, "Priority Ops", "Shift handoff workstation");

      const updatedRow = getSearchIndexRow(id);
      expect(updatedRow?.host).toBe("dispatch-terminal-new");
      expect(updatedRow?.customTag).toBe("Priority Ops");
      expect(updatedRow?.customTagNote).toBe("Shift handoff workstation");

      deleteClientRow(id);
      expect(getSearchIndexRow(id)).toBeNull();
    } finally {
      cleanupCreatedClients();
    }
  });

  test("uses indexed candidates before fuzzy matching so exact token searches stay fast", () => {
    try {
      const prefix = `fts-candidate-${Date.now().toString(36)}`;
      const id = `${prefix}-ops-node`;

      createTempClient(id, {
        online: true,
        lastSeen: Date.now(),
        host: "northbridge-ops-node",
      });
      setClientTag(id, "Incident Desk", "CPU spike triage host");

      const result = listClients({
        page: 1,
        pageSize: 12,
        search: "northbridge",
        sort: "last_seen_desc",
        statusFilter: "all",
        osFilter: "all",
        countryFilter: "all",
        enrollmentFilter: "all",
      });

      expect(result.items.some((item) => item.id === id)).toBe(true);
    } finally {
      cleanupCreatedClients();
    }
  });
});
