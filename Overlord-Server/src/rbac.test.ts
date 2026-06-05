import { describe, expect, test } from "bun:test";
import {
  checkPermission,
  checkAnyPermission,
  checkAllPermissions,
  requireAuth,
  requirePermission,
  requireAnyPermission,
  getPermissionDescription,
  getRoleDescription,
  getRolePermissions,
  listAllPermissions,
  type Permission,
} from "./rbac";
import type { AuthenticatedUser } from "./auth";

function makeUser(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    userId: 1,
    username: "testuser",
    role: "admin",
    ...overrides,
  };
}

describe("checkPermission", () => {
  test("returns false for null user", () => {
    expect(checkPermission(null, "users:manage")).toBe(false);
  });

  test("admin has users:manage", () => {
    expect(checkPermission(makeUser({ role: "admin" }), "users:manage")).toBe(true);
  });

  test("operator does not have users:manage", () => {
    expect(checkPermission(makeUser({ role: "operator" }), "users:manage")).toBe(false);
  });

  test("viewer does not have users:manage", () => {
    expect(checkPermission(makeUser({ role: "viewer" }), "users:manage")).toBe(false);
  });

  test("admin has clients:control", () => {
    expect(checkPermission(makeUser({ role: "admin" }), "clients:control")).toBe(true);
  });

  test("operator has clients:control", () => {
    expect(checkPermission(makeUser({ role: "operator" }), "clients:control")).toBe(true);
  });

  test("operator has clients:enroll", () => {
    expect(checkPermission(makeUser({ role: "operator" }), "clients:enroll")).toBe(true);
  });

  test("viewer does not have clients:enroll", () => {
    expect(checkPermission(makeUser({ role: "viewer" }), "clients:enroll")).toBe(false);
  });

  test("viewer does not have clients:control", () => {
    expect(checkPermission(makeUser({ role: "viewer" }), "clients:control")).toBe(false);
  });

  test("admin has audit:view", () => {
    expect(checkPermission(makeUser({ role: "admin" }), "audit:view")).toBe(true);
  });

  test("operator has audit:view", () => {
    expect(checkPermission(makeUser({ role: "operator" }), "audit:view")).toBe(true);
  });

  test("admin has scripts:manage, operator does not", () => {
    expect(checkPermission(makeUser({ role: "admin" }), "scripts:manage")).toBe(true);
    expect(checkPermission(makeUser({ role: "operator" }), "scripts:manage")).toBe(false);
    expect(checkPermission(makeUser({ role: "viewer" }), "scripts:manage")).toBe(false);
  });

  test("admin has deploys:manage, operator does not", () => {
    expect(checkPermission(makeUser({ role: "admin" }), "deploys:manage")).toBe(true);
    expect(checkPermission(makeUser({ role: "operator" }), "deploys:manage")).toBe(false);
  });

  test("admin and operator have plugins:manage", () => {
    expect(checkPermission(makeUser({ role: "admin" }), "plugins:manage")).toBe(true);
    expect(checkPermission(makeUser({ role: "operator" }), "plugins:manage")).toBe(true);
    expect(checkPermission(makeUser({ role: "viewer" }), "plugins:manage")).toBe(false);
  });

  test("only admin has plugins:configure", () => {
    expect(checkPermission(makeUser({ role: "admin" }), "plugins:configure")).toBe(true);
    expect(checkPermission(makeUser({ role: "operator" }), "plugins:configure")).toBe(false);
    expect(checkPermission(makeUser({ role: "viewer" }), "plugins:configure")).toBe(false);
  });

  test("only admin has network:manage-bans", () => {
    expect(checkPermission(makeUser({ role: "admin" }), "network:manage-bans")).toBe(true);
    expect(checkPermission(makeUser({ role: "operator" }), "network:manage-bans")).toBe(false);
  });

  test("only admin has clients:silent-exec", () => {
    expect(checkPermission(makeUser({ role: "admin" }), "clients:silent-exec")).toBe(true);
    expect(checkPermission(makeUser({ role: "operator" }), "clients:silent-exec")).toBe(false);
    expect(checkPermission(makeUser({ role: "viewer" }), "clients:silent-exec")).toBe(false);
  });

  test("only admin has system:configure", () => {
    expect(checkPermission(makeUser({ role: "admin" }), "system:configure")).toBe(true);
    expect(checkPermission(makeUser({ role: "operator" }), "system:configure")).toBe(false);
    expect(checkPermission(makeUser({ role: "viewer" }), "system:configure")).toBe(false);
  });

  test("only admin has clients:winre", () => {
    expect(checkPermission(makeUser({ role: "admin" }), "clients:winre")).toBe(true);
    expect(checkPermission(makeUser({ role: "operator" }), "clients:winre")).toBe(false);
    expect(checkPermission(makeUser({ role: "viewer" }), "clients:winre")).toBe(false);
  });

  test("admin and operator have clients:reconnect", () => {
    expect(checkPermission(makeUser({ role: "admin" }), "clients:reconnect")).toBe(true);
    expect(checkPermission(makeUser({ role: "operator" }), "clients:reconnect")).toBe(true);
    expect(checkPermission(makeUser({ role: "viewer" }), "clients:reconnect")).toBe(false);
  });
});

