import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { buildTurnIceServers } from "./turn-credentials";

describe("Coturn REST credentials", () => {
  test("issues matching short-lived HMAC credentials", () => {
    const servers = buildTurnIceServers({
      host: "turn.example.test",
      port: 3478,
      realm: "overlord",
      secret: "test-master-secret",
      ttlSeconds: 3600,
    }, "agent:desktop/session", 1_700_000_000_000);

    expect(servers[0]).toEqual({ urls: ["stun:turn.example.test:3478"] });
    const turn = servers[1];
    expect(turn.urls).toEqual([
      "turn:turn.example.test:3478?transport=udp",
      "turn:turn.example.test:3478?transport=tcp",
    ]);
    expect(turn.username).toBe("1700003600:agent_desktop_session");
    expect(turn.credential).toBe(
      createHmac("sha1", "test-master-secret").update(turn.username!).digest("base64"),
    );
    expect(JSON.stringify(servers)).not.toContain("test-master-secret");
  });
});
