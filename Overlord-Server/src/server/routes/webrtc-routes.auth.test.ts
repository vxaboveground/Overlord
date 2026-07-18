import { afterEach, describe, expect, test } from "bun:test";
import { generateToken } from "../../auth";
import {
  createUser,
  deleteUser,
  getUserById,
  setUserClientAccessScope,
  setUserFeaturePermission,
} from "../../users";
import {
  handleWebrtcRoutes,
  revokeWebrtcViewerSessions,
  trackWebrtcViewerSession,
} from "./webrtc-routes";

const PASSWORD = "Aa1!WebrtcAuthTestPass_2026";
const createdUserIds: number[] = [];

async function makeOperator() {
  const username = `wa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const result = await createUser(username, PASSWORD, "operator", "test");
  expect(result.success).toBe(true);
  const user = getUserById(result.userId!);
  expect(user).not.toBeNull();
  createdUserIds.push(user!.id);
  setUserClientAccessScope(user!.id, "all");
  return { user: user!, token: await generateToken(user!) };
}

afterEach(() => {
  while (createdUserIds.length) deleteUser(createdUserIds.pop()!);
});

describe("WebRTC viewer authorization", () => {
  test("denies WHEP negotiation when the matching feature is disabled", async () => {
    const auth = await makeOperator();
    setUserFeaturePermission(auth.user.id, "remote_desktop", false);
    const url = new URL("https://localhost/api/webrtc/agents/client-a/desktop/whep");
    const response = await handleWebrtcRoutes(
      new Request(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${auth.token}` },
        body: "offer",
      }),
      url,
    );
    expect(response!.status).toBe(403);
  });

  test("uses the feature corresponding to each media kind", async () => {
    const auth = await makeOperator();
    setUserFeaturePermission(auth.user.id, "voice", false);
    const url = new URL("https://localhost/api/webrtc/agents/client-a/audio/whep");
    const response = await handleWebrtcRoutes(
      new Request(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${auth.token}` },
        body: "offer",
      }),
      url,
    );
    expect(response!.status).toBe(403);
  });

  test("revokes only the matching user's tracked media sessions", async () => {
    const deleted: string[] = [];
    trackWebrtcViewerSession({
      upstreamUrl: "http://mediamtx/session-a",
      userId: 1001,
      clientId: "client-a",
      kind: "desktop",
      createdAt: Date.now(),
    });
    trackWebrtcViewerSession({
      upstreamUrl: "http://mediamtx/session-b",
      userId: 1002,
      clientId: "client-a",
      kind: "desktop",
      createdAt: Date.now(),
    });

    const count = await revokeWebrtcViewerSessions(1001, "client-a", async (url) => {
      deleted.push(url);
    });
    expect(count).toBe(1);
    expect(deleted).toEqual(["http://mediamtx/session-a"]);

    await revokeWebrtcViewerSessions(1002, "client-a", async () => {});
  });
});
