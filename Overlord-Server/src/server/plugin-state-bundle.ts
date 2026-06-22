import fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";
import { v4 as uuidv4 } from "uuid";
import type { ClientInfo } from "../types";
import type { PluginFileNeed, PluginManifest, PluginNeeds, PluginSignatureInfo } from "../protocol";

export type PluginState = {
  enabled: Record<string, boolean>;
  lastError: Record<string, string>;
  autoLoad: Record<string, boolean>;
  autoStartEvents: Record<string, Array<{ event: string; payload: any }>>;
  approvedNeeds: Record<string, string>;
};

const FILE_BUCKETS = new Set(["home", "desktop", "documents", "downloads", "temp", "appData", "pluginData", "fullDisk"]);
const FILE_ACCESS = new Set(["read", "write", "list", "delete", "mkdir"]);

export async function loadPluginStateFromDisk(pluginStatePath: string): Promise<PluginState> {
  try {
    const raw = await fs.readFile(pluginStatePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<PluginState>;
    return {
      enabled: parsed.enabled || {},
      lastError: parsed.lastError || {},
      autoLoad: parsed.autoLoad || {},
      autoStartEvents: parsed.autoStartEvents || {},
      approvedNeeds: parsed.approvedNeeds || {},
    };
  } catch {
    return { enabled: {}, lastError: {}, autoLoad: {}, autoStartEvents: {}, approvedNeeds: {} };
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

  const AdmZip = await loadAdmZip();
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
  let wasmEntry: { filename: string; data: Buffer } | null = null;
  const sourceEntries: Map<string, Buffer> = new Map();
  const nativeBinaries: Map<string, Buffer> = new Map();

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const normalizedEntry = normalizeBundlePath(entry.entryName);
    const base = path.basename(entry.entryName);
    const lower = base.toLowerCase();
    if (lower.endsWith(".so") || lower.endsWith(".dll") || lower.endsWith(".dylib")) {
      nativeBinaries.set(base, entry.getData());
    } else if (lower.endsWith(".wasm")) {
      wasmEntry = { filename: base, data: entry.getData() };
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
    if (normalizedEntry && isPluginSourcePath(normalizedEntry)) {
      sourceEntries.set(normalizedEntry, entry.getData());
    }
  }

  let extraConfig: any = {};
  if (configEntry) {
    try {
      extraConfig = JSON.parse(configEntry.toString("utf-8"));
    } catch (err) {
      warnPlugin(`[plugin] invalid config.json in bundle ${safeId}, ignoring: ${err}`);
    }
  }

  const uiTsEntry = getConfiguredSourceEntry(extraConfig, ["uiEntry", "ui.entry", "build.ui", "build.uiEntry"], sourceEntries)
    || (sourceEntries.has("src/ui.ts") ? "src/ui.ts" : "")
    || (sourceEntries.has("src/index.ts") ? "src/index.ts" : "");
  const serverTsEntry = getConfiguredSourceEntry(extraConfig, ["serverEntry", "server.entry", "build.server", "build.serverEntry"], sourceEntries)
    || (sourceEntries.has("src/server.ts") ? "src/server.ts" : "");

  if (!htmlEntry || !cssEntry || (!jsEntry && !uiTsEntry)) {
    throw new Error(`Invalid plugin bundle: ${safeId} (missing .html, .css, and either .js or src/ui.ts)`);
  }

  const binariesMap: Record<string, string> = {};
  for (const [filename, data] of nativeBinaries) {
    await fs.writeFile(path.join(pluginDir, filename), data);
    const platformKey = derivePlatformKey(filename);
    if (platformKey) {
      binariesMap[platformKey] = filename;
    }
  }
  if (wasmEntry) {
    await fs.writeFile(path.join(pluginDir, wasmEntry.filename), wasmEntry.data);
    binariesMap["wasm32-wasi"] = wasmEntry.filename;
  }

  if (sourceEntries.size > 0) {
    await fs.rm(path.join(pluginDir, "src"), { recursive: true, force: true });
    for (const [relPath, data] of sourceEntries) {
      const target = resolveInside(pluginDir, relPath);
      if (!target) {
        throw new Error(`Invalid plugin bundle: ${safeId} (unsafe source path)`);
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, data);
    }
  }

  await fs.writeFile(path.join(assetsDir, `${safeId}.html`), htmlEntry);
  await fs.writeFile(path.join(assetsDir, `${safeId}.css`), cssEntry);
  if (uiTsEntry) {
    await compilePluginTypeScript(path.join(pluginDir, uiTsEntry), path.join(assetsDir, `${safeId}.js`), "browser", safeId);
  } else if (jsEntry) {
    await fs.writeFile(path.join(assetsDir, `${safeId}.js`), jsEntry);
  }

  const serverScriptPath = path.join(pluginDir, "server.js");
  if (serverTsEntry) {
    await compilePluginTypeScript(path.join(pluginDir, serverTsEntry), serverScriptPath, "bun", safeId);
  } else if (serverEntry) {
    await fs.writeFile(serverScriptPath, serverEntry);
  } else {
    // A previous extraction may have left a stale server.js — drop it so the
    // runtime accurately reflects the current bundle.
    try { await fs.rm(serverScriptPath, { force: true }); } catch {}
  }

  const runtime = normalizePluginRuntime(extraConfig.runtime, wasmEntry !== null);
  const needs = normalizePluginNeeds(extraConfig.needs);
  const manifest: PluginManifest = {
    id: safeId,
    name: extraConfig.name || safeId,
    apiVersion: Number(extraConfig.apiVersion) === 2 || runtime === "wasm" ? 2 : 1,
    runtime,
    version: extraConfig.version || "1.0.0",
    description: extraConfig.description,
    ...(runtime === "wasm" && { wasm: String(extraConfig.wasm || wasmEntry?.filename || binariesMap["wasm32-wasi"] || "") }),
    ...(needs && { needs }),
    binaries: binariesMap,
    entry: `${safeId}.html`,
    assets: {
      html: `${safeId}.html`,
      css: `${safeId}.css`,
      js: `${safeId}.js`,
    },
    ...(extraConfig.navbar && { navbar: extraConfig.navbar }),
    hasServer: serverEntry !== null || !!serverTsEntry,
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  try {
    const { verifyPluginSignature } = await import("./plugin-signature");
    const sigInfo = await verifyPluginSignature(zipPath);
    const sigInfoPath = path.join(pluginDir, "signature-info.json");
    await fs.writeFile(sigInfoPath, JSON.stringify(sigInfo, null, 2));
  } catch (err) {
    warnPlugin(`[plugin] failed to verify signature for ${safeId}: ${(err as Error).message}`);
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
        warnPlugin(`[plugin] failed to extract ${pluginId}: ${(err as Error).message}`);
      }
    }
  }
}

export type PluginManifestWithSignature = PluginManifest & {
  signature?: PluginSignatureInfo;
  needsHash?: string;
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
        const { getOrVerifySignature } = await import("./plugin-signature");
        const sigInfo = await getOrVerifySignature(pluginRoot, id);
        manifests.push({ ...manifest, id, name, signature: sigInfo, needsHash: computePluginNeedsHash(manifest.needs) });
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

  if (manifest.runtime === "wasm" || manifest.wasm || manifest.binaries?.["wasm32-wasi"]) {
    const wasmName = manifest.wasm || manifest.binaries?.["wasm32-wasi"];
    if (!wasmName) {
      throw new Error(`No WASM module configured for ${pluginId}`);
    }
    const binaryPath = path.join(dir, wasmName);
    const stat = await fs.stat(binaryPath);
    return { manifest: { ...manifest, runtime: "wasm", apiVersion: 2 }, binaryPath, size: stat.size };
  }

  manifest.runtime = manifest.runtime || "native";
  manifest.apiVersion = manifest.apiVersion || 1;

  const hasBinaries = manifest.binaries && Object.keys(manifest.binaries).length > 0;
  if (!hasBinaries) {
    return { manifest, binaryPath: null, size: 0 };
  }

  let binaryPath: string | null = null;

  if (manifest.binaries && clientOS && clientArch) {
    const filename = getPluginBinaryCandidateKeys(clientOS, clientArch)
      .map((key) => manifest.binaries?.[key])
      .find((name): name is string => typeof name === "string" && name.length > 0);
    if (filename) {
      const candidate = path.join(dir, filename);
      try {
        await fs.access(candidate);
        binaryPath = candidate;
      } catch {}
    }
  }

  if (!binaryPath) {
    const platformKey = clientOS && clientArch ? formatPluginPlatformKey(clientOS, clientArch) : "unknown";
    const normalizedOS = normalizePluginOS(clientOS);
    const normalizedArch = normalizePluginArch(clientArch);
    const files = await fs.readdir(dir);
    const archRegex = /-(linux|darwin|windows|freebsd)-(amd64|arm64|arm|386)\.(so|dll|dylib)$/i;

    const found = files.find((f) => {
      const m = f.match(archRegex);
      if (m) {
        return (
          m[1].toLowerCase() === normalizedOS &&
          m[2].toLowerCase() === normalizedArch
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

function getPluginBinaryCandidateKeys(clientOS?: string, clientArch?: string): string[] {
  if (!clientOS || !clientArch) return [];
  const rawKey = `${clientOS}-${clientArch}`.toLowerCase();
  const normalizedKey = formatPluginPlatformKey(clientOS, clientArch);
  return Array.from(
    new Set([normalizedKey, rawKey].filter((key) => !key.startsWith("unknown-") && !key.endsWith("-unknown"))),
  );
}

function formatPluginPlatformKey(clientOS?: string, clientArch?: string): string {
  return `${normalizePluginOS(clientOS)}-${normalizePluginArch(clientArch)}`;
}

function normalizePluginOS(value?: string): string {
  const os = (value || "").trim().toLowerCase();
  if (!os) return "unknown";
  if (os.includes("windows") || os === "win32") return "windows";
  if (os.includes("mac os") || os.includes("macos") || os.includes("os x") || os === "darwin") return "darwin";
  if (os.includes("linux")) return "linux";
  if (os.includes("freebsd")) return "freebsd";
  return os;
}

function normalizePluginArch(value?: string): string {
  const arch = (value || "").trim().toLowerCase();
  if (!arch) return "unknown";
  if (arch === "x64" || arch === "x86_64") return "amd64";
  if (arch === "ia32" || arch === "i386" || arch === "x86") return "386";
  if (arch === "aarch64") return "arm64";
  if (arch === "armv7" || arch === "armv6") return "arm";
  return arch;
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
  const { encodeMessage } = require("../protocol");

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
  needsApproved: (pluginId: string) => Promise<boolean> = async () => true,
): Promise<void> {
  const autoLoadIds = Object.entries(pluginState.autoLoad)
    .filter(([id, enabled]) => enabled && pluginState.enabled[id] !== false)
    .map(([id]) => id);

  for (const pluginId of autoLoadIds) {
    if (isPluginLoaded(client.id, pluginId) || isPluginLoading(client.id, pluginId)) {
      continue;
    }

    try {
      if (!(await needsApproved(pluginId))) {
        warnPlugin(`[plugin-autoload] skipped ${pluginId} for ${client.id}: plugin needs approval`);
        continue;
      }
      const bundle = await loadBundle(pluginId, client.os, client.arch);
      markPluginLoading(client.id, pluginId);
      sendPluginBundle(client, bundle);

      const autoEvents = pluginState.autoStartEvents[pluginId];
      if (autoEvents && autoEvents.length > 0) {
        for (const evt of autoEvents) {
          enqueuePluginEvent(client.id, pluginId, evt.event, evt.payload);
        }
      }

      infoPlugin(`[plugin-autoload] dispatched ${pluginId} to ${client.id}`);
    } catch (err) {
      warnPlugin(`[plugin-autoload] failed to load ${pluginId} for ${client.id}: ${(err as Error).message}`);
    }
  }
}

function warnPlugin(message: string): void {
  console.warn(message);
}

function infoPlugin(message: string): void {
  console.log(message);
}

function normalizeBundlePath(entryName: string): string | null {
  if (!entryName || entryName.includes("\0")) return null;
  const normalized = entryName.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) return null;
  return parts.join("/");
}

function isPluginSourcePath(relPath: string): boolean {
  if (!relPath.startsWith("src/")) return false;
  const lower = relPath.toLowerCase();
  return (
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".js") ||
    lower.endsWith(".jsx") ||
    lower.endsWith(".json") ||
    lower.endsWith(".d.ts")
  );
}

function resolveInside(root: string, relPath: string): string | null {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, relPath);
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(prefix)) return null;
  return resolvedTarget;
}

function getConfiguredSourceEntry(config: any, candidates: string[], sourceEntries: Map<string, Buffer>): string {
  for (const candidate of candidates) {
    const value = getPathValue(config, candidate);
    if (typeof value !== "string") continue;
    const normalized = normalizeBundlePath(value);
    if (!normalized || !isPluginSourcePath(normalized)) continue;
    if (!sourceEntries.has(normalized)) {
      throw new Error(`Configured TypeScript entry not found: ${normalized}`);
    }
    return normalized;
  }
  return "";
}

function getPathValue(obj: any, dotted: string): unknown {
  let cur = obj;
  for (const part of dotted.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

export async function compilePluginTypeScript(entryPath: string, outFile: string, target: "browser" | "bun", pluginId: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [entryPath],
    target,
    format: "esm",
    minify: false,
    sourcemap: "none",
    write: false,
  });
  if (!result.success) {
    const logs = result.logs.map((log) => log.message).join("; ");
    throw new Error(`TypeScript build failed for ${pluginId}: ${logs || "unknown error"}`);
  }
  const output = result.outputs.find((out) => out.path.endsWith(".js")) || result.outputs[0];
  if (!output) {
    throw new Error(`TypeScript build failed for ${pluginId}: no JavaScript output`);
  }
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, await output.text());
}

export function computePluginNeedsHash(needs: PluginNeeds | undefined): string {
  const normalized = normalizePluginNeeds(needs);
  if (!normalized || !normalized.files || normalized.files.length === 0) return "";
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function arePluginNeedsApproved(pluginState: PluginState, pluginId: string, needs: PluginNeeds | undefined): boolean {
  const hash = computePluginNeedsHash(needs);
  return !hash || pluginState.approvedNeeds[pluginId] === hash;
}

export function normalizePluginNeeds(raw: any): PluginNeeds | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const filesRaw = Array.isArray(raw.files) ? raw.files : [];
  const files: PluginFileNeed[] = [];
  for (const item of filesRaw) {
    if (!item || typeof item !== "object") continue;
    const bucket = typeof item.bucket === "string" ? item.bucket.trim() : "";
    if (!FILE_BUCKETS.has(bucket)) continue;
    const accessRaw = Array.isArray(item.access) ? item.access : [];
    const access = Array.from(new Set(accessRaw.filter((a: any) => typeof a === "string" && FILE_ACCESS.has(a))));
    if (access.length === 0) continue;
    files.push({
      bucket,
      access: access.sort(),
      ...(typeof item.reason === "string" && item.reason.trim() ? { reason: item.reason.trim().slice(0, 500) } : {}),
    });
  }
  files.sort((a, b) => `${a.bucket}:${a.access.join(",")}`.localeCompare(`${b.bucket}:${b.access.join(",")}`));
  return files.length > 0 ? { files } : undefined;
}

function normalizePluginRuntime(runtime: any, hasWasm: boolean): "native" | "wasm" | "server" {
  const value = typeof runtime === "string" ? runtime.trim().toLowerCase() : "";
  if (value === "wasm" || hasWasm) return "wasm";
  if (value === "server") return "server";
  return "native";
}

export function detectPluginIdFromZip(zip: any): string | null {
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

async function loadAdmZip(): Promise<any> {
  try {
    return require("adm-zip");
  } catch {
    return require(path.join(process.cwd(), "node_modules", "adm-zip", "adm-zip.js"));
  }
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
