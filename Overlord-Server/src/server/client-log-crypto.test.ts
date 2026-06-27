import { beforeAll, describe, expect, test } from "bun:test";
import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes } from "crypto";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { decryptClientLogBlob, extractSecureLogBlobs, getClientLogPublicKey } from "./client-log-crypto";

beforeAll(() => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "overlord-client-log-test-"));
});

function makeBlob(seq: number, at: number, source: string, text: string): string {
  const publicKey = Buffer.from(getClientLogPublicKey(), "base64");
  const aesKey = randomBytes(32);
  const nonce = randomBytes(12);
  const aad = Buffer.from(`${seq}:${at}:${source}`, "utf8");
  const cipher = createCipheriv("aes-256-gcm", aesKey, nonce);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final(), cipher.getAuthTag()]);
  const wrapped = publicEncrypt(
    {
      key: createPublicKey({ key: publicKey, format: "der", type: "spki" }),
      oaepHash: "sha256",
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepLabel: aad,
    },
    aesKey,
  );
  return Buffer.from(JSON.stringify({
    v: 1,
    alg: "RSA-OAEP-SHA256+A256GCM",
    seq,
    at,
    source,
    wrappedKey: wrapped.toString("base64"),
    nonce: nonce.toString("base64"),
    ciphertext: encrypted.toString("base64"),
  })).toString("base64");
}

describe("client log crypto", () => {
  test("decrypts secure log blobs", () => {
    const blob = makeBlob(7, 12345, "log", "hello secure logs");
    expect(decryptClientLogBlob(blob)).toEqual({
      seq: 7,
      at: 12345,
      source: "log",
      text: "hello secure logs",
    });
  });

  test("extracts offline console lines", () => {
    const blob = makeBlob(8, 12346, "stdout", "offline");
    expect(extractSecureLogBlobs(`noise\nOVERLORD-SECURE-LOG v1 seq=8 source=stdout ${blob}\n`)).toContain(blob);
  });
});
