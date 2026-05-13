import fs from "fs/promises";
import { constants as fsConstants } from "fs";
import path from "path";
import AdmZip from "adm-zip";
import { v4 as uuidv4 } from "uuid";
import { authenticateRequest } from "../../auth";
import { requirePermission } from "../../rbac";
import { canUserAccessClient, canUserAccessPlugin } from "../../users";
import * as clientManager from "../../clientManager";
import { metrics } from "../../metrics";
import { encodeMessage, type PluginSignatureInfo } from "../../protocol";
import { getConfig, updatePluginsConfig } from "../../config";
import { getOrVerifySignature, BUILTIN_TRUSTED_KEYS } from "../plugin-signature";
import type { PluginRuntime } from "../plugin-runtime/runtime";
import { getPluginPull, deletePluginPull, detectPluginIdFromZip } from "../plugin-state-bundle";
import { isAuthorizedAgentRequest } from "../agent-auth";
import { logger } from "../../logger";

type PluginManifest = {
  id: string;
  name: string;
  signature?: PluginSignatureInfo;
  hasServer?: boolean;
};

type PluginBundle = {
  manifest: PluginManifest;
  binaryPath: string | null;
  size: number;
};

type PluginState = {
  enabled: Record<string, boolean>;
  lastError: Record<string, string>;
  autoLoad: Record<string, boolean>;
  autoStartEvents: Record<string, Array<{ event: string; payload: any }>>;
};

type PluginRouteDeps = {
  PLUGIN_ROOT: string;
  PUBLIC_ROOT: string;
  pluginState: PluginState;
  pluginLoadedByClient: Map<string, Set<string>>;
  pluginLoadingByClient: Map<string, Set<string>>;
  pendingPluginEvents: Map<string, Array<{ event: string; payload: any }>>;
  sanitizePluginId: (name: string) => string;
  ensurePluginExtracted: (pluginId: string) => Promise<void>;
  savePluginState: () => Promise<void>;
  listPluginManifests: () => Promise<PluginManifest[]>;
  loadPluginBundle: (pluginId: string, clientOS?: string, clientArch?: string) => Promise<PluginBundle>;
  sendPluginBundle: (target: any, bundle: PluginBundle) => void;
  markPluginLoading: (clientId: string, pluginId: string) => void;
  isPluginLoaded: (clientId: string, pluginId: string) => boolean;
  isPluginLoading: (clientId: string, pluginId: string) => boolean;
  enqueuePluginEvent: (clientId: string, pluginId: string, event: string, payload: any) => void;
  drainPluginUIEvents: (clientId: string, pluginId: string) => Array<{ event: string; payload: any }>;
  secureHeaders: (contentType?: string) => Record<string, string>;
  mimeType: (path: string) => string;
  pluginRuntime: PluginRuntime;
};

