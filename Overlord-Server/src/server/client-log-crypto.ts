import {
  constants,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
} from "crypto";
import logger from "../logger";
import {
  getClientLogSecrets,
  setClientLogSecrets,
  type ClientLogSecrets,
} from "../config";

type SecureLogEnvelope = {
  v: number;
  alg: string;
  seq: number;
  at: number;
  source: string;
  wrappedKey: string;
  nonce: string;
  ciphertext: string;
};

export type DecryptedClientLog = {
  seq: number;
  at: number;
  source: string;
  text: string;
};

let cachedSecrets: ClientLogSecrets | null = null;

function ensureClientLogSecrets(): ClientLogSecrets {
  if (cachedSecrets) return cachedSecrets;
  let secrets = getClientLogSecrets();
  if (!secrets) {
    const kp = generateKeyPairSync("rsa", {
      modulusLength: 3072,
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    secrets = {
      privateKey: kp.privateKey.toString(),
      publicKey: Buffer.from(kp.publicKey).toString("base64"),
    };
    setClientLogSecrets(secrets);
    logger.info("[client-logs] generated new RSA-OAEP log decryption keypair");
  }
  cachedSecrets = secrets;
  return secrets;
}

export function getClientLogPublicKey(): string {
  return ensureClientLogSecrets().publicKey;
}

export function resetClientLogCryptoCacheForTests(): void {
  cachedSecrets = null;
}

export function decryptClientLogBlob(blob: string): DecryptedClientLog {
  const secrets = ensureClientLogSecrets();
  const decoded = Buffer.from(String(blob || "").trim(), "base64").toString("utf-8");
  const env = JSON.parse(decoded) as SecureLogEnvelope;
  if (!env || env.v !== 1 || env.alg !== "RSA-OAEP-SHA256+A256GCM") {
    throw new Error("Unsupported secure log envelope");
  }
  const seq = Number(env.seq) || 0;
  const at = Number(env.at) || 0;
  const source = String(env.source || "log");
  const aad = Buffer.from(`${seq}:${at}:${source}`, "utf-8");
  const aesKey = privateDecrypt(
    {
      key: secrets.privateKey,
      oaepHash: "sha256",
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepLabel: aad,
    },
    Buffer.from(env.wrappedKey, "base64"),
  );
  const encrypted = Buffer.from(env.ciphertext, "base64");
  if (encrypted.length < 17) throw new Error("Malformed secure log ciphertext");
  const tag = encrypted.subarray(encrypted.length - 16);
  const ciphertext = encrypted.subarray(0, encrypted.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", aesKey, Buffer.from(env.nonce, "base64"));
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return { seq, at, source, text: plaintext.toString("utf-8") };
}

export function extractSecureLogBlobs(input: string): string[] {
  const blobs: string[] = [];
  for (const line of String(input || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/OVERLORD-SECURE-LOG\s+v1\s+seq=\d+\s+source=\S+\s+([A-Za-z0-9+/=]+)$/);
    blobs.push(match ? match[1] : trimmed);
  }
  return blobs;
}
