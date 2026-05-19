import { afterEach, describe, expect, test } from "bun:test";
import { generateToken } from "../../auth";
import * as clientManager from "../../clientManager";
import {
  createUser,
  deleteUser,
  getUserById,
  setUserClientAccessScope,
  setUserFeaturePermission,
} from "../../users";
import { upsertClientRow, deleteClientRow } from "../../db";
import { handleClientRoutes } from "./client-routes";

const PASSWORD = "Aa1!RouteGateTestPass123";

const mockServer = {
  requestIP: () => ({ address: "127.0.0.1" }),
};

const deps = {
  CORS_HEADERS: {} as Record<string, string>,
  pendingScripts: new Map<string, any>(),
  pendingCommandReplies: new Map<string, any>(),
  broadcastNotificationsCleared: () => {},
};

const createdUserIds: number[] = [];
const createdClientIds: string[] = [];

async function makeUserWithToken(role: "admin" | "operator" | "viewer", scopeAll = true) {
  const username = `gate_${role.slice(0, 3)}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const result = await createUser(username, PASSWORD, role, "test");
  expect(result.success).toBe(true);
  const user = getUserById(result.userId!);
  expect(user).not.toBeNull();
  createdUserIds.push(user!.id);

  if (scopeAll && role !== "admin") {
    setUserClientAccessScope(user!.id, "all");
  }

  const token = await generateToken(user!);
  return { user: user!, token };
}

function registerTestClient(): string {
  const clientId = `gate-client-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  // Insert a row so clientExists() / DB-backed checks pass; also keep an
  // in-memory entry with a no-op ws.send() so the route's target.ws.send() is
  // exercised without actually trying to write to a socket.
  upsertClientRow({
    id: clientId,
    os: "windows",
    arch: "x64",
    online: 1,
    lastSeen: Date.now(),
  });
  clientManager.addClient(clientId, {
    id: clientId,
    lastSeen: Date.now(),
    role: "client",
    ws: { send: () => {} },
  } as any);
  createdClientIds.push(clientId);
  return clientId;
}

async function command(token: string, clientId: string, action: string, extra: Record<string, unknown> = {}) {
  const url = new URL(`https://localhost/api/clients/${encodeURIComponent(clientId)}/command`);
  return handleClientRoutes(
    new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, ...extra }),
    }),
    url,
    mockServer,
    deps,
  );
}

async function patchNickname(token: string, clientId: string, nickname: string) {
  const url = new URL(`https://localhost/api/clients/${encodeURIComponent(clientId)}/nickname`);
  return handleClientRoutes(
    new Request(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ nickname }),
    }),
    url,
    mockServer,
    deps,
  );
}

afterEach(() => {
  while (createdClientIds.length > 0) {
    const id = createdClientIds.pop();
    if (typeof id === "string") {
      clientManager.deleteClient(id);
      try { deleteClientRow(id); } catch {}
    }
  }
  while (createdUserIds.length > 0) {
    const id = createdUserIds.pop();
    if (typeof id === "number") deleteUser(id);
  }
});

describe("clients:disconnect gates", () => {
  test("admin can disconnect", async () => {
    const auth = await makeUserWithToken("admin");
    const clientId = registerTestClient();
    const res = await command(auth.token, clientId, "disconnect");
    expect(res!.status).toBe(200);
  });

  test("operator (default) can disconnect", async () => {
    const auth = await makeUserWithToken("operator");
    const clientId = registerTestClient();
    const res = await command(auth.token, clientId, "disconnect");
    expect(res!.status).toBe(200);
  });

  test("operator with disconnect feature OFF gets 403", async () => {
    const auth = await makeUserWithToken("operator");
    const clientId = registerTestClient();
    setUserFeaturePermission(auth.user.id, "disconnect", false);
    const res = await command(auth.token, clientId, "disconnect");
    expect(res!.status).toBe(403);
  });

  test("viewer cannot reach the dispatch (blocked by outer clients:control gate)", async () => {
    const auth = await makeUserWithToken("viewer");
    const clientId = registerTestClient();
    const res = await command(auth.token, clientId, "disconnect");
    expect(res!.status).toBe(403);
  });
});