export async function handlePluginRoutes(
  req: Request,
  url: URL,
  deps: PluginRouteDeps,
): Promise<Response | null> {
  if (
    !url.pathname.startsWith("/api/plugins") &&
    !url.pathname.startsWith("/plugins/") &&
    !url.pathname.match(/^\/api\/clients\/.+\/plugins/)
  ) {
    return null;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/plugins/pull/")) {
    const agentToken = getConfig().auth.agentToken;
    if (!isAuthorizedAgentRequest(req, url, agentToken)) {
      return new Response("Unauthorized", { status: 401 });
    }

    let pullId = "";
    try {
      pullId = decodeURIComponent(url.pathname.slice("/api/plugins/pull/".length));
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pullId)) {
      return new Response("Bad request", { status: 400 });
    }

    const pull = getPluginPull(pullId);
    if (!pull || pull.expiresAt < Date.now()) {
      return new Response("Not found", { status: 404 });
    }
    const requesterClientId = req.headers.get("x-overlord-client-id") || "";
    if (!requesterClientId || requesterClientId !== pull.clientId) {
      return new Response("Forbidden", { status: 403 });
    }

    deletePluginPull(pullId);

    logger.debug("[plugin] http pull", {
      pullId,
      clientId: pull.clientId,
      pluginId: pull.pluginId,
      bytes: pull.size,
    });

    const headers = {
      ...deps.secureHeaders("application/octet-stream"),
      "Cache-Control": "no-store, private",
      "Content-Length": String(pull.size),
    };
    return new Response(Bun.file(pull.binaryPath).stream(), { headers });
  }

  async function serveLoginOrUnauthorized(): Promise<Response> {
    const loginFile = Bun.file(`${deps.PUBLIC_ROOT}/login.html`);
    if (await loginFile.exists()) {
      return new Response(loginFile, { headers: deps.secureHeaders(deps.mimeType("/login.html")) });
    }
    return new Response("Unauthorized", { status: 401 });
  }

  if (req.method === "GET" && url.pathname === "/api/plugins") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    const plugins = await deps.listPluginManifests();
    const enriched = plugins
      .filter((p) => canUserAccessPlugin(user.userId, user.role, p.id))
      .map((p) => ({
        ...p,
        enabled: deps.pluginState.enabled[p.id] !== false,
        lastError: deps.pluginState.lastError[p.id] || "",
        autoLoad: deps.pluginState.autoLoad[p.id] === true,
        autoStartEvents: deps.pluginState.autoStartEvents[p.id] || [],
        signature: p.signature || { signed: false, trusted: false, valid: false },
        hasServer: p.hasServer === true || deps.pluginRuntime.hasServerCode(p.id),
        serverRunning: deps.pluginRuntime.isRunning(p.id),
      }));
    return Response.json({ plugins: enriched });
  }

  if (req.method === "GET" && url.pathname === "/api/plugins/trusted-keys") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    if (user.role !== "admin") {
      return new Response("Forbidden: Admin access required", { status: 403 });
    }
    const config = getConfig();
    const allKeys = Array.from(new Set([...BUILTIN_TRUSTED_KEYS, ...config.plugins.trustedKeys]));
    return Response.json({ trustedKeys: allKeys, builtinKeys: BUILTIN_TRUSTED_KEYS });
  }

  if (req.method === "POST" && url.pathname === "/api/plugins/trusted-keys") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    if (user.role !== "admin") {
      return new Response("Forbidden: Admin access required", { status: 403 });
    }
    let body: any = {};
    try { body = await req.json(); } catch {}
    const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint.trim().toLowerCase() : "";
    if (!fingerprint || !/^[a-f0-9]{64}$/.test(fingerprint)) {
      return Response.json({ ok: false, error: "Invalid fingerprint (expected 64-char hex SHA-256)" }, { status: 400 });
    }
    const config = getConfig();
    const keys = [...config.plugins.trustedKeys];
    if (!keys.includes(fingerprint)) {
      keys.push(fingerprint);
      await updatePluginsConfig({ trustedKeys: keys });
    }
    return Response.json({ ok: true, trustedKeys: keys });
  }

  const trustedKeyDeleteMatch = url.pathname.match(/^\/api\/plugins\/trusted-keys\/([a-f0-9]{64})$/);
  if (req.method === "DELETE" && trustedKeyDeleteMatch) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    if (user.role !== "admin") {
      return new Response("Forbidden: Admin access required", { status: 403 });
    }
    const fingerprint = trustedKeyDeleteMatch[1].toLowerCase();
    const config = getConfig();
    const keys = config.plugins.trustedKeys.filter((k) => k.toLowerCase() !== fingerprint);
    await updatePluginsConfig({ trustedKeys: keys });
    return Response.json({ ok: true, trustedKeys: keys });
  }

  const clientPluginsMatch = url.pathname.match(/^\/api\/clients\/(.+)\/plugins$/);
  if (req.method === "GET" && clientPluginsMatch) {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    try {
      requirePermission(user, "clients:control");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    const clientId = clientPluginsMatch[1];
    if (!canUserAccessClient(user.userId, user.role, clientId)) {
      return new Response("Forbidden: You do not have access to this client", { status: 403 });
    }
    const loaded = deps.pluginLoadedByClient.get(clientId) || new Set<string>();
    const manifests = await deps.listPluginManifests();
    const plugins = manifests
      .filter((manifest) => canUserAccessPlugin(user.userId, user.role, manifest.id))
      .map((manifest) => ({
        id: manifest.id,
        name: manifest.name || manifest.id,
        loaded: loaded.has(manifest.id),
        enabled: deps.pluginState.enabled[manifest.id] !== false,
        lastError: deps.pluginState.lastError[manifest.id] || "",
        signature: manifest.signature || { signed: false, trusted: false, valid: false },
      }));
    return Response.json({ plugins });
  }

  if (req.method === "POST" && url.pathname === "/api/plugins/upload") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (user.role !== "admin" && user.role !== "operator") {
      return new Response("Forbidden: Admin or operator access required", { status: 403 });
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    const file = form.get("file");
    if (!(file instanceof File)) {
      return new Response("Missing file", { status: 400 });
    }

    const filename = file.name || "plugin.zip";
    if (!filename.toLowerCase().endsWith(".zip")) {
      return new Response("Only .zip files are supported", { status: 400 });
    }

    const MAX_PLUGIN_ZIP_BYTES = 50 * 1024 * 1024; // 50 MB compressed
    const MAX_PLUGIN_UNCOMPRESSED_BYTES = 200 * 1024 * 1024; // 200 MB total uncompressed
    if (typeof file.size === "number" && file.size > MAX_PLUGIN_ZIP_BYTES) {
      return new Response("Plugin zip exceeds size limit", { status: 413 });
    }

    const data = new Uint8Array(await file.arrayBuffer());
    if (data.byteLength > MAX_PLUGIN_ZIP_BYTES) {
      return new Response("Plugin zip exceeds size limit", { status: 413 });
    }

    let probe: AdmZip;
    try {
      probe = new AdmZip(Buffer.from(data));
      let totalUncompressed = 0;
      for (const entry of probe.getEntries() as any[]) {
        const sz = Number(entry?.header?.size ?? 0);
        if (!Number.isFinite(sz) || sz < 0) {
          return new Response("Invalid plugin zip", { status: 400 });
        }
        totalUncompressed += sz;
        if (totalUncompressed > MAX_PLUGIN_UNCOMPRESSED_BYTES) {
          return new Response("Plugin uncompressed size exceeds limit", { status: 413 });
        }
      }
    } catch {
      return new Response("Invalid plugin zip", { status: 400 });
    }

    const internalId = detectPluginIdFromZip(probe);
    const idCandidate = internalId || path.basename(filename, path.extname(filename));
    let pluginId = "";
    try {
      pluginId = deps.sanitizePluginId(idCandidate);
    } catch {
      return new Response("Invalid plugin name", { status: 400 });
    }

    await fs.mkdir(deps.PLUGIN_ROOT, { recursive: true });
    const zipPath = path.join(deps.PLUGIN_ROOT, `${pluginId}.zip`);
    await fs.writeFile(zipPath, data);

    try {
      await deps.ensurePluginExtracted(pluginId);
    } catch (err) {
      return Response.json({ ok: false, error: (err as Error).message }, { status: 400 });
    }

    const sigInfo = await getOrVerifySignature(deps.PLUGIN_ROOT, pluginId);

    if (deps.pluginState.enabled[pluginId] === undefined) {
      deps.pluginState.enabled[pluginId] = sigInfo.trusted === true;
      await deps.savePluginState();
    }

    // Re-extracting the bundle may have replaced server.js, so cycle the
    // runtime if the plugin is enabled.
    if (deps.pluginState.enabled[pluginId] !== false && deps.pluginRuntime.hasServerCode(pluginId)) {
      try {
        await deps.pluginRuntime.restartPlugin(pluginId);
      } catch {}
    } else if (deps.pluginRuntime.isRunning(pluginId)) {
      await deps.pluginRuntime.stopPlugin(pluginId);
    }

    return Response.json({ ok: true, id: pluginId, enabled: deps.pluginState.enabled[pluginId], signature: sigInfo });
  }

  const pluginEnableMatch = url.pathname.match(/^\/api\/plugins\/(.+)\/enable$/);
  if (req.method === "POST" && pluginEnableMatch) {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (user.role !== "admin" && user.role !== "operator") {
      return new Response("Forbidden: Admin or operator access required", { status: 403 });
    }
    let pluginId = "";
    try {
      pluginId = deps.sanitizePluginId(pluginEnableMatch[1]);
    } catch {
      return new Response("Invalid plugin id", { status: 400 });
    }
    let body: any = {};
    try {
      body = await req.json();
    } catch {}
    const enabled = !!body.enabled;

    if (enabled) {
      const sigInfo = await getOrVerifySignature(deps.PLUGIN_ROOT, pluginId);
      if (!sigInfo.trusted) {
        if (body.confirmed !== true) {
          return Response.json(
            { ok: false, error: "confirmation_required", signature: sigInfo },
            { status: 428 },
          );
        }
      }
    }

    deps.pluginState.enabled[pluginId] = enabled;
    await deps.savePluginState();

    if (enabled) {
      if (deps.pluginRuntime.hasServerCode(pluginId) && !deps.pluginRuntime.isRunning(pluginId)) {
        try { await deps.pluginRuntime.startPlugin(pluginId); } catch {}
      }
    } else if (deps.pluginRuntime.isRunning(pluginId)) {
      await deps.pluginRuntime.stopPlugin(pluginId);
    }

    return Response.json({ ok: true, id: pluginId, enabled });
  }

  const pluginAutoLoadMatch = url.pathname.match(/^\/api\/plugins\/(.+)\/autoload$/);
  if (req.method === "POST" && pluginAutoLoadMatch) {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (user.role !== "admin") {
      return new Response("Forbidden: Admin access required", { status: 403 });
    }
    let pluginId = "";
    try {
      pluginId = deps.sanitizePluginId(pluginAutoLoadMatch[1]);
    } catch {
      return new Response("Invalid plugin id", { status: 400 });
    }
    let body: any = {};
    try {
      body = await req.json();
    } catch {}
    const autoLoad = !!body.autoLoad;

    if (autoLoad && deps.pluginState.enabled[pluginId] === false) {
      return Response.json(
        { ok: false, error: "Plugin must be enabled before auto-load can be turned on" },
        { status: 400 },
      );
    }

    deps.pluginState.autoLoad[pluginId] = autoLoad;

    if (Array.isArray(body.autoStartEvents)) {
      const validEvents = body.autoStartEvents.filter(
        (e: any) => e && typeof e.event === "string" && e.event.length > 0,
      );
      deps.pluginState.autoStartEvents[pluginId] = validEvents;
    }

    await deps.savePluginState();

    if (autoLoad) {
      const allClients = clientManager.getAllClients();
      for (const [cid, client] of allClients) {
        if (deps.isPluginLoaded(cid, pluginId) || deps.isPluginLoading(cid, pluginId)) continue;
        try {
          const bundle = await deps.loadPluginBundle(pluginId, client.os, client.arch);
          deps.markPluginLoading(cid, pluginId);
          deps.sendPluginBundle(client, bundle);
          metrics.recordCommand("plugin_load");
        } catch {
        }
      }
    }

    return Response.json({
      ok: true,
      id: pluginId,
      autoLoad,
      autoStartEvents: deps.pluginState.autoStartEvents[pluginId] || [],
    });
  }

  function resolveDataPath(pluginId: string, relPath: string): string | null {
    const dataDir = path.join(deps.PLUGIN_ROOT, pluginId, "data");
    const target = path.resolve(dataDir, relPath);
    const prefix = dataDir.endsWith(path.sep) ? dataDir : `${dataDir}${path.sep}`;
    if (target !== dataDir && !target.startsWith(prefix)) return null;
    return target;
  }

  async function isPathSafe(target: string, dataDir: string): Promise<boolean> {
    const root = path.resolve(dataDir);
    let current = path.resolve(target);
    while (current !== root) {
      try {
        const st = await fs.lstat(current);
        if (st.isSymbolicLink()) return false;
      } catch {
      }
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
    try {
      const st = await fs.lstat(root);
      if (st.isSymbolicLink() || !st.isDirectory()) return false;
    } catch {
      return false;
    }
    return true;
  }

  const pluginDataListMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)\/data$/);
  if (req.method === "GET" && pluginDataListMatch) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try { requirePermission(user, "clients:control"); } catch (e) { if (e instanceof Response) return e; return new Response("Forbidden", { status: 403 }); }
    let pluginId = "";
    try { pluginId = deps.sanitizePluginId(pluginDataListMatch[1]); } catch { return new Response("Invalid plugin id", { status: 400 }); }
    if (!canUserAccessPlugin(user.userId, user.role, pluginId)) {
      return new Response("Forbidden: You do not have access to this plugin", { status: 403 });
    }
    const dataDir = path.join(deps.PLUGIN_ROOT, pluginId, "data");
    await fs.mkdir(dataDir, { recursive: true });
    async function walkDir(dir: string, base: string): Promise<{ path: string; size: number; isDir: boolean }[]> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const results: { path: string; size: number; isDir: boolean }[] = [];
      for (const ent of entries) {
        const rel = base ? `${base}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          results.push({ path: rel, size: 0, isDir: true });
          const sub = await walkDir(path.join(dir, ent.name), rel);
          results.push(...sub);
        } else {
          const st = await fs.stat(path.join(dir, ent.name)).catch(() => null);
          results.push({ path: rel, size: st?.size ?? 0, isDir: false });
        }
      }
      return results;
    }
    const files = await walkDir(dataDir, "");
    return Response.json({ ok: true, files });
  }

  const pluginDataReadMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)\/data\/(.+)$/);
  if (req.method === "GET" && pluginDataReadMatch) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try { requirePermission(user, "clients:control"); } catch (e) { if (e instanceof Response) return e; return new Response("Forbidden", { status: 403 }); }
    let pluginId = "";
    try { pluginId = deps.sanitizePluginId(pluginDataReadMatch[1]); } catch { return new Response("Invalid plugin id", { status: 400 }); }
    if (!canUserAccessPlugin(user.userId, user.role, pluginId)) {
      return new Response("Forbidden: You do not have access to this plugin", { status: 403 });
    }
    let relPath = pluginDataReadMatch[2];
    try { relPath = decodeURIComponent(relPath); } catch { return new Response("Bad request", { status: 400 }); }
    if (relPath.includes("\u0000")) return new Response("Bad request", { status: 400 });
    const target = resolveDataPath(pluginId, relPath);
    if (!target) return new Response("Forbidden", { status: 403 });
    const dataDir = path.join(deps.PLUGIN_ROOT, pluginId, "data");
    if (!(await isPathSafe(target, dataDir))) return new Response("Forbidden", { status: 403 });
    const file = Bun.file(target);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    const st = await fs.lstat(target);
    if (st.isDirectory()) return new Response("Is a directory", { status: 400 });
    if (st.isSymbolicLink()) return new Response("Forbidden", { status: 403 });
    return new Response(file, { headers: deps.secureHeaders(deps.mimeType(relPath)) });
  }

  const pluginDataWriteMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)\/data\/(.+)$/);
  if (req.method === "PUT" && pluginDataWriteMatch) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try { requirePermission(user, "clients:control"); } catch (e) { if (e instanceof Response) return e; return new Response("Forbidden", { status: 403 }); }
    let pluginId = "";
    try { pluginId = deps.sanitizePluginId(pluginDataWriteMatch[1]); } catch { return new Response("Invalid plugin id", { status: 400 }); }
    if (!canUserAccessPlugin(user.userId, user.role, pluginId)) {
      return new Response("Forbidden: You do not have access to this plugin", { status: 403 });
    }
    let relPath = pluginDataWriteMatch[2];
    try { relPath = decodeURIComponent(relPath); } catch { return new Response("Bad request", { status: 400 }); }
    if (relPath.includes("\u0000") || relPath.endsWith("/") || relPath.endsWith(path.sep)) {
      return new Response("Bad request", { status: 400 });
    }
    const target = resolveDataPath(pluginId, relPath);
    if (!target) return new Response("Forbidden", { status: 403 });
    const dataDir = path.join(deps.PLUGIN_ROOT, pluginId, "data");
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (!(await isPathSafe(target, dataDir))) return new Response("Forbidden", { status: 403 });
    const existingSt = await fs.lstat(target).catch(() => null);
    if (existingSt && existingSt.isSymbolicLink()) {
      return new Response("Forbidden", { status: 403 });
    }
    const body = await req.arrayBuffer();
    let fh: import("fs/promises").FileHandle | null = null;
    try {
      fh = await fs.open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW || 0));
      await fh.writeFile(new Uint8Array(body));
    } catch (err: any) {
      if (err && (err.code === "ELOOP" || err.code === "EISDIR")) {
        return new Response("Forbidden", { status: 403 });
      }
      throw err;
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
    return Response.json({ ok: true, path: relPath, size: body.byteLength });
  }

  const pluginDataDeleteMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)\/data\/(.+)$/);
  if (req.method === "DELETE" && pluginDataDeleteMatch) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try { requirePermission(user, "clients:control"); } catch (e) { if (e instanceof Response) return e; return new Response("Forbidden", { status: 403 }); }
    let pluginId = "";
    try { pluginId = deps.sanitizePluginId(pluginDataDeleteMatch[1]); } catch { return new Response("Invalid plugin id", { status: 400 }); }
    if (!canUserAccessPlugin(user.userId, user.role, pluginId)) {
      return new Response("Forbidden: You do not have access to this plugin", { status: 403 });
    }
    let relPath = pluginDataDeleteMatch[2];
    try { relPath = decodeURIComponent(relPath); } catch { return new Response("Bad request", { status: 400 }); }
    if (relPath.includes("\u0000")) return new Response("Bad request", { status: 400 });
    const target = resolveDataPath(pluginId, relPath);
    if (!target) return new Response("Forbidden", { status: 403 });
    const dataDir = path.join(deps.PLUGIN_ROOT, pluginId, "data");
    if (!(await isPathSafe(target, dataDir))) return new Response("Forbidden", { status: 403 });
    try {
      const st = await fs.lstat(target);
      if (st.isSymbolicLink()) {
        // Just unlink the link itself; never traverse it.
        await fs.unlink(target);
      } else if (st.isDirectory()) {
        await fs.rm(target, { recursive: true, force: true });
      } else {
        await fs.unlink(target);
      }
    } catch {
      return new Response("Not found", { status: 404 });
    }
    return Response.json({ ok: true, path: relPath });
  }

  // Execute a file stored in the plugin's data directory
  const pluginExecMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)\/exec$/);
  if (req.method === "POST" && pluginExecMatch) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    if (user.role !== "admin") {
      return new Response("Forbidden: Admin access required", { status: 403 });
    }
    let pluginId = "";
    try { pluginId = deps.sanitizePluginId(pluginExecMatch[1]); } catch { return new Response("Invalid plugin id", { status: 400 }); }
    if (!canUserAccessPlugin(user.userId, user.role, pluginId)) {
      return new Response("Forbidden: You do not have access to this plugin", { status: 403 });
    }
    let body: any = {};
    try { body = await req.json(); } catch { return new Response("Bad request", { status: 400 }); }
    const filePath = typeof body.file === "string" ? body.file : "";
    if (!filePath) return new Response("Missing file", { status: 400 });
    let decodedFile = filePath;
    try { decodedFile = decodeURIComponent(filePath); } catch { return new Response("Bad request", { status: 400 }); }
    if (decodedFile.includes("\u0000")) return new Response("Bad request", { status: 400 });
    const target = resolveDataPath(pluginId, decodedFile);
    if (!target) return new Response("Forbidden", { status: 403 });
    const dataDir = path.join(deps.PLUGIN_ROOT, pluginId, "data");
    if (!(await isPathSafe(target, dataDir))) return new Response("Forbidden", { status: 403 });
    try {
      const st = await fs.lstat(target);
      if (st.isSymbolicLink()) return new Response("Forbidden", { status: 403 });
      if (st.isDirectory()) return new Response("Is a directory", { status: 400 });
    } catch {
      return new Response("Not found", { status: 404 });
    }
    // Resolve via realpath to defeat any symlink raced into place after the lstat
    // above; re-verify the resolved path is still under the data dir.
    let realTarget: string;
    try {
      realTarget = await fs.realpath(target);
    } catch {
      return new Response("Forbidden", { status: 403 });
    }
    const dataDirPrefix = dataDir.endsWith(path.sep) ? dataDir : `${dataDir}${path.sep}`;
    if (realTarget !== dataDir && !realTarget.startsWith(dataDirPrefix)) {
      return new Response("Forbidden", { status: 403 });
    }
    const args: string[] = Array.isArray(body.args) ? body.args.filter((a: any) => typeof a === "string") : [];
    const stdinData: string = typeof body.stdin === "string" ? body.stdin : "";
    const timeoutMs: number = typeof body.timeoutMs === "number" && body.timeoutMs > 0 ? Math.min(body.timeoutMs, 60_000) : 30_000;
    // Ensure the binary is executable. chmod follows symlinks, but we've verified
    // the realpath stays inside dataDir, so this is safe.
    try { await fs.chmod(realTarget, 0o755); } catch {}
    const proc = Bun.spawn([realTarget, ...args], {
      cwd: path.dirname(realTarget),
      stdin: stdinData ? Buffer.from(stdinData) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const killTimer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    let exitCode = 0;
    try {
      exitCode = await proc.exited;
    } finally {
      clearTimeout(killTimer);
    }
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return Response.json({ ok: true, exitCode, stdout, stderr });
  }

  const pluginDeleteMatch = url.pathname.match(/^\/api\/plugins\/(.+)$/);
  if (req.method === "DELETE" && pluginDeleteMatch) {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (user.role !== "admin" && user.role !== "operator") {
      return new Response("Forbidden: Admin or operator access required", { status: 403 });
    }

    let pluginId = "";
    try {
      pluginId = deps.sanitizePluginId(pluginDeleteMatch[1]);
    } catch {
      return new Response("Invalid plugin id", { status: 400 });
    }

    const zipPath = path.join(deps.PLUGIN_ROOT, `${pluginId}.zip`);
    const pluginDir = path.join(deps.PLUGIN_ROOT, pluginId);

    try {
      await fs.rm(zipPath, { force: true });
    } catch {}

    // Remove everything except the data/ subdirectory so plugin-stored files survive reinstalls.
    if (pluginDir) {
      try {
        const entries = await fs.readdir(pluginDir, { withFileTypes: true });
        for (const ent of entries) {
          if (ent.name === "data") continue; // preserve plugin data directory
          await fs.rm(path.join(pluginDir, ent.name), { recursive: true, force: true });
        }
        // Remove the directory itself only if it is now empty
        const remaining = await fs.readdir(pluginDir);
        if (remaining.length === 0) await fs.rmdir(pluginDir);
      } catch {}
    }

    // Unload from all clients that have it loaded
    for (const [cid, loadedSet] of deps.pluginLoadedByClient) {
      if (!loadedSet.has(pluginId)) continue;
      const target = clientManager.getClient(cid);
      if (target) {
        try {
          target.ws.send(
            encodeMessage({
              type: "command",
              commandType: "plugin_unload",
              id: uuidv4(),
              payload: { pluginId },
            }),
          );
        } catch {}
      }
    }

    deps.pluginLoadedByClient.forEach((set) => set.delete(pluginId));
    deps.pluginLoadingByClient.forEach((set) => set.delete(pluginId));
    delete deps.pluginState.enabled[pluginId];
    delete deps.pluginState.lastError[pluginId];
    delete deps.pluginState.autoLoad[pluginId];
    delete deps.pluginState.autoStartEvents[pluginId];
    await deps.savePluginState();

    if (deps.pluginRuntime.isRunning(pluginId)) {
      await deps.pluginRuntime.stopPlugin(pluginId);
    }

    return Response.json({ ok: true, id: pluginId });
  }

  const pluginLoadMatch = url.pathname.match(/^\/api\/clients\/(.+)\/plugins\/(.+)\/load$/);
  if (req.method === "POST" && pluginLoadMatch) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try {
      requirePermission(user, "clients:control");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }
    const targetId = pluginLoadMatch[1];
    if (!canUserAccessClient(user.userId, user.role, targetId)) {
      return new Response("Forbidden: You do not have access to this client", { status: 403 });
    }
    const pluginId = pluginLoadMatch[2];
    if (!canUserAccessPlugin(user.userId, user.role, pluginId)) {
      return new Response("Forbidden: You do not have access to this plugin", { status: 403 });
    }
    const target = clientManager.getClient(targetId);
    if (!target) return new Response("Not found", { status: 404 });
    if (deps.isPluginLoaded(targetId, pluginId)) {
      return Response.json({ ok: true, alreadyLoaded: true });
    }
    if (deps.isPluginLoading(targetId, pluginId)) {
      return Response.json({ ok: true, loading: true });
    }

    const sigInfo = await getOrVerifySignature(deps.PLUGIN_ROOT, pluginId);

    if (sigInfo.signed && !sigInfo.valid) {
      return Response.json(
        { ok: false, error: "Plugin signature is invalid — the plugin may have been tampered with", signature: sigInfo },
        { status: 403 },
      );
    }

    if (!sigInfo.trusted) {
      let body: any = {};
      try {
        body = await req.json();
      } catch {}
      if (body.confirmed !== true) {
        return Response.json(
          { ok: false, error: "confirmation_required", signature: sigInfo },
          { status: 428 },
        );
      }
    }

    try {
      const bundle = await deps.loadPluginBundle(pluginId, target.os, target.arch);
      deps.markPluginLoading(targetId, pluginId);
      deps.sendPluginBundle(target, bundle);
      metrics.recordCommand("plugin_load");
      return Response.json({ ok: true, signature: sigInfo });
    } catch (err) {
      return Response.json({ ok: false, error: (err as Error).message }, { status: 400 });
    }
  }

  const pluginEventsPollMatch = url.pathname.match(/^\/api\/clients\/(.+)\/plugins\/(.+)\/events$/);
  if (req.method === "GET" && pluginEventsPollMatch) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try {
      requirePermission(user, "clients:control");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }
    const targetId = pluginEventsPollMatch[1];
    if (!canUserAccessClient(user.userId, user.role, targetId)) {
      return new Response("Forbidden: You do not have access to this client", { status: 403 });
    }
    const pluginId = pluginEventsPollMatch[2];
    if (!canUserAccessPlugin(user.userId, user.role, pluginId)) {
      return new Response("Forbidden: You do not have access to this plugin", { status: 403 });
    }
    const events = deps.drainPluginUIEvents(targetId, pluginId);
    return Response.json({ events });
  }

  const pluginEventMatch = url.pathname.match(/^\/api\/clients\/(.+)\/plugins\/(.+)\/event$/);
  if (req.method === "POST" && pluginEventMatch) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try {
      requirePermission(user, "clients:control");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    const targetId = pluginEventMatch[1];
    if (!canUserAccessClient(user.userId, user.role, targetId)) {
      return new Response("Forbidden: You do not have access to this client", { status: 403 });
    }
    const pluginId = pluginEventMatch[2];
    if (!canUserAccessPlugin(user.userId, user.role, pluginId)) {
      return new Response("Forbidden: You do not have access to this plugin", { status: 403 });
    }
    const target = clientManager.getClient(targetId);
    if (!target) return new Response("Not found", { status: 404 });
    if (deps.pluginState.enabled[pluginId] === false) {
      return Response.json({ ok: false, error: "Plugin disabled" }, { status: 400 });
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const event = typeof body.event === "string" ? body.event : "";
    const payload = body.payload;
    if (!event) {
      return new Response("Bad request", { status: 400 });
    }

    if (!deps.isPluginLoaded(targetId, pluginId)) {
      deps.enqueuePluginEvent(targetId, pluginId, event, payload);
      if (!deps.isPluginLoading(targetId, pluginId)) {
        try {
          const bundle = await deps.loadPluginBundle(pluginId, target.os, target.arch);
          deps.markPluginLoading(targetId, pluginId);
          deps.sendPluginBundle(target, bundle);
          metrics.recordCommand("plugin_load");
        } catch (err) {
          return Response.json({ ok: false, error: (err as Error).message }, { status: 400 });
        }
      }
      metrics.recordCommand("plugin_event");
      return Response.json({ ok: true, queued: true });
    }

    target.ws.send(
      encodeMessage({
        type: "plugin_event",
        pluginId,
        event,
        payload,
      }),
    );
    metrics.recordCommand("plugin_event");
    return Response.json({ ok: true });
  }

  const pluginUnloadMatch = url.pathname.match(/^\/api\/clients\/(.+)\/plugins\/(.+)\/unload$/);
  if (req.method === "POST" && pluginUnloadMatch) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try {
      requirePermission(user, "clients:control");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    const targetId = pluginUnloadMatch[1];
    if (!canUserAccessClient(user.userId, user.role, targetId)) {
      return new Response("Forbidden: You do not have access to this client", { status: 403 });
    }
    const pluginId = pluginUnloadMatch[2];
    if (!canUserAccessPlugin(user.userId, user.role, pluginId)) {
      return new Response("Forbidden: You do not have access to this plugin", { status: 403 });
    }
    const target = clientManager.getClient(targetId);
    if (!target) return new Response("Not found", { status: 404 });

    target.ws.send(
      encodeMessage({
        type: "command",
        commandType: "plugin_unload",
        id: uuidv4(),
        payload: { pluginId },
      }),
    );

    deps.pluginLoadedByClient.get(targetId)?.delete(pluginId);
    deps.pluginLoadingByClient.get(targetId)?.delete(pluginId);
    deps.pendingPluginEvents.delete(`${targetId}:${pluginId}`);

    return Response.json({ ok: true, id: pluginId });
  }

  const pluginRpcMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)\/rpc$/);
  if (req.method === "POST" && pluginRpcMatch) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try {
      requirePermission(user, "clients:control");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    let pluginId = "";
    try { pluginId = deps.sanitizePluginId(pluginRpcMatch[1]); } catch {
      return new Response("Invalid plugin id", { status: 400 });
    }

    if (!canUserAccessPlugin(user.userId, user.role, pluginId)) {
      return new Response("Forbidden: You do not have access to this plugin", { status: 403 });
    }

    if (deps.pluginState.enabled[pluginId] === false) {
      return Response.json({ ok: false, error: "Plugin disabled" }, { status: 400 });
    }
    if (!deps.pluginRuntime.isRunning(pluginId)) {
      return Response.json(
        { ok: false, error: "Plugin server runtime not running" },
        { status: 503 },
      );
    }

    let body: any = {};
    try { body = await req.json(); } catch {}
    const method = typeof body.method === "string" ? body.method.trim() : "";
    if (!method) {
      return Response.json({ ok: false, error: "Missing 'method'" }, { status: 400 });
    }
    if (method.length > 128) {
      return Response.json({ ok: false, error: "Method name too long" }, { status: 400 });
    }

    try {
      const result = await deps.pluginRuntime.rpc(pluginId, method, body.params, {
        id: user.userId,
        role: user.role,
      });
      metrics.recordCommand("plugin_rpc");
      return Response.json({ ok: true, result });
    } catch (err) {
      console.error(`[plugin:${pluginId}] RPC ${method} error:`, (err as Error).message, (err as Error).stack || "");
      return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
    }
  }

  const pluginStreamMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)\/stream$/);
  if (req.method === "GET" && pluginStreamMatch) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try {
      requirePermission(user, "clients:control");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    let pluginId = "";
    try { pluginId = deps.sanitizePluginId(pluginStreamMatch[1]); } catch {
      return new Response("Invalid plugin id", { status: 400 });
    }

    if (!canUserAccessPlugin(user.userId, user.role, pluginId)) {
      return new Response("Forbidden: You do not have access to this plugin", { status: 403 });
    }

    if (deps.pluginState.enabled[pluginId] === false) {
      return new Response("Plugin disabled", { status: 400 });
    }
    if (!deps.pluginRuntime.isRunning(pluginId)) {
      return new Response("Plugin server runtime not running", { status: 503 });
    }

    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const safeEnqueue = (chunk: Uint8Array) => {
          try { controller.enqueue(chunk); } catch {}
        };
        const send = (sse: string) => safeEnqueue(encoder.encode(sse));
        const close = () => {
          try { controller.close(); } catch {}
        };

        unsubscribe = deps.pluginRuntime.subscribe(pluginId, send, close);
        if (!unsubscribe) {
          close();
          return;
        }

        send(`: connected to ${pluginId}\n\n`);
        heartbeat = setInterval(() => send(`: ping\n\n`), 25_000);
      },
      cancel() {
        if (heartbeat) clearInterval(heartbeat);
        if (unsubscribe) unsubscribe();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  const pluginFrameMatch = url.pathname.match(/^\/plugins\/([^/]+)\/frame$/);
  if (req.method === "GET" && pluginFrameMatch) {
    const user = await authenticateRequest(req);
    if (!user) return serveLoginOrUnauthorized();
    if (user.role === "viewer") {
      return new Response("Forbidden: Viewers cannot access interactive features", { status: 403 });
    }

    let pluginId = "";
    try {
      pluginId = deps.sanitizePluginId(pluginFrameMatch[1]);
    } catch {
      return new Response("Invalid plugin id", { status: 400 });
    }

    if (!canUserAccessPlugin(user.userId, user.role, pluginId)) {
      return new Response("Forbidden: You do not have access to this plugin", { status: 403 });
    }

    const htmlFile = path.join(deps.PLUGIN_ROOT, pluginId, "assets", `${pluginId}.html`);
    const file = Bun.file(htmlFile);
    if (!(await file.exists())) {
      return new Response("Not found", { status: 404 });
    }

    const raw = await file.text();
    const baseTag = `<base href="/plugins/${pluginId}/assets/" />`;
    let injected = raw;

    const headMatch = raw.match(/<head[^>]*>/i);
    if (headMatch) {
      injected = raw.replace(headMatch[0], `${headMatch[0]}\n    ${baseTag}`);
    }

    const etag = `"${file.size.toString(36)}-${file.lastModified.toString(36)}"`;
    if (req.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304 });
    }

    return new Response(injected, {
      headers: { ...deps.secureHeaders("text/html; charset=utf-8"), "Cache-Control": "no-cache", ETag: etag },
    });
  }

  const pluginPageMatch = url.pathname.match(/^\/plugins\/([^/]+)$/);
  if (req.method === "GET" && pluginPageMatch) {
    const user = await authenticateRequest(req);
    if (!user) return serveLoginOrUnauthorized();
    if (user.role === "viewer") {
      return new Response("Forbidden: Viewers cannot access interactive features", { status: 403 });
    }

    let pluginId = "";
    try {
      pluginId = deps.sanitizePluginId(pluginPageMatch[1]);
    } catch {
      return new Response("Invalid plugin id", { status: 400 });
    }

    if (!canUserAccessPlugin(user.userId, user.role, pluginId)) {
      return new Response("Forbidden: You do not have access to this plugin", { status: 403 });
    }

    const clientId = url.searchParams.get("clientId") || "";
    if (clientId && !canUserAccessClient(user.userId, user.role, clientId)) {
      return new Response("Forbidden: Client access denied", { status: 403 });
    }

    const htmlFile = path.join(deps.PLUGIN_ROOT, pluginId, "assets", `${pluginId}.html`);
    const file = Bun.file(htmlFile);
    const htmlExists = await file.exists();

    const etag = htmlExists
      ? `"page-${file.size.toString(36)}-${file.lastModified.toString(36)}"`
      : `"page-empty"`;
    if (req.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304 });
    }

    let pluginBody = "";
    let pluginHeadExtras = "";

    if (htmlExists) {
      const raw = await file.text();

      const bodyMatch = raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      pluginBody = bodyMatch ? bodyMatch[1] : raw;

      pluginBody = pluginBody.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (tag) => {
        const srcMatch = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
        if (!srcMatch) return tag;
        const src = srcMatch[1].split("?")[0].split("#")[0];
        return src === `${pluginId}.js` || src.endsWith(`/${pluginId}.js`) ? "" : tag;
      });

      const headMatch = raw.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
      if (headMatch) {
        const headContent = headMatch[1];
        const linkTags = headContent.match(/<link[^>]*>/gi) || [];
        const styleTags = headContent.match(/<style[\s\S]*?<\/style>/gi) || [];
        pluginHeadExtras = [...linkTags, ...styleTags]
          .map((tag) =>
            tag.replace(/href="(?!https?:\/\/|\/)/g, `href="/plugins/${pluginId}/assets/`),
          )
          .join("\n    ");
      }
    }

    const jsFile = Bun.file(path.join(deps.PLUGIN_ROOT, pluginId, "assets", `${pluginId}.js`));
    const hasPluginJs = await jsFile.exists();

    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${pluginId} - Overlord Plugin</title>
    <link rel="stylesheet" href="/vendor/inter/400.css" />
    <link rel="stylesheet" href="/vendor/inter/600.css" />
    <link rel="stylesheet" href="/vendor/inter/700.css" />
    <link rel="stylesheet" href="/assets/tailwind.css" />
    <link rel="stylesheet" href="/vendor/fontawesome/css/all.min.css" />
    <link rel="stylesheet" href="/assets/main.css" />
    <link rel="stylesheet" href="/assets/custom.css" />
    ${pluginHeadExtras}
  </head>
  <body class="min-h-screen bg-slate-950 text-slate-100">
    <header id="top-nav"></header>
    <main class="px-5 py-6">
      <div class="max-w-6xl mx-auto">
        <div id="plugin-container" class="rounded-2xl border border-slate-800 bg-slate-900/50 overflow-hidden p-4">
          ${pluginBody}
        </div>
      </div>
    </main>
    <script type="module" src="/assets/nav.js"></script>
    ${hasPluginJs ? `<script src="/plugins/${pluginId}/assets/${pluginId}.js"></script>` : ""}
  </body>
