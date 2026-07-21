import { afterEach, describe, expect, test } from "bun:test";
import {
  createPermissionGroup,
  createUser,
  deletePermissionGroup,
  deleteUser,
  getPermissionGroup,
  getUserByUsername,
  getUserGrantedPermissions,
  getUserGroupIds,
  listPermissionGroups,
  setUserCanUploadFiles,
  setUserExtraPermissions,
  setUserGroups,
  updatePermissionGroup,
} from "./users";
import { hasPermission, getUserEffectivePermissionDetails, getUserPermissions } from "./rbac";

const createdUserIds: number[] = [];
const createdGroupIds: number[] = [];

async function tempUser(role: "viewer" | "operator" | "admin") {
  const username = `pg_${role.slice(0, 3)}_${Date.now().toString(36)}${Math.floor(Math.random() * 1000).toString(36)}`;
  const result = await createUser(username, "Aa1!VeryLongTestPassword_2026", role, "test");
  expect(result.success).toBe(true);
  const user = getUserByUsername(username);
  expect(user).not.toBeNull();
  createdUserIds.push(user!.id);
  return user!;
}

function tempGroup(name: string, permissions: string[]) {
  const result = createPermissionGroup(name + "_" + Date.now() + "_" + Math.floor(Math.random() * 1000), null, permissions, null);
  expect(result.success).toBe(true);
  createdGroupIds.push(result.group!.id);
  return result.group!;
}

afterEach(() => {
  while (createdUserIds.length > 0) {
    const id = createdUserIds.pop();
    if (typeof id === "number") deleteUser(id);
  }
  while (createdGroupIds.length > 0) {
    const id = createdGroupIds.pop();
    if (typeof id === "number") deletePermissionGroup(id);
  }
});

describe("permission groups CRUD", () => {
  test("createPermissionGroup persists the group with permissions", () => {
    const group = tempGroup("crud_one", ["clients:metadata", "clients:disconnect"]);
    expect(group.name).toContain("crud_one");
    expect(group.permissions.sort()).toEqual(["clients:disconnect", "clients:metadata"]);
    const loaded = getPermissionGroup(group.id);
    expect(loaded?.permissions.sort()).toEqual(["clients:disconnect", "clients:metadata"]);
  });

  test("createPermissionGroup rejects duplicate names", () => {
    const group = tempGroup("dup", []);
    const dup = createPermissionGroup(group.name, null, [], null);
    expect(dup.success).toBe(false);
    expect(dup.error).toMatch(/already exists/i);
  });

  test("updatePermissionGroup replaces the permission set", () => {
    const group = tempGroup("upd", ["clients:metadata"]);
    const result = updatePermissionGroup(group.id, { permissions: ["clients:uninstall"] });
    expect(result.success).toBe(true);
    expect(result.group!.permissions).toEqual(["clients:uninstall"]);
  });

  test("listPermissionGroups returns all created groups", () => {
    const a = tempGroup("list_a", ["chat:write"]);
    const b = tempGroup("list_b", ["clients:metadata"]);
    const ids = new Set(listPermissionGroups().map((g) => g.id));
    expect(ids.has(a.id)).toBe(true);
    expect(ids.has(b.id)).toBe(true);
  });
});

