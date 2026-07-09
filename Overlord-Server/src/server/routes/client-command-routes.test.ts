import { describe, expect, test } from "bun:test";
import { decodeMessage } from "../../protocol";
import type { ClientInfo } from "../../types";
import { dispatchPingBulk } from "./client-command-routes";

function makeClient(): ClientInfo {
  const sent: Uint8Array[] = [];
  return {
    id: "bulk-ping-client",
    role: "client",
    lastSeen: Date.now(),
    ws: {
      send(data: Uint8Array) {
        sent.push(data);
      },
      _sent: sent,
    },
  } as any;
}

describe("client command ping diagnostics", () => {
  test("dispatchPingBulk sends the requested number of pings", () => {
    const client = makeClient();
    const sent = (client.ws as any)._sent as Uint8Array[];

    const count = dispatchPingBulk(client, 3);

    expect(count).toBe(3);
    expect(sent.length).toBe(3);
    for (const raw of sent) {
      const payload = decodeMessage(raw) as any;
      expect(payload.type).toBe("ping");
      expect(typeof payload.ts).toBe("number");
    }
    expect(typeof client.lastPingNonce).toBe("number");
  });

  test("dispatchPingBulk clamps invalid and large counts", () => {
    const invalid = makeClient();
    expect(dispatchPingBulk(invalid, "bad")).toBe(1);
    expect((invalid.ws as any)._sent.length).toBe(1);

    const large = makeClient();
    expect(dispatchPingBulk(large, 5000)).toBe(1000);
    expect((large.ws as any)._sent.length).toBe(1000);
  });
});