describe("checkAnyPermission", () => {
  test("returns false for null user", () => {
    expect(checkAnyPermission(null, ["users:manage", "clients:control"])).toBe(false);
  });

  test("returns true if user has at least one permission", () => {
    const user = makeUser({ role: "operator" });
    expect(checkAnyPermission(user, ["users:manage", "clients:control"])).toBe(true);
  });

  test("returns false if user has none of the permissions", () => {
    const user = makeUser({ role: "viewer" });
    expect(checkAnyPermission(user, ["users:manage", "clients:control"])).toBe(false);
  });

  test("returns true for empty permissions array (vacuously)", () => {
    const user = makeUser({ role: "viewer" });
    // Array.some on empty returns false
    expect(checkAnyPermission(user, [])).toBe(false);
  });
});

describe("checkAllPermissions", () => {
  test("returns false for null user", () => {
    expect(checkAllPermissions(null, ["users:manage"])).toBe(false);
  });

  test("admin has all permissions", () => {
    const user = makeUser({ role: "admin" });
    expect(
      checkAllPermissions(user, ["users:manage", "clients:control", "audit:view"]),
    ).toBe(true);
  });

  test("operator lacks users:manage so fails all check", () => {
    const user = makeUser({ role: "operator" });
    expect(
      checkAllPermissions(user, ["users:manage", "clients:control"]),
    ).toBe(false);
  });

  test("returns true for empty permissions array (vacuously)", () => {
    const user = makeUser({ role: "viewer" });
    expect(checkAllPermissions(user, [])).toBe(true);
  });
});

describe("requireAuth", () => {
  test("returns user when provided", () => {
    const user = makeUser();
    expect(requireAuth(user)).toBe(user);
  });

  test("throws 401 Response for null user", () => {
    expect(() => requireAuth(null)).toThrow();
    try {
      requireAuth(null);
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(401);
    }
  });
});

describe("requirePermission", () => {
  test("returns user when permission is satisfied", () => {
    const user = makeUser({ role: "admin" });
    expect(requirePermission(user, "users:manage")).toBe(user);
  });

  test("throws 401 for null user", () => {
    try {
      requirePermission(null, "users:manage");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(401);
    }
  });

  test("throws 403 when permission is not satisfied", () => {
    const user = makeUser({ role: "viewer" });
    try {
      requirePermission(user, "users:manage");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(403);
    }
  });
});

describe("requireAnyPermission", () => {
  test("returns user when at least one permission is satisfied", () => {
    const user = makeUser({ role: "operator" });
    expect(requireAnyPermission(user, ["users:manage", "clients:control"])).toBe(user);
  });

  test("throws 403 when none satisfied", () => {
    const user = makeUser({ role: "viewer" });
    try {
      requireAnyPermission(user, ["users:manage", "clients:control"]);
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(403);
    }
  });
});

