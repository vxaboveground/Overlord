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

  test("viewer does not have clients:control", () => {
    expect(checkPermission(makeUser({ role: "viewer" }), "clients:control")).toBe(false);
  });

  test("admin has audit:view", () => {
    expect(checkPermission(makeUser({ role: "admin" }), "audit:view")).toBe(true);
  });

  test("operator does not have audit:view", () => {
    expect(checkPermission(makeUser({ role: "operator" }), "audit:view")).toBe(false);
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
    ["clients:view", "View connected clients"],
    ["clients:build", "Build client binaries"],
    ["audit:view", "View audit logs"],
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
