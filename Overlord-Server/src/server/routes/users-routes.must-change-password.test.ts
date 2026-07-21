import { afterEach, describe, expect, test } from "bun:test";
import { generateToken } from "../../auth";
import { createUser, deleteUser, getUserById } from "../../users";
import { handleUsersRoutes } from "./users-routes";

const PASSWORD = "Aa1!MustChangeRouteTestPass_2026";
const createdUserIds: number[] = [];

const mockServer = {
  requestIP: () => ({ address: "127.0.0.1" }),
};

async function createAuthedAdmin() {
  const username = `mcp_admin_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const result = await createUser(username, PASSWORD, "admin", "test");
  expect(result.success).toBe(true);
  expect(typeof result.userId).toBe("number");
  createdUserIds.push(result.userId!);
  const user = getUserById(result.userId!);
  expect(user).not.toBeNull();
  const token = await generateToken(user!);
  return { user: user!, token };
}

afterEach(() => {
  while (createdUserIds.length > 0) {
    const id = createdUserIds.pop();
    if (typeof id === "number") deleteUser(id);
  }
});

describe("admin-created users must change password", () => {
  test("POST /api/users marks new users for password change", async () => {
    const admin = await createAuthedAdmin();
    const username = `mcp_user_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
    const url = new URL("https://localhost/api/users");

    const res = await handleUsersRoutes(
      new Request(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${admin.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ username, password: PASSWORD, role: "viewer" }),
      }),
      url,
      mockServer,
    );

    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(typeof body.userId).toBe("number");
    createdUserIds.push(body.userId);
    const created = getUserById(body.userId);
    expect(created?.must_change_password).toBe(1);
  });

  test("POST /api/users allows an explicit first-login prompt exemption", async () => {
    const admin = await createAuthedAdmin();
    const username = `mcp_exempt_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
    const url = new URL("https://localhost/api/users");

    const res = await handleUsersRoutes(
      new Request(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${admin.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          username,
          password: PASSWORD,
          role: "viewer",
          mustChangePassword: false,
        }),
      }),
      url,
      mockServer,
    );

    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json();
    createdUserIds.push(body.userId);
    expect(getUserById(body.userId)?.must_change_password).toBe(0);
  });

  test("self password update may reuse the initial password and clears the prompt", async () => {
    const admin = await createAuthedAdmin();
    const username = `mcp_same_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
    const createUrl = new URL("https://localhost/api/users");
    const createRes = await handleUsersRoutes(
      new Request(createUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${admin.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ username, password: PASSWORD, role: "operator" }),
      }),
      createUrl,
      mockServer,
    );
    expect(createRes).not.toBeNull();
    expect(createRes!.status).toBe(200);
    const createBody = await createRes!.json();
    createdUserIds.push(createBody.userId);
    const created = getUserById(createBody.userId);
    expect(created?.must_change_password).toBe(1);
    expect(created).not.toBeNull();

    const userToken = await generateToken(created!);
    const updateUrl = new URL(`https://localhost/api/users/${createBody.userId}/password`);
    const updateRes = await handleUsersRoutes(
      new Request(updateUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ currentPassword: PASSWORD, newPassword: PASSWORD }),
      }),
      updateUrl,
      mockServer,
    );

    expect(updateRes).not.toBeNull();
    expect(updateRes!.status).toBe(200);
    expect(getUserById(createBody.userId)?.must_change_password).toBe(0);
  });
});
