import { afterEach, describe, expect, test } from "bun:test";
import { generateToken } from "../auth";
import { hashTokenForSession, revokeSessionByTokenHash } from "../db";
import type { SocketData } from "../sessions/types";
import {
  createUser,
  deleteUser,
  getUserById,
  setUserClientAccessScope,
  setUserFeaturePermission,
} from "../users";
import { validateViewerAuthorization } from "./viewer-authorization";

const PASSWORD = "Aa1!ViewerRevalidationTest_2026";
const createdUserIds: number[] = [];

async function makeViewerSocket(role: SocketData["role"], clientId = "client-a") {
  const username = `wr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const result = await createUser(username, PASSWORD, "operator", "test");
  expect(result.success).toBe(true);
  const user = getUserById(result.userId!);
  expect(user).not.toBeNull();
  createdUserIds.push(user!.id);
  setUserClientAccessScope(user!.id, "all");
  const token = await generateToken(user!);
  const closes: Array<{ code: number; reason: string }> = [];
  const ws = {
    data: {
      role,
      clientId,
      userId: user!.id,
      userRole: user!.role,
      username: user!.username,
      authTokenHash: hashTokenForSession(token),
    },
    close(code: number, reason: string) {
      closes.push({ code, reason });
    },
  } as any;
  return { user: user!, token, ws, closes };
}

afterEach(() => {
  while (createdUserIds.length) deleteUser(createdUserIds.pop()!);
});

describe("live viewer WebSocket authorization", () => {
  test("closes a socket after its login session is revoked", async () => {
    const auth = await makeViewerSocket("rd_viewer");
    expect(validateViewerAuthorization(auth.ws)).toBe(true);
    revokeSessionByTokenHash(hashTokenForSession(auth.token));
    expect(validateViewerAuthorization(auth.ws)).toBe(false);
    expect(auth.closes).toEqual([{ code: 1008, reason: "Authentication expired" }]);
  });

  test("closes a socket when its feature is revoked after connection", async () => {
    const auth = await makeViewerSocket("rd_viewer");
    expect(validateViewerAuthorization(auth.ws)).toBe(true);
    setUserFeaturePermission(auth.user.id, "remote_desktop", false);
    expect(validateViewerAuthorization(auth.ws)).toBe(false);
    expect(auth.closes[0]?.reason).toBe("Forbidden: feature access denied");
  });

  test("closes a socket when client scope is removed after connection", async () => {
    const auth = await makeViewerSocket("console_viewer");
    expect(validateViewerAuthorization(auth.ws)).toBe(true);
    setUserClientAccessScope(auth.user.id, "none");
    expect(validateViewerAuthorization(auth.ws)).toBe(false);
    expect(auth.closes[0]?.reason).toBe("Forbidden: client access denied");
  });
});
