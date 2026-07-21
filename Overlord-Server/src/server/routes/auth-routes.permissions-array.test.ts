import { afterEach, describe, expect, test } from "bun:test";
import { generateToken } from "../../auth";
import {
  createPermissionGroup,
  createUser,
  deletePermissionGroup,
  deleteUser,
  getUserById,
  setUserExtraPermissions,
  setUserGroups,
  setUserCanUploadFiles,
} from "../../users";
import { handleAuthRoutes } from "./auth-routes";

const PASSWORD = "Aa1!AuthMePermissionsTest";

const mockServer = {
  requestIP: () => ({ address: "127.0.0.1" }),
};

const createdUserIds: number[] = [];
const createdGroupIds: number[] = [];

async function tempUser(role: "admin" | "operator" | "viewer") {
  const username = `mep_${role.slice(0, 3)}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const created = await createUser(username, PASSWORD, role, "test");
  expect(created.success).toBe(true);
  const user = getUserById(created.userId!);
  expect(user).not.toBeNull();
  createdUserIds.push(user!.id);
  const token = await generateToken(user!);
  return { user: user!, token };
}

function tempGroup(name: string, permissions: string[]) {
  const result = createPermissionGroup(
    `${name}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
    null,
    permissions,
    null,
  );
  expect(result.success).toBe(true);
  createdGroupIds.push(result.group!.id);
  return result.group!;
}

async function fetchMe(token: string): Promise<any> {
  const url = new URL("https://localhost/api/auth/me");
  const res = await handleAuthRoutes(
    new Request(url, { method: "GET", headers: { Authorization: `Bearer ${token}` } }),
    url,
    mockServer,
  );
  expect(res).not.toBeNull();
  expect(res!.status).toBe(200);
  return res!.json();
}

afterEach(() => {
  while (createdGroupIds.length > 0) {
    const id = createdGroupIds.pop();
    if (typeof id === "number") deletePermissionGroup(id);
  }
  while (createdUserIds.length > 0) {
    const id = createdUserIds.pop();
    if (typeof id === "number") deleteUser(id);
  }
});

describe("/api/auth/me permissions array", () => {
  test("admin gets every declared permission", async () => {
    const admin = await tempUser("admin");
    const body = await fetchMe(admin.token);
    expect(Array.isArray(body.permissions)).toBe(true);
    const set = new Set(body.permissions);
    expect(set.has("users:manage")).toBe(true);
    expect(set.has("clients:control")).toBe(true);
    expect(set.has("system:configure")).toBe(true);
    expect(set.has("clients:disconnect")).toBe(true);
    expect(set.has("files:upload")).toBe(true);
  });

  test("operator gets the role-eligible subset and lacks admin-only perms", async () => {
    const op = await tempUser("operator");
    const body = await fetchMe(op.token);
    const set = new Set(body.permissions);
    expect(set.has("clients:control")).toBe(true);
    expect(body.canBuild).toBe(true);
    expect(set.has("clients:disconnect")).toBe(true);
    expect(set.has("clients:metadata")).toBe(true);
    expect(set.has("users:manage")).toBe(false);
    expect(set.has("system:configure")).toBe(false);
    expect(set.has("network:manage-bans")).toBe(false);
    expect(set.has("files:upload")).toBe(false);
  });

  test("viewer has no permissions by default", async () => {
    const viewer = await tempUser("viewer");
    const body = await fetchMe(viewer.token);
    expect(body.permissions).toEqual([]);
  });

  test("viewer with extras gains those permissions in /api/auth/me", async () => {
    const viewer = await tempUser("viewer");
    setUserExtraPermissions(viewer.user.id, ["clients:metadata"]);
    const body = await fetchMe(viewer.token);
    expect(new Set(body.permissions).has("clients:metadata")).toBe(true);
  });

  test("legacy system:configure extra grants the split settings permissions", async () => {
    const viewer = await tempUser("viewer");
    setUserExtraPermissions(viewer.user.id, ["system:configure"]);
    const body = await fetchMe(viewer.token);
    const set = new Set(body.permissions);
    expect(set.has("system:configure")).toBe(true);
    expect(set.has("system:security")).toBe(true);
    expect(set.has("system:tls")).toBe(true);
    expect(set.has("system:registration")).toBe(true);
    expect(set.has("system:health")).toBe(true);
    expect(set.has("system:profiler")).toBe(true);
  });

  test("viewer in a group gains the group's permissions in /api/auth/me", async () => {
    const viewer = await tempUser("viewer");
    const group = tempGroup("me_group", ["clients:disconnect", "audit:view"]);
    setUserGroups(viewer.user.id, [group.id]);
    const body = await fetchMe(viewer.token);
    const set = new Set(body.permissions);
    expect(set.has("clients:disconnect")).toBe(true);
    expect(set.has("audit:view")).toBe(true);
  });

  test("operator with can_build=0 loses clients:build (legacy userOverride still revokes via /api/auth/me)", async () => {
    const op = await tempUser("operator");
    const { setUserCanBuild } = await import("../../users");
    setUserCanBuild(op.user.id, false);
    const body = await fetchMe(op.token);
    expect(new Set(body.permissions).has("clients:build")).toBe(false);
    expect(body.canBuild).toBe(false);
  });

  test("operator with upload enabled gets files:upload and canUploadFiles via /api/auth/me", async () => {
    const op = await tempUser("operator");
    setUserCanUploadFiles(op.user.id, true);
    const body = await fetchMe(op.token);
    expect(new Set(body.permissions).has("files:upload")).toBe(true);
    expect(body.canUploadFiles).toBe(true);
  });

  test("viewer in a build group gets canBuild from effective permissions", async () => {
    const viewer = await tempUser("viewer");
    const group = tempGroup("me_build", ["clients:build"]);
    setUserGroups(viewer.user.id, [group.id]);
    const body = await fetchMe(viewer.token);
    expect(new Set(body.permissions).has("clients:build")).toBe(true);
    expect(body.canBuild).toBe(true);
  });
});
