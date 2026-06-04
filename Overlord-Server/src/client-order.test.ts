import { afterAll, describe, expect, test } from "bun:test";
import { deleteClientRow, listClients, setClientBookmark, setClientTag, upsertClientRow } from "./db";

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
