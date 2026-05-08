import fs from "fs/promises";
import path from "path";
import AdmZip from "adm-zip";
import { v4 as uuidv4 } from "uuid";
import type { ClientInfo } from "../types";
import { logger } from "../logger";
import { encodeMessage, type PluginManifest, type PluginSignatureInfo } from "../protocol";
import { verifyPluginSignature, getOrVerifySignature } from "./plugin-signature";

export type PluginState = {
  enabled: Record<string, boolean>;
  lastError: Record<string, string>;
  autoLoad: Record<string, boolean>;
  autoStartEvents: Record<string, Array<{ event: string; payload: any }>>;
};

export async function loadPluginStateFromDisk(pluginStatePath: string): Promise<PluginState> {
  try {
    const raw = await fs.readFile(pluginStatePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<PluginState>;
    return {
      enabled: parsed.enabled || {},
      lastError: parsed.lastError || {},
      autoLoad: parsed.autoLoad || {},
      autoStartEvents: parsed.autoStartEvents || {},
    };
  } catch {
    return { enabled: {}, lastError: {}, autoLoad: {}, autoStartEvents: {} };
  }
}

export async function savePluginStateToDisk(
  pluginRoot: string,
  pluginStatePath: string,
  pluginState: PluginState,
): Promise<void> {
  await fs.mkdir(pluginRoot, { recursive: true });
  await fs.writeFile(pluginStatePath, JSON.stringify(pluginState, null, 2));
}

export async function ensurePluginExtracted(
  pluginRoot: string,
  pluginId: string,
  sanitizePluginId: (name: string) => string,
): Promise<void> {
  const safeId = sanitizePluginId(pluginId);
  const zipPath = path.join(pluginRoot, `${safeId}.zip`);
  const pluginDir = path.join(pluginRoot, safeId);
  const manifestPath = path.join(pluginDir, "manifest.json");

  let zipStat: any = null;
  try {
    zipStat = await fs.stat(zipPath);
  } catch {
    zipStat = null;
  }

  let manifestStat: any = null;
  try {
    manifestStat = await fs.stat(manifestPath);
  } catch {
    manifestStat = null;
  }

  if (!zipStat) {
    if (manifestStat) return;
    throw new Error(`Plugin bundle not found: ${safeId}`);
  }

  if (manifestStat && manifestStat.mtimeMs >= zipStat.mtimeMs) {
    return;
  }

  await fs.mkdir(pluginDir, { recursive: true });
  const assetsDir = path.join(pluginDir, "assets");
  await fs.mkdir(assetsDir, { recursive: true });

  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  const MAX_PLUGIN_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
  let totalUncompressed = 0;
  for (const entry of entries as any[]) {
    if (entry?.isDirectory) continue;
    const sz = Number(entry?.header?.size ?? 0);
    if (!Number.isFinite(sz) || sz < 0) {
      throw new Error(`Invalid plugin bundle: ${safeId} (malformed zip)`);
    }
    totalUncompressed += sz;
    if (totalUncompressed > MAX_PLUGIN_UNCOMPRESSED_BYTES) {
      throw new Error(`Plugin bundle too large: ${safeId} (uncompressed > 200 MB)`);
    }
  }

  let htmlEntry: Buffer | null = null;
  let cssEntry: Buffer | null = null;
  let jsEntry: Buffer | null = null;
  let serverEntry: Buffer | null = null;
  let configEntry: Buffer | null = null;
  const nativeBinaries: Map<string, Buffer> = new Map();

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const base = path.basename(entry.entryName);
    const lower = base.toLowerCase();
    if (lower.endsWith(".so") || lower.endsWith(".dll") || lower.endsWith(".dylib")) {
      nativeBinaries.set(base, entry.getData());
    } else if (lower === "server.js") {
      serverEntry = entry.getData();
    } else if (lower.endsWith(".html")) {
      htmlEntry = entry.getData();
    } else if (lower.endsWith(".css")) {
      cssEntry = entry.getData();
    } else if (lower.endsWith(".js")) {
      jsEntry = entry.getData();
    } else if (lower === "config.json") {
      configEntry = entry.getData();
    }
  }

  if (!htmlEntry || !cssEntry || !jsEntry) {
    throw new Error(`Invalid plugin bundle: ${safeId} (missing .html, .css, or .js)`);
  }

  const binariesMap: Record<string, string> = {};
  for (const [filename, data] of nativeBinaries) {
    await fs.writeFile(path.join(pluginDir, filename), data);
    const platformKey = derivePlatformKey(filename);
    if (platformKey) {
      binariesMap[platformKey] = filename;
    }
  }

  await fs.writeFile(path.join(assetsDir, `${safeId}.html`), htmlEntry);
  await fs.writeFile(path.join(assetsDir, `${safeId}.css`), cssEntry);
  await fs.writeFile(path.join(assetsDir, `${safeId}.js`), jsEntry);

  const serverScriptPath = path.join(pluginDir, "server.js");
  if (serverEntry) {
    await fs.writeFile(serverScriptPath, serverEntry);
  } else {
    // A previous extraction may have left a stale server.js — drop it so the
    // runtime accurately reflects the current bundle.
    try { await fs.rm(serverScriptPath, { force: true }); } catch {}
  }

  let extraConfig: any = {};
  if (configEntry) {
    try {
      extraConfig = JSON.parse(configEntry.toString("utf-8"));
    } catch (err) {
      logger.warn(`[plugin] invalid config.json in bundle ${safeId}, ignoring: ${err}`);
    }
  }

  const manifest: PluginManifest = {
    id: safeId,
    name: extraConfig.name || safeId,
    version: extraConfig.version || "1.0.0",
    description: extraConfig.description,
    binaries: binariesMap,
    entry: `${safeId}.html`,
    assets: {
      html: `${safeId}.html`,
      css: `${safeId}.css`,
      js: `${safeId}.js`,
    },
    ...(extraConfig.navbar && { navbar: extraConfig.navbar }),
    hasServer: serverEntry !== null,
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  try {
    const sigInfo = await verifyPluginSignature(zipPath);
    const sigInfoPath = path.join(pluginDir, "signature-info.json");
    await fs.writeFile(sigInfoPath, JSON.stringify(sigInfo, null, 2));
  } catch (err) {
    logger.warn(`[plugin] failed to verify signature for ${safeId}: ${(err as Error).message}`);
  }
}

export async function syncPluginBundles(
  pluginRoot: string,
  ensureExtracted: (pluginId: string) => Promise<void>,
): Promise<void> {
  await fs.mkdir(pluginRoot, { recursive: true });
  const entries = await fs.readdir(pluginRoot, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.isFile() && ent.name.toLowerCase().endsWith(".zip")) {
      const pluginId = ent.name.slice(0, -4);
      try {
        await ensureExtracted(pluginId);
      } catch (err) {
        logger.warn(`[plugin] failed to extract ${pluginId}: ${(err as Error).message}`);
      }
    }
  }
}

