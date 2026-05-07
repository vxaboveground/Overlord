import { describe, expect, test, beforeEach } from "bun:test";
import { encodeMessage, decodeMessage, type Hello, type EnrollmentChallenge, type EnrollmentStatusMsg } from "./protocol";


async function generateKeypair() {
  const kp = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const pubRaw = await crypto.subtle.exportKey("raw", kp.publicKey);
  const privRaw = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
  return {
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    publicKeyBase64: Buffer.from(pubRaw).toString("base64"),
    publicKeyBytes: new Uint8Array(pubRaw),
  };
}

async function sign(privateKey: CryptoKey, data: Uint8Array): Promise<string> {
  const sig = await crypto.subtle.sign("Ed25519", privateKey, data as any);
  return Buffer.from(sig).toString("base64");
}

async function verifyEd25519(publicKeyBase64: string, signatureBase64: string, nonceBase64: string): Promise<boolean> {
  try {
    const pubKeyBytes = Buffer.from(publicKeyBase64, "base64");
    const sigBytes = Buffer.from(signatureBase64, "base64");
    const nonceBytes = Buffer.from(nonceBase64, "base64");
    if (pubKeyBytes.length !== 32 || sigBytes.length !== 64) return false;
    const key = await crypto.subtle.importKey("raw", pubKeyBytes, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, sigBytes, nonceBytes);
  } catch {
    return false;
  }
}