describe("clients:reconnect gates", () => {
  test("operator (default) can reconnect", async () => {
    const auth = await makeUserWithToken("operator");
    const clientId = registerTestClient();
    const res = await command(auth.token, clientId, "reconnect");
    expect(res!.status).toBe(200);
  });

  test("operator with reconnect feature OFF gets 403", async () => {
    const auth = await makeUserWithToken("operator");
    const clientId = registerTestClient();
    setUserFeaturePermission(auth.user.id, "reconnect", false);
    const res = await command(auth.token, clientId, "reconnect");
    expect(res!.status).toBe(403);
  });

  test("revoking disconnect does not revoke reconnect (feature toggles are independent)", async () => {
    const auth = await makeUserWithToken("operator");
    const clientId = registerTestClient();
    setUserFeaturePermission(auth.user.id, "disconnect", false);
    const res = await command(auth.token, clientId, "reconnect");
    expect(res!.status).toBe(200);
  });
});

describe("clients:uninstall gates", () => {
  test("admin can uninstall", async () => {
    const auth = await makeUserWithToken("admin");
    const clientId = registerTestClient();
    const res = await command(auth.token, clientId, "uninstall");
    expect(res!.status).toBe(200);
  });

  test("operator with uninstall feature OFF gets 403", async () => {
    const auth = await makeUserWithToken("operator");
    const clientId = registerTestClient();
    setUserFeaturePermission(auth.user.id, "uninstall", false);
    const res = await command(auth.token, clientId, "uninstall");
    expect(res!.status).toBe(403);
  });
});

describe("clients:metadata gates", () => {
  test("operator (default) can set nickname", async () => {
    const auth = await makeUserWithToken("operator");
    const clientId = registerTestClient();
    const res = await patchNickname(auth.token, clientId, "test-nick");
    expect(res!.status).toBe(200);
  });

  test("operator with client_metadata feature OFF gets 403", async () => {
    const auth = await makeUserWithToken("operator");
    const clientId = registerTestClient();
    setUserFeaturePermission(auth.user.id, "client_metadata", false);
    const res = await patchNickname(auth.token, clientId, "test-nick");
    expect(res!.status).toBe(403);
  });

  test("viewer cannot set nickname", async () => {
    const auth = await makeUserWithToken("viewer");
    const clientId = registerTestClient();
    const res = await patchNickname(auth.token, clientId, "test-nick");
    expect(res!.status).toBe(403);
  });

  test("revoking disconnect does not block metadata edits", async () => {
    const auth = await makeUserWithToken("operator");
    const clientId = registerTestClient();
    setUserFeaturePermission(auth.user.id, "disconnect", false);
    const res = await patchNickname(auth.token, clientId, "test-nick");
    expect(res!.status).toBe(200);
  });
});

describe("layered semantics: groups + feature toggles", () => {
  test("admin always bypasses both gates regardless of feature toggles", async () => {
    const auth = await makeUserWithToken("admin");
    const clientId = registerTestClient();
    // Admin's feature toggle is irrelevant (canUserAccessFeature returns true for admin).
    setUserFeaturePermission(auth.user.id, "disconnect", false);
    const res = await command(auth.token, clientId, "disconnect");
    expect(res!.status).toBe(200);
  });

  test("viewer is denied even though feature toggle defaults look on (canUserAccessFeature returns false for viewer)", async () => {
    const auth = await makeUserWithToken("viewer");
    const clientId = registerTestClient();
    // Even if we tried to flip the toggle on, the feature gate denies viewers.
    setUserFeaturePermission(auth.user.id, "disconnect", true);
    const res = await command(auth.token, clientId, "disconnect");
    expect(res!.status).toBe(403);
  });
});