export type PluginManifestWithSignature = PluginManifest & {
  signature?: PluginSignatureInfo;
};

export async function listPluginManifests(
  pluginRoot: string,
  pluginState: PluginState,
  saveState: () => Promise<void>,
  ensureExtracted: (pluginId: string) => Promise<void>,
): Promise<PluginManifestWithSignature[]> {
  try {
    await syncPluginBundles(pluginRoot, ensureExtracted);
    const entries = await fs.readdir(pluginRoot, { withFileTypes: true });
    const manifests: PluginManifestWithSignature[] = [];
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const manifestPath = path.join(pluginRoot, ent.name, "manifest.json");
      try {
        const raw = await fs.readFile(manifestPath, "utf-8");
        const manifest = JSON.parse(raw) as PluginManifest;
        const id = manifest.id || ent.name;
        const name = manifest.name || ent.name;
        if (pluginState.enabled[id] === undefined) {
          pluginState.enabled[id] = true;
        }
        const sigInfo = await getOrVerifySignature(pluginRoot, id);
        manifests.push({ ...manifest, id, name, signature: sigInfo });
      } catch {}
    }
    await saveState();
    return manifests;
  } catch {
    return [];
  }
}

export type PluginBundle = {
  manifest: PluginManifest;
  binaryPath: string | null;
  size: number;
};

export async function loadPluginBundle(
  pluginRoot: string,
  pluginId: string,
  ensureExtracted: (pluginId: string) => Promise<void>,
  clientOS?: string,
  clientArch?: string,
): Promise<PluginBundle> {
  await ensureExtracted(pluginId);
  const dir = path.join(pluginRoot, pluginId);
  const manifestPath = path.join(dir, "manifest.json");
  const rawManifest = await fs.readFile(manifestPath, "utf-8");
  const manifest = JSON.parse(rawManifest) as PluginManifest;
  manifest.id = manifest.id || pluginId;
  manifest.name = manifest.name || pluginId;

  const hasBinaries = manifest.binaries && Object.keys(manifest.binaries).length > 0;
  if (!hasBinaries) {
    return { manifest, binaryPath: null, size: 0 };
  }

  let binaryPath: string | null = null;

  if (manifest.binaries && clientOS && clientArch) {
    const key = `${clientOS}-${clientArch}`;
    const filename = manifest.binaries[key];
    if (filename) {
      const candidate = path.join(dir, filename);
      try {
        await fs.access(candidate);
        binaryPath = candidate;
      } catch {}
    }
  }

  if (!binaryPath) {
    const platformKey = clientOS && clientArch ? `${clientOS}-${clientArch}` : "unknown";
    const files = await fs.readdir(dir);
    const archRegex = /-(linux|darwin|windows|freebsd)-(amd64|arm64|arm|386)\.(so|dll|dylib)$/i;

    const found = files.find((f) => {
      const m = f.match(archRegex);
      if (m) {
        return (
          m[1].toLowerCase() === (clientOS || "").toLowerCase() &&
          m[2].toLowerCase() === (clientArch || "").toLowerCase()
        );
      }
      const fl = f.toLowerCase();
      return fl.endsWith(".so") || fl.endsWith(".dll") || fl.endsWith(".dylib");
    });
    if (!found) {
      throw new Error(
        `No compatible plugin binary for ${pluginId} (client=${platformKey}, available=[${Object.keys(manifest.binaries || {}).join(", ")}])`,
      );
    }
    binaryPath = path.join(dir, found);
  }

  const stat = await fs.stat(binaryPath);
  return { manifest, binaryPath, size: stat.size };
}