describe("user permission groups + extras", () => {
  test("setUserGroups + getUserGrantedPermissions unions group perms", async () => {
    const viewer = await tempUser("viewer");
    const g1 = tempGroup("gp_a", ["clients:metadata"]);
    const g2 = tempGroup("gp_b", ["clients:disconnect"]);
    setUserGroups(viewer.id, [g1.id, g2.id]);

    const granted = getUserGrantedPermissions(viewer.id);
    expect(granted.has("clients:metadata")).toBe(true);
    expect(granted.has("clients:disconnect")).toBe(true);
    expect(granted.has("clients:uninstall")).toBe(false);
  });

  test("setUserExtraPermissions adds a permission outside any group", async () => {
    const viewer = await tempUser("viewer");
    setUserExtraPermissions(viewer.id, ["clients:uninstall"]);
    expect(getUserGrantedPermissions(viewer.id).has("clients:uninstall")).toBe(true);
  });

  test("hasPermission union: viewer with a group gains the perm", async () => {
    const viewer = await tempUser("viewer");
    const g = tempGroup("hp_a", ["clients:metadata"]);
    expect(hasPermission(viewer.role, "clients:metadata", viewer.id)).toBe(false);
    setUserGroups(viewer.id, [g.id]);
    expect(hasPermission(viewer.role, "clients:metadata", viewer.id)).toBe(true);
  });

  test("groups are additive only — they cannot revoke an admin perm", async () => {
    const admin = await tempUser("admin");
    setUserGroups(admin.id, []);
    expect(hasPermission(admin.role, "clients:metadata", admin.id)).toBe(true);
  });

  test("userOverride still revokes — an operator with can_build=0 keeps no clients:build via empty group", async () => {
    const op = await tempUser("operator");
    // Operator has clients:build by default. Removing all groups + extras does
    // NOT take it away because role grants it.
    setUserGroups(op.id, []);
    setUserExtraPermissions(op.id, []);
    expect(hasPermission(op.role, "clients:build", op.id)).toBe(true);
    // Only the legacy can_build override (userOverride returning false) revokes.
    const { setUserCanBuild } = await import("./users");
    setUserCanBuild(op.id, false);
    expect(hasPermission(op.role, "clients:build", op.id)).toBe(false);
    // Now add an extra → it gets granted back.
    setUserExtraPermissions(op.id, ["clients:build"]);
    expect(hasPermission(op.role, "clients:build", op.id)).toBe(true);
  });

  test("getUserPermissions includes role + group + extra permissions for a viewer", async () => {
    const viewer = await tempUser("viewer");
    const g = tempGroup("up_a", ["clients:metadata"]);
    setUserGroups(viewer.id, [g.id]);
    setUserExtraPermissions(viewer.id, ["clients:uninstall"]);
    const perms = new Set(getUserPermissions(viewer.id, viewer.role));
    expect(perms.has("clients:metadata")).toBe(true);
    expect(perms.has("clients:uninstall")).toBe(true);
    // Viewer has no role-level perms
    expect(perms.has("clients:control")).toBe(false);
    expect(perms.has("users:manage")).toBe(false);
  });

  test("effective permission details include role, group, and extra grant sources", async () => {
    const viewer = await tempUser("viewer");
    const g = tempGroup("eff_a", ["clients:metadata"]);
    setUserGroups(viewer.id, [g.id]);
    setUserExtraPermissions(viewer.id, ["clients:uninstall"]);

    const details = getUserEffectivePermissionDetails(viewer.id, viewer.role);
    const metadata = details.find((p) => p.id === "clients:metadata");
    const uninstall = details.find((p) => p.id === "clients:uninstall");
    const control = details.find((p) => p.id === "clients:control");

    expect(metadata?.allowed).toBe(true);
    expect(metadata?.sources).toContainEqual({
      type: "group",
      label: g.name,
      groupId: g.id,
    });
    expect(uninstall?.allowed).toBe(true);
    expect(uninstall?.sources).toContainEqual({
      type: "extra",
      label: "Direct extra permission",
    });
    expect(control?.allowed).toBe(false);
    expect(control?.sources).toEqual([]);
  });

  test("effective permission details reflect build and upload toggles", async () => {
    const op = await tempUser("operator");
    setUserCanUploadFiles(op.id, true);

    const details = getUserEffectivePermissionDetails(op.id, op.role);
    const build = details.find((p) => p.id === "clients:build");
    const upload = details.find((p) => p.id === "files:upload");

    expect(build?.allowed).toBe(true);
    expect(build?.sources).toContainEqual({
      type: "role",
      label: "Build permission toggle",
      role: "operator",
    });
    expect(upload?.allowed).toBe(true);
    expect(upload?.sources).toContainEqual({
      type: "role",
      label: "File upload permission toggle",
      role: "operator",
    });
  });

  test("getUserGroupIds returns assigned ids", async () => {
    const viewer = await tempUser("viewer");
    const g = tempGroup("gid_a", []);
    setUserGroups(viewer.id, [g.id]);
    expect(getUserGroupIds(viewer.id)).toContain(g.id);
  });

  test("deleting a group removes it from users", async () => {
    const viewer = await tempUser("viewer");
    const g = tempGroup("del_a", ["clients:metadata"]);
    setUserGroups(viewer.id, [g.id]);
    expect(getUserGroupIds(viewer.id)).toContain(g.id);
    deletePermissionGroup(g.id);
    expect(getUserGroupIds(viewer.id)).not.toContain(g.id);
    // Stop the afterEach from double-deleting
    createdGroupIds.splice(createdGroupIds.indexOf(g.id), 1);
  });

  test("deleting a user clears their group assignments + extras from cache", async () => {
    const viewer = await tempUser("viewer");
    const g = tempGroup("dl_user", ["clients:metadata"]);
    setUserGroups(viewer.id, [g.id]);
    setUserExtraPermissions(viewer.id, ["clients:disconnect"]);
    expect(getUserGrantedPermissions(viewer.id).size).toBeGreaterThan(0);
    deleteUser(viewer.id);
    createdUserIds.splice(createdUserIds.indexOf(viewer.id), 1);
    expect(getUserGrantedPermissions(viewer.id).size).toBe(0);
  });
});
