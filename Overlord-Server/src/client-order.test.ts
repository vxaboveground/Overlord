import { afterAll, describe, expect, test } from "bun:test";
import { db } from "./db/connection";
import { deleteClientRow, getClientMetricsSummary, listClients, setClientBookmark, setClientTag, upsertClientRow } from "./db";

const createdClientIds: string[] = [];

function createTempClient(id: string, options: { online: boolean; lastSeen: number; host: string; pingMs?: number; bookmarked?: boolean }) {
  upsertClientRow({
    id,
    hwid: id,
    role: "client",
    host: options.host,
    os: "windows",
    arch: "amd64",
    version: "1.0.0",
    user: "tester",
    country: "US",
    lastSeen: options.lastSeen,
    online: options.online ? 1 : 0,
    pingMs: options.pingMs,
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