export type PluginPull = {
  id: string;
  clientId: string;
  pluginId: string;
  binaryPath: string;
  size: number;
  expiresAt: number;
  timeout: ReturnType<typeof setTimeout>;
};

const PLUGIN_PULL_TTL_MS = 5 * 60_000;
const pluginPulls = new Map<string, PluginPull>();

export function getPluginPull(id: string): PluginPull | undefined {
  return pluginPulls.get(id);
}

export function deletePluginPull(id: string): void {
  const pull = pluginPulls.get(id);
  if (!pull) return;
  pluginPulls.delete(id);
  clearTimeout(pull.timeout);
}

export function sendPluginBundle(
  target: ClientInfo,
  bundle: PluginBundle,
): void {
  if (!bundle.binaryPath) return;

  const pullId = uuidv4();
  const expiresAt = Date.now() + PLUGIN_PULL_TTL_MS;
  const timeout = setTimeout(() => {
    pluginPulls.delete(pullId);
  }, PLUGIN_PULL_TTL_MS);

  pluginPulls.set(pullId, {
    id: pullId,
    clientId: target.id,
    pluginId: bundle.manifest.id,
    binaryPath: bundle.binaryPath,
    size: bundle.size,
    expiresAt,
    timeout,
  });

  target.ws.send(
    encodeMessage({
      type: "command",
      commandType: "plugin_load_http",
      id: uuidv4(),
      payload: {
        manifest: bundle.manifest,
        size: bundle.size,
        url: `/api/plugins/pull/${encodeURIComponent(pullId)}`,
      },
    }),
  );
}

export async function dispatchAutoLoadPlugins(
  client: ClientInfo,
  pluginState: PluginState,
  isPluginLoaded: (clientId: string, pluginId: string) => boolean,
  isPluginLoading: (clientId: string, pluginId: string) => boolean,
  markPluginLoading: (clientId: string, pluginId: string) => void,
  enqueuePluginEvent: (clientId: string, pluginId: string, event: string, payload: any) => void,
  loadBundle: (pluginId: string, clientOS?: string, clientArch?: string) => Promise<PluginBundle>,
): Promise<void> {
  const autoLoadIds = Object.entries(pluginState.autoLoad)
    .filter(([id, enabled]) => enabled && pluginState.enabled[id] !== false)
    .map(([id]) => id);

  for (const pluginId of autoLoadIds) {
    if (isPluginLoaded(client.id, pluginId) || isPluginLoading(client.id, pluginId)) {
      continue;
    }

    try {
      const bundle = await loadBundle(pluginId, client.os, client.arch);
      markPluginLoading(client.id, pluginId);
      sendPluginBundle(client, bundle);

      const autoEvents = pluginState.autoStartEvents[pluginId];
      if (autoEvents && autoEvents.length > 0) {
        for (const evt of autoEvents) {
          enqueuePluginEvent(client.id, pluginId, evt.event, evt.payload);
        }
      }

      logger.info(`[plugin-autoload] dispatched ${pluginId} to ${client.id}`);
    } catch (err) {
      logger.warn(`[plugin-autoload] failed to load ${pluginId} for ${client.id}: ${(err as Error).message}`);
    }
  }
}

export function detectPluginIdFromZip(zip: AdmZip): string | null {
  const entries = zip.getEntries();
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const base = path.basename(entry.entryName);
    if (base.toLowerCase().endsWith(".html")) {
      return base.slice(0, -5);
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const base = path.basename(entry.entryName);
    if (base.toLowerCase() === "config.json") {
      try {
        const cfg = JSON.parse(entry.getData().toString("utf-8"));
        if (typeof cfg?.id === "string" && cfg.id.length > 0) return cfg.id;
      } catch {}
      break;
    }
  }
  return null;
}

function derivePlatformKey(filename: string): string {
  const match = filename.match(/-(linux|darwin|windows|freebsd)-(amd64|arm64|arm|386)\.(so|dll|dylib)$/i);
  if (match) {
    return `${match[1].toLowerCase()}-${match[2].toLowerCase()}`;
  }
  const lower = filename.toLowerCase();
  if (lower.endsWith(".dll")) return "windows-amd64";
  if (lower.endsWith(".dylib")) return "darwin-amd64";
  if (lower.endsWith(".so")) return "linux-amd64";
  return "";
}
