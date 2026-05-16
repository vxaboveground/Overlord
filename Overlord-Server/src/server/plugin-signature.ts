import fs from "fs/promises";
import path from "path";
import AdmZip from "adm-zip";
import type { PluginSignatureInfo } from "../protocol";
import { logger } from "../logger";
import { getConfig } from "../config";

export const BUILTIN_TRUSTED_KEYS: string[] = [
  "c0f7b94f9678425d08d2408fd92494c419a5ea6819ee4dbcebc41d86c22c61fa",
  "f584e6b7f9c0e1dc4037e3f667918707a95a86d075bfc49bd4eebf0571eb0ff6",
];

export async function computeContentDigest(zip: InstanceType<typeof AdmZip>): Promise<string> {
  const entries = zip.getEntries();
  const fileHashes: Array<{ name: string; hash: string }> = [];

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (entry.entryName === "signature.json") continue;

    const data = entry.getData();
    const hashBuf = await crypto.subtle.digest("SHA-256", new Uint8Array(data));
    const hash = Buffer.from(hashBuf).toString("hex");
    fileHashes.push({ name: entry.entryName, hash });
  }

  fileHashes.sort((a, b) => a.name.localeCompare(b.name));
  return fileHashes.map((f) => `${f.name}:${f.hash}\n`).join("");
}

export function extractSignatureFromZip(
  zip: InstanceType<typeof AdmZip>,
): { algorithm: string; publicKey: string; signature: string } | null {
  const entry = (zip as any).getEntry("signature.json");
  if (!entry) return null;

  try {
    const raw = entry.getData().toString("utf-8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.algorithm === "string" &&
      typeof parsed.publicKey === "string" &&
      typeof parsed.signature === "string"
    ) {
      return {
        algorithm: parsed.algorithm,
        publicKey: parsed.publicKey,
        signature: parsed.signature,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function computeKeyFingerprint(publicKeyBase64: string): Promise<string> {
  const pubBytes = Buffer.from(publicKeyBase64, "base64");
  const hashBuf = await crypto.subtle.digest("SHA-256", pubBytes);
  return Buffer.from(hashBuf).toString("hex");
}

export function isKeyTrusted(fingerprint: string, trustedKeys: string[]): boolean {
  const normalized = fingerprint.toLowerCase();
  const allTrusted = [...BUILTIN_TRUSTED_KEYS, ...trustedKeys];
  return allTrusted.some((k) => k.toLowerCase() === normalized);
}

export async function verifyPluginSignature(zipPath: string): Promise<PluginSignatureInfo> {
  let zip: InstanceType<typeof AdmZip>;
  try {
    zip = new AdmZip(zipPath);
  } catch (err) {
    logger.warn(`[plugin-signature] failed to read ZIP ${zipPath}: ${(err as Error).message}`);
    return { signed: false, trusted: false, valid: false };
  }

  const sigData = extractSignatureFromZip(zip);
  if (!sigData) {
    return { signed: false, trusted: false, valid: false };
  }

  if (sigData.algorithm !== "ed25519") {
    logger.warn(`[plugin-signature] unsupported algorithm: ${sigData.algorithm}`);
    return { signed: true, trusted: false, valid: false, algorithm: sigData.algorithm };
  }

  try {
    const pubBytes = Buffer.from(sigData.publicKey, "base64");
    if (pubBytes.length !== 32) {
      return { signed: true, trusted: false, valid: false, algorithm: sigData.algorithm };
    }

    const publicKey = await crypto.subtle.importKey(
      "raw",
      pubBytes,
      { name: "Ed25519" },
      false,
      ["verify"],
    );

    const digest = await computeContentDigest(zip);
    const digestBytes = new TextEncoder().encode(digest);

    const sigBytes = Buffer.from(sigData.signature, "base64");
    if (sigBytes.length !== 64) {
      return { signed: true, trusted: false, valid: false, algorithm: sigData.algorithm };
    }

    const valid = await crypto.subtle.verify("Ed25519", publicKey, sigBytes, digestBytes);

    const fingerprint = await computeKeyFingerprint(sigData.publicKey);

    const config = getConfig();
    const trusted = valid && isKeyTrusted(fingerprint, config.plugins.trustedKeys);

    return {
      signed: true,
      valid,
      trusted,
      fingerprint,
      algorithm: sigData.algorithm,
    };
  } catch (err) {
    logger.warn(`[plugin-signature] verification error: ${(err as Error).message}`);
    return { signed: true, trusted: false, valid: false, algorithm: sigData.algorithm };
  }
}

export async function getOrVerifySignature(
  pluginRoot: string,
  pluginId: string,
): Promise<PluginSignatureInfo> {
  const sigInfoPath = path.join(pluginRoot, pluginId, "signature-info.json");
  const zipPath = path.join(pluginRoot, `${pluginId}.zip`);

  try {
    const [zipStat, sigInfoStat] = await Promise.all([
      fs.stat(zipPath),
      fs.stat(sigInfoPath),
    ]);
    if (sigInfoStat.mtimeMs >= zipStat.mtimeMs) {
      const raw = await fs.readFile(sigInfoPath, "utf-8");
      const cached = JSON.parse(raw) as PluginSignatureInfo;
      if (cached.signed && cached.valid && cached.fingerprint) {
        const config = getConfig();
        cached.trusted = isKeyTrusted(cached.fingerprint, config.plugins.trustedKeys);
      }
      return cached;
    }
  } catch {
  }

  try {
    await fs.stat(zipPath);
  } catch {
    return { signed: false, trusted: false, valid: false };
  }

  const info = await verifyPluginSignature(zipPath);

  try {
    await fs.mkdir(path.join(pluginRoot, pluginId), { recursive: true });
    await fs.writeFile(sigInfoPath, JSON.stringify(info, null, 2));
  } catch (err) {
    logger.warn(`[plugin-signature] failed to cache signature info: ${(err as Error).message}`);
  }

  return info;
}