describe("getPermissionDescription", () => {
  const cases: [Permission, string][] = [
    ["users:manage", "Manage users and roles"],
    ["clients:control", "Control clients (execute commands, desktop, console, files)"],
    ["clients:build", "Build client binaries"],
    ["clients:enroll", "Manage client enrollment approvals"],
    ["clients:silent-exec", "Silently execute arbitrary commands on clients"],
    ["audit:view", "View audit logs"],
    ["chat:write", "Send messages in team chat"],
    ["scripts:manage", "Manage auto-run scripts"],
    ["deploys:manage", "Manage deploys and auto-deploys"],
    ["plugins:manage", "Upload, enable, and delete plugins"],
    ["plugins:configure", "Configure plugin trust, auto-load, and direct execution"],
    ["network:manage-bans", "Manage IP bans"],
    ["system:configure", "Legacy full server settings access (grants all system:* settings permissions)"],
    ["clients:winre", "Install or uninstall WinRE persistence on clients"],
  ];

  for (const [perm, desc] of cases) {
    test(`${perm} → "${desc}"`, () => {
      expect(getPermissionDescription(perm)).toBe(desc);
    });
  }

  test("unknown permission returns fallback", () => {
    expect(getPermissionDescription("bogus:perm" as Permission)).toBe("Unknown permission");
  });
});

describe("getRolePermissions", () => {
  test("admin gets every declared permission", () => {
    const perms = getRolePermissions("admin");
    expect(perms).toContain("users:manage");
    expect(perms).toContain("clients:control");
    expect(perms).toContain("clients:build");
    expect(perms).toContain("clients:enroll");
    expect(perms).toContain("clients:silent-exec");
    expect(perms).toContain("audit:view");
    expect(perms).toContain("chat:write");
    expect(perms).toContain("scripts:manage");
    expect(perms).toContain("deploys:manage");
    expect(perms).toContain("plugins:manage");
    expect(perms).toContain("plugins:configure");
    expect(perms).toContain("network:manage-bans");
    expect(perms).toContain("system:configure");
    expect(perms).toContain("clients:winre");
  });

  test("operator gets the role-eligible subset", () => {
    const perms = getRolePermissions("operator");
    expect(perms).toContain("clients:control");
    expect(perms).toContain("clients:build");
    expect(perms).toContain("clients:enroll");
    expect(perms).toContain("audit:view");
    expect(perms).toContain("chat:write");
    expect(perms).toContain("plugins:manage");
    expect(perms).not.toContain("users:manage");
    expect(perms).not.toContain("scripts:manage");
    expect(perms).not.toContain("deploys:manage");
    expect(perms).not.toContain("plugins:configure");
    expect(perms).not.toContain("network:manage-bans");
    expect(perms).not.toContain("clients:silent-exec");
    expect(perms).not.toContain("system:configure");
    expect(perms).not.toContain("clients:winre");
  });

  test("viewer gets nothing", () => {
    expect(getRolePermissions("viewer")).toHaveLength(0);
  });
});

describe("listAllPermissions", () => {
  test("returns every key declared in the PERMISSIONS registry", () => {
    const perms = listAllPermissions();
    // Spot-check a sampling of permissions we know exist — if any are missing,
    // the route-layer sanitizer would silently strip them.
    expect(perms).toContain("users:manage" as Permission);
    expect(perms).toContain("clients:control" as Permission);
    expect(perms).toContain("clients:disconnect" as Permission);
    expect(perms).toContain("clients:reconnect" as Permission);
    expect(perms).toContain("clients:metadata" as Permission);
    expect(perms).toContain("clients:uninstall" as Permission);
    expect(perms).toContain("system:configure" as Permission);
    expect(perms).toContain("network:manage-bans" as Permission);
  });

  test("returns the same length as the description coverage (every entry has a description)", () => {
    const perms = listAllPermissions();
    for (const p of perms) {
      const desc = getPermissionDescription(p);
      expect(desc).not.toBe("Unknown permission");
      expect(desc.length).toBeGreaterThan(0);
    }
  });

  test("has no duplicates", () => {
    const perms = listAllPermissions();
    expect(new Set(perms).size).toBe(perms.length);
  });
});

describe("getRoleDescription", () => {
  test("admin description", () => {
    expect(getRoleDescription("admin")).toBe(
      "Full access - can manage users and control all clients",
    );
  });

  test("operator description", () => {
    expect(getRoleDescription("operator")).toBe(
      "Can control clients but cannot manage users",
    );
  });

  test("viewer description", () => {
    expect(getRoleDescription("viewer")).toBe("Read-only access to view clients");
  });

  test("unknown role returns fallback", () => {
    expect(getRoleDescription("unknown" as any)).toBe("Unknown role");
  });
});