</html>`;

    return new Response(html, {
      headers: { ...deps.secureHeaders("text/html; charset=utf-8"), "Cache-Control": "no-cache", ETag: etag },
    });
  }

  const pluginAssetMatch = url.pathname.match(/^\/plugins\/([^/]+)\/assets\/(.+)$/);
  if (req.method === "GET" && pluginAssetMatch) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    if (user.role === "viewer") {
      return new Response("Forbidden: Viewers cannot access interactive features", { status: 403 });
    }

    const [, pluginId, assetPath] = pluginAssetMatch;
    if (!canUserAccessPlugin(user.userId, user.role, pluginId)) {
      return new Response("Forbidden: You do not have access to this plugin", { status: 403 });
    }
    let decodedPath = assetPath;
    try {
      decodedPath = decodeURIComponent(assetPath);
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    if (decodedPath.includes("\u0000") || path.isAbsolute(decodedPath)) {
      return new Response("Not found", { status: 404 });
    }

    const assetsRoot = path.join(deps.PLUGIN_ROOT, pluginId, "assets");
    const normalized = decodedPath.replace(/\\/g, "/");
    const resolvedPath = path.resolve(assetsRoot, normalized);
    const rootWithSep = assetsRoot.endsWith(path.sep) ? assetsRoot : `${assetsRoot}${path.sep}`;

    if (!resolvedPath.startsWith(rootWithSep)) {
      return new Response("Not found", { status: 404 });
    }

    const file = Bun.file(resolvedPath);
    if (await file.exists()) {
      const etag = `"${file.size.toString(36)}-${file.lastModified.toString(36)}"`;
      if (req.headers.get("if-none-match") === etag) {
        return new Response(null, { status: 304 });
      }
      return new Response(file, {
        headers: { ...deps.secureHeaders(deps.mimeType(assetPath)), "Cache-Control": "no-cache", ETag: etag },
      });
    }
    return new Response("Not found", { status: 404 });
  }

  return null;
}