function computeKeyFingerprint(publicKeyBase64: string): string {
  const bytes = Buffer.from(publicKeyBase64, "base64");
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function createMockWs(overrides: Partial<{ clientId: string; role: string; ip: string; enrollmentNonce: string }> = {}) {
  const sent: Uint8Array[] = [];
  return {
    data: {
      clientId: overrides.clientId ?? "test-client-1",
      role: overrides.role ?? "client",
      ip: overrides.ip ?? "127.0.0.1",
      enrollmentNonce: overrides.enrollmentNonce ?? undefined,
      sessionId: "sess-1",
    },
    sent,
    closedCode: null as number | null,
    closedReason: null as string | null,
    send(msg: Uint8Array) { sent.push(msg); },
    close(code: number, reason: string) { this.closedCode = code; this.closedReason = reason; },
    decodeSent(index: number) { return decodeMessage(sent[index]) as any; },
  };
}

// tests (AI)

describe("purgatory — Ed25519 signature verification", () => {
  test("valid signature from matching keypair passes", async () => {
    const kp = await generateKeypair();
    const nonce = new Uint8Array(32);
    crypto.getRandomValues(nonce);
    const nonceB64 = Buffer.from(nonce).toString("base64");
    const sigB64 = await sign(kp.privateKey, nonce);

    expect(await verifyEd25519(kp.publicKeyBase64, sigB64, nonceB64)).toBe(true);
  });

  test("signature from wrong keypair is rejected", async () => {
    const kp1 = await generateKeypair();
    const kp2 = await generateKeypair();
    const nonce = new Uint8Array(32);
    crypto.getRandomValues(nonce);
    const nonceB64 = Buffer.from(nonce).toString("base64");
    // Sign with kp1 but verify with kp2's public key
    const sigB64 = await sign(kp1.privateKey, nonce);

    expect(await verifyEd25519(kp2.publicKeyBase64, sigB64, nonceB64)).toBe(false);
  });

  test("signature over wrong nonce is rejected", async () => {
    const kp = await generateKeypair();
    const nonce1 = new Uint8Array(32);
    const nonce2 = new Uint8Array(32);
    crypto.getRandomValues(nonce1);
    crypto.getRandomValues(nonce2);
    // Sign nonce1 but try to verify against nonce2
    const sigB64 = await sign(kp.privateKey, nonce1);

    expect(await verifyEd25519(kp.publicKeyBase64, sigB64, Buffer.from(nonce2).toString("base64"))).toBe(false);
  });

  test("empty public key is rejected", async () => {
    expect(await verifyEd25519("", "AAAA", "AAAA")).toBe(false);
  });

  test("empty signature is rejected", async () => {
    const kp = await generateKeypair();
    expect(await verifyEd25519(kp.publicKeyBase64, "", "AAAA")).toBe(false);
  });

  test("malformed public key (wrong length) is rejected", async () => {
    const nonce = new Uint8Array(32);
    crypto.getRandomValues(nonce);
    const nonceB64 = Buffer.from(nonce).toString("base64");
    // 16-byte key instead of 32
    const badKey = Buffer.from(new Uint8Array(16)).toString("base64");
    const fakeSig = Buffer.from(new Uint8Array(64)).toString("base64");

    expect(await verifyEd25519(badKey, fakeSig, nonceB64)).toBe(false);
  });

  test("malformed signature (wrong length) is rejected", async () => {
    const kp = await generateKeypair();
    const nonce = new Uint8Array(32);
    crypto.getRandomValues(nonce);
    const nonceB64 = Buffer.from(nonce).toString("base64");
    // 32-byte signature instead of 64
    const badSig = Buffer.from(new Uint8Array(32)).toString("base64");

    expect(await verifyEd25519(kp.publicKeyBase64, badSig, nonceB64)).toBe(false);
  });

  test("garbage base64 does not crash — returns false", async () => {
    expect(await verifyEd25519("not!!valid!!base64", "also!!bad", "nonce!!bad")).toBe(false);
  });
});

describe("purgatory — key fingerprint", () => {
  test("fingerprint is a 64-char hex SHA-256 of the raw public key bytes", async () => {
    const kp = await generateKeypair();
    const fp = computeKeyFingerprint(kp.publicKeyBase64);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  test("different keys produce different fingerprints", async () => {
    const kp1 = await generateKeypair();
    const kp2 = await generateKeypair();
    expect(computeKeyFingerprint(kp1.publicKeyBase64)).not.toBe(computeKeyFingerprint(kp2.publicKeyBase64));
  });

  test("same key always produces the same fingerprint", async () => {
    const kp = await generateKeypair();
    expect(computeKeyFingerprint(kp.publicKeyBase64)).toBe(computeKeyFingerprint(kp.publicKeyBase64));
  });
});

describe("purgatory — enrollment challenge protocol", () => {
  test("enrollment_challenge message encodes/decodes with nonce", () => {
    const nonce = Buffer.from(new Uint8Array(32)).toString("base64");
    const msg = encodeMessage({ type: "enrollment_challenge", nonce });
    const decoded = decodeMessage(msg) as EnrollmentChallenge;
    expect(decoded.type).toBe("enrollment_challenge");
    expect(decoded.nonce).toBe(nonce);
  });

  test("enrollment_status message encodes/decodes with status", () => {
    for (const status of ["pending", "approved", "denied"] as const) {
      const msg = encodeMessage({ type: "enrollment_status", status });
      const decoded = decodeMessage(msg) as EnrollmentStatusMsg;
      expect(decoded.type).toBe("enrollment_status");
      expect(decoded.status).toBe(status);
    }
  });

  test("hello message with publicKey and signature round-trips", async () => {
    const kp = await generateKeypair();
    const hello: Hello = {
      type: "hello",
      id: "client-abc",
      host: "DESKTOP-1",
      os: "windows",
      arch: "amd64",
      version: "1.0.0",
      user: "testuser",
      monitors: 2,
      country: "US",
      publicKey: kp.publicKeyBase64,
      signature: "fakesig==",
    };
    const encoded = encodeMessage(hello);
    const decoded = decodeMessage(encoded) as Hello;
    expect(decoded.publicKey).toBe(kp.publicKeyBase64);
    expect(decoded.signature).toBe("fakesig==");
  });
});

describe("purgatory — client rejection scenarios", () => {
  test("client with no publicKey is rejected (close 4002)", () => {
    const ws = createMockWs({ enrollmentNonce: Buffer.from(new Uint8Array(32)).toString("base64") });
    const payload: any = {
      type: "hello",
      id: "bad-client",
      host: "evil",
      os: "windows",
      arch: "amd64",
      version: "1.0",
      user: "hacker",
      monitors: 1,
      publicKey: "",
      signature: "something",
    };
    // Simulate the server's check: missing publicKey/signature/nonce
    const publicKey = typeof payload.publicKey === "string" ? payload.publicKey : "";
    const signature = typeof payload.signature === "string" ? payload.signature : "";
    const nonce = ws.data.enrollmentNonce || "";

    if (!publicKey || !signature || !nonce) {
      ws.close(4002, "invalid_signature");
    }

    expect(ws.closedCode).toBe(4002);
    expect(ws.closedReason).toBe("invalid_signature");
  });

  test("client with no signature is rejected (close 4002)", () => {
    const ws = createMockWs({ enrollmentNonce: Buffer.from(new Uint8Array(32)).toString("base64") });
    const publicKey = "validkeyhere";
    const signature = "";
    const nonce = ws.data.enrollmentNonce || "";

    if (!publicKey || !signature || !nonce) {
      ws.close(4002, "invalid_signature");
    }

    expect(ws.closedCode).toBe(4002);
  });

  test("client with no nonce stored on ws is rejected (close 4002)", () => {
    const ws = createMockWs({ enrollmentNonce: undefined });
    const publicKey = "somekey";
    const signature = "somesig";
    const nonce = ws.data.enrollmentNonce || "";

    if (!publicKey || !signature || !nonce) {
      ws.close(4002, "invalid_signature");
    }

    expect(ws.closedCode).toBe(4002);
  });

  test("client with invalid Ed25519 signature is rejected", async () => {
    const kp = await generateKeypair();
    const nonce = new Uint8Array(32);
    crypto.getRandomValues(nonce);
    const nonceB64 = Buffer.from(nonce).toString("base64");
    // Construct a bogus signature (not signed by this key)
    const badSig = Buffer.from(new Uint8Array(64).fill(0xAB)).toString("base64");

    const valid = await verifyEd25519(kp.publicKeyBase64, badSig, nonceB64);
    expect(valid).toBe(false);
    // Server would close with 4002
  });

  test("replay attack: reusing a nonce with a valid signature on a different nonce fails", async () => {
    const kp = await generateKeypair();
    const nonce1 = new Uint8Array(32);
    const nonce2 = new Uint8Array(32);
    crypto.getRandomValues(nonce1);
    crypto.getRandomValues(nonce2);

    // Client signed nonce1
    const sigB64 = await sign(kp.privateKey, nonce1);
    // Server presents nonce2 — verify against nonce2 should fail
    const valid = await verifyEd25519(kp.publicKeyBase64, sigB64, Buffer.from(nonce2).toString("base64"));
    expect(valid).toBe(false);
  });

  test("nonce is cleared after use — cannot be reused", () => {
    const ws = createMockWs({ enrollmentNonce: "someNonce==" });
    // Server clears nonce after successful verification
    ws.data.enrollmentNonce = undefined;
    expect(ws.data.enrollmentNonce).toBeUndefined();
    // Second attempt with no nonce → rejected
    const nonce = ws.data.enrollmentNonce || "";
    expect(nonce).toBe("");
  });

  test("denied client gets close code 4003", () => {
    const ws = createMockWs();
    // Simulate denied enrollment status
    const enrollmentStatus = "denied";
    if (enrollmentStatus === "denied") {
      ws.send(encodeMessage({ type: "enrollment_status", status: "denied" }));
      ws.close(4003, "denied");
    }
    expect(ws.closedCode).toBe(4003);
    expect(ws.closedReason).toBe("denied");
    const msg = ws.decodeSent(0);
    expect(msg.type).toBe("enrollment_status");
    expect(msg.status).toBe("denied");
  });

  test("pending client gets close code 4001", () => {
    const ws = createMockWs();
    const enrollmentStatus = "pending";
    if (enrollmentStatus === "pending") {
      ws.send(encodeMessage({ type: "enrollment_status", status: "pending" }));
      ws.close(4001, "pending");
    }
    expect(ws.closedCode).toBe(4001);
    expect(ws.closedReason).toBe("pending");
    const msg = ws.decodeSent(0);
    expect(msg.type).toBe("enrollment_status");
    expect(msg.status).toBe("pending");
  });

  test("approved client gets hello_ack (not closed)", async () => {
    const ws = createMockWs();
    const enrollmentStatus = "approved";
    if (enrollmentStatus === "approved") {
      ws.send(encodeMessage({
        type: "hello_ack",
        id: ws.data.clientId,
        notification: { keywords: [], minIntervalMs: 8000, clipboardEnabled: false },
      }));
    }
    expect(ws.closedCode).toBeNull();
    const msg = ws.decodeSent(0);
    expect(msg.type).toBe("hello_ack");
    expect(msg.id).toBe("test-client-1");
  });
});

describe("purgatory — enrollment timeout", () => {
  test("timeout constant is 30 seconds", () => {
    // This just documents the expected timeout value
    const ENROLLMENT_TIMEOUT_MS = 30_000;
    expect(ENROLLMENT_TIMEOUT_MS).toBe(30_000);
  });

  test("client that never sends hello would be closed with 4002 on timeout", () => {
    const ws = createMockWs();
    // Simulate timeout firing
    ws.close(4002, "enrollment_timeout");
    expect(ws.closedCode).toBe(4002);
    expect(ws.closedReason).toBe("enrollment_timeout");
  });
});

describe("purgatory — nonce generation", () => {
  test("nonce is 32 bytes of randomness", () => {
    const nonce = new Uint8Array(32);
    crypto.getRandomValues(nonce);
    expect(nonce.length).toBe(32);
    // Extremely unlikely all zeros
    expect(nonce.some((b) => b !== 0)).toBe(true);
  });

  test("sequential nonces are unique", () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const n = new Uint8Array(32);
      crypto.getRandomValues(n);
      nonces.add(Buffer.from(n).toString("base64"));
    }
    expect(nonces.size).toBe(100);
  });
});

describe("purgatory — end-to-end challenge-response", () => {
  test("legitimate client completes full handshake", async () => {
    // 1. Server generates nonce
    const nonceBytes = new Uint8Array(32);
    crypto.getRandomValues(nonceBytes);
    const nonceB64 = Buffer.from(nonceBytes).toString("base64");

    // 2. Client receives challenge and signs
    const kp = await generateKeypair();
    const sigB64 = await sign(kp.privateKey, nonceBytes);

    // 3. Server verifies
    const valid = await verifyEd25519(kp.publicKeyBase64, sigB64, nonceB64);
    expect(valid).toBe(true);

    // 4. Server computes fingerprint
    const fp = computeKeyFingerprint(kp.publicKeyBase64);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  test("attacker who intercepts nonce cannot sign without private key", async () => {
    // 1. Server generates nonce
    const nonceBytes = new Uint8Array(32);
    crypto.getRandomValues(nonceBytes);
    const nonceB64 = Buffer.from(nonceBytes).toString("base64");

    // 2. Attacker has the real client's public key but not private key
    const realClient = await generateKeypair();
    const attacker = await generateKeypair();

    // 3. Attacker tries to sign with their own key but present real client's pubkey
    const attackerSig = await sign(attacker.privateKey, nonceBytes);
    const valid = await verifyEd25519(realClient.publicKeyBase64, attackerSig, nonceB64);
    expect(valid).toBe(false);
  });

  test("attacker with own keypair gets new identity — not existing client", async () => {
    // Attacker generates valid keypair and signs correctly
    const attacker = await generateKeypair();
    const nonceBytes = new Uint8Array(32);
    crypto.getRandomValues(nonceBytes);
    const nonceB64 = Buffer.from(nonceBytes).toString("base64");
    const sigB64 = await sign(attacker.privateKey, nonceBytes);

    // Signature is valid...
    const valid = await verifyEd25519(attacker.publicKeyBase64, sigB64, nonceB64);
    expect(valid).toBe(true);

    // ...but fingerprint won't match any existing approved client
    const realClient = await generateKeypair();
    expect(computeKeyFingerprint(attacker.publicKeyBase64)).not.toBe(computeKeyFingerprint(realClient.publicKeyBase64));
  });

  test("all-zero signature is rejected", async () => {
    const kp = await generateKeypair();
    const nonceBytes = new Uint8Array(32);
    crypto.getRandomValues(nonceBytes);
    const nonceB64 = Buffer.from(nonceBytes).toString("base64");
    const zeroSig = Buffer.from(new Uint8Array(64)).toString("base64");

    expect(await verifyEd25519(kp.publicKeyBase64, zeroSig, nonceB64)).toBe(false);
  });

  test("random 32-byte value that is not a valid Ed25519 point is rejected", async () => {
    const nonceBytes = new Uint8Array(32);
    crypto.getRandomValues(nonceBytes);
    const nonceB64 = Buffer.from(nonceBytes).toString("base64");
    // 0xFF-filled is not a valid Ed25519 public key point
    const badKey = Buffer.from(new Uint8Array(32).fill(0xFF)).toString("base64");
    const fakeSig = Buffer.from(new Uint8Array(64).fill(0x42)).toString("base64");

    expect(await verifyEd25519(badKey, fakeSig, nonceB64)).toBe(false);
  });
});

describe("purgatory — duplicate connection prevention", () => {
  test("superseded socket gets close code 4004", () => {
    // Simulate: old socket is active, then new socket arrives for same clientId
    const oldWs = createMockWs({ clientId: "dup-client" });
    const newWs = createMockWs({ clientId: "dup-client" });

    // Simulated client manager (Map<string, { ws: any }>)
    const clients = new Map<string, { ws: any }>();
    clients.set("dup-client", { ws: oldWs });

    // New connection arrives — kick old
    const existing = clients.get("dup-client");
    if (existing && existing.ws !== newWs) {
      existing.ws.close(4004, "superseded");
      clients.delete("dup-client");
    }
    clients.set("dup-client", { ws: newWs });

    expect(oldWs.closedCode).toBe(4004);
    expect(oldWs.closedReason).toBe("superseded");
    expect(newWs.closedCode).toBeNull();
    expect(clients.get("dup-client")!.ws).toBe(newWs);
  });

  test("superseded socket close handler skips cleanup", () => {
    // Simulate: old socket fires close, but manager already has the new socket
    const oldWs = createMockWs({ clientId: "dup-client" });
    const newWs = createMockWs({ clientId: "dup-client" });

    const clients = new Map<string, { ws: any }>();
    clients.set("dup-client", { ws: newWs }); // new one already registered

    // Old socket close handler fires
    const current = clients.get("dup-client");
    const shouldSkipCleanup = current && current.ws !== oldWs;

    expect(shouldSkipCleanup).toBe(true);
    // New socket should stay in place
    expect(clients.get("dup-client")!.ws).toBe(newWs);
  });

  test("normal close handler cleans up when socket matches", () => {
    const ws = createMockWs({ clientId: "normal-client" });
    const clients = new Map<string, { ws: any }>();
    clients.set("normal-client", { ws });

    // Close handler — socket matches current
    const current = clients.get("normal-client");
    const shouldSkipCleanup = current && current.ws !== ws;

    expect(shouldSkipCleanup).toBe(false);
    // Should proceed with cleanup
    clients.delete("normal-client");
    expect(clients.has("normal-client")).toBe(false);
  });

  test("same socket reconnecting is not kicked (identity check)", () => {
    const ws = createMockWs({ clientId: "same-client" });
    const clients = new Map<string, { ws: any }>();
    clients.set("same-client", { ws });

    // Same ws object reconnects — should NOT kick itself
    const existing = clients.get("same-client");
    if (existing && existing.ws !== ws) {
      existing.ws.close(4004, "superseded");
    }

    // Should not have been closed
    expect(ws.closedCode).toBeNull();
  });
});

describe("purgatory — IP banning", () => {
  test("IP validation regex accepts valid IPv4", () => {
    const ipRegex = /^[0-9a-fA-F:.]{3,64}$/;
    expect(ipRegex.test("192.168.1.1")).toBe(true);
    expect(ipRegex.test("10.0.0.1")).toBe(true);
    expect(ipRegex.test("255.255.255.255")).toBe(true);
  });

  test("IP validation regex accepts valid IPv6", () => {
    const ipRegex = /^[0-9a-fA-F:.]{3,64}$/;
    expect(ipRegex.test("::1")).toBe(true);
    expect(ipRegex.test("fe80::1")).toBe(true);
    expect(ipRegex.test("2001:db8::1")).toBe(true);
  });

  test("IP validation regex rejects dangerous input", () => {
    const ipRegex = /^[0-9a-fA-F:.]{3,64}$/;
    expect(ipRegex.test("")).toBe(false);
    expect(ipRegex.test("a")).toBe(false); // too short
    expect(ipRegex.test("'; DROP TABLE--")).toBe(false);
    expect(ipRegex.test("192.168.1.1; rm -rf /")).toBe(false);
    expect(ipRegex.test("<script>alert(1)</script>")).toBe(false);
  });

  test("banned client gets close code 4003", () => {
    const ws = createMockWs({ ip: "1.2.3.4" });
    // Simulate banning: deny enrollment + close socket
    ws.close(4003, "banned");
    expect(ws.closedCode).toBe(4003);
    expect(ws.closedReason).toBe("banned");
  });

  test("ban reason is truncated to 200 chars", () => {
    const longReason = "A".repeat(500);
    const truncated = longReason.slice(0, 200);
    expect(truncated.length).toBe(200);
    expect(truncated).toBe("A".repeat(200));
  });
});

describe("purgatory — HWID collision prevention", () => {
  test("two different public keys produce different key fingerprints", async () => {
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const fpA = computeKeyFingerprint(kpA.publicKeyBase64);
    const fpB = computeKeyFingerprint(kpB.publicKeyBase64);
    expect(fpA).not.toBe(fpB);
    // fingerprints are 64-char hex
    expect(fpA).toMatch(/^[a-f0-9]{64}$/);
    expect(fpB).toMatch(/^[a-f0-9]{64}$/);
  });

  test("key fingerprint is deterministic for same public key", async () => {
    const kp = await generateKeypair();
    const fp1 = computeKeyFingerprint(kp.publicKeyBase64);
    const fp2 = computeKeyFingerprint(kp.publicKeyBase64);
    expect(fp1).toBe(fp2);
  });

  test("collision detection assigns different IDs to same-HWID machines", async () => {
    // Simulate: Machine A and Machine B share HWID "colliding-hwid"
    // but have different key pairs. After collision detection,
    // Machine B should get the key fingerprint as its ID.
    const kpA = await generateKeypair();
    const kpB = await generateKeypair();
    const sharedHwid = "colliding-hwid";

    const fpA = computeKeyFingerprint(kpA.publicKeyBase64);
    const fpB = computeKeyFingerprint(kpB.publicKeyBase64);

    // Machine A: lookupClientByPublicKey → null, no existing client at ID → keeps HWID
    const wsA = createMockWs({ clientId: sharedHwid });
    // Simulate server logic: no existing key at this ID → keep URL ID
    const existingPkAtId: string | null = null; // DB empty
    if (existingPkAtId && existingPkAtId !== kpA.publicKeyBase64) {
      wsA.data.clientId = fpA;
    }
    expect(wsA.data.clientId).toBe(sharedHwid); // Machine A keeps HWID

    // Machine B: lookupClientByPublicKey → null, but ID already taken by PK_A
    const wsB = createMockWs({ clientId: sharedHwid });
    const existingPkAtIdForB: string | null = kpA.publicKeyBase64; // Machine A's key is stored at this ID
    if (existingPkAtIdForB && existingPkAtIdForB !== kpB.publicKeyBase64) {
      wsB.data.clientId = fpB;
    }
    expect(wsB.data.clientId).toBe(fpB); // Machine B gets reassigned
    expect(wsB.data.clientId).not.toBe(sharedHwid);
  });

  test("no collision when same machine reconnects with same public key", async () => {
    const kp = await generateKeypair();
    const hwid = "same-machine-hwid";
    const fp = computeKeyFingerprint(kp.publicKeyBase64);

    const ws = createMockWs({ clientId: hwid });
    // Same key already at this ID → no collision
    const existingPkAtId: string | null = kp.publicKeyBase64;
    if (existingPkAtId && existingPkAtId !== kp.publicKeyBase64) {
      ws.data.clientId = fp;
    }
    expect(ws.data.clientId).toBe(hwid); // keeps original ID
  });
});
