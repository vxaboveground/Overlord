import { Database } from "bun:sqlite";
import path from "path";
import { pathToFileURL } from "url";
import type { WorkerInbound, WorkerOutbound } from "./types";

declare const self: {
  postMessage: (msg: WorkerOutbound) => void;
  onmessage: ((e: MessageEvent<WorkerInbound>) => void) | null;
};

type PluginExports = {
  setup?: (ctx: PluginContext) => unknown | Promise<unknown>;
  onEvent?: (ctx: PluginContext, clientId: string, event: string, payload: unknown) => unknown | Promise<unknown>;
  rpc?: Record<string, (ctx: PluginContext, params: unknown, meta: { caller: { id: number; role: string } }) => unknown | Promise<unknown>>;
  buildHooks?: Record<string, (ctx: PluginContext, payload: unknown) => unknown | Promise<unknown>>;
  onBuildPrepare?: (ctx: PluginContext, payload: unknown) => unknown | Promise<unknown>;
  onBuildTarget?: (ctx: PluginContext, payload: unknown) => unknown | Promise<unknown>;
  onBuildPostBuild?: (ctx: PluginContext, payload: unknown) => unknown | Promise<unknown>;
  onBuildBeforeUpx?: (ctx: PluginContext, payload: unknown) => unknown | Promise<unknown>;
  onBuildAfterUpx?: (ctx: PluginContext, payload: unknown) => unknown | Promise<unknown>;
  onBuildBeforeScriptWrapper?: (ctx: PluginContext, payload: unknown) => unknown | Promise<unknown>;
  onBuildAfterScriptWrapper?: (ctx: PluginContext, payload: unknown) => unknown | Promise<unknown>;
  onBuildBeforeIpa?: (ctx: PluginContext, payload: unknown) => unknown | Promise<unknown>;
  onBuildAfterIpa?: (ctx: PluginContext, payload: unknown) => unknown | Promise<unknown>;
  onBuildBeforeDonut?: (ctx: PluginContext, payload: unknown) => unknown | Promise<unknown>;
  onBuildAfterDonut?: (ctx: PluginContext, payload: unknown) => unknown | Promise<unknown>;
  onBuildBeforeLinuxShellcode?: (ctx: PluginContext, payload: unknown) => unknown | Promise<unknown>;
  onBuildAfterLinuxShellcode?: (ctx: PluginContext, payload: unknown) => unknown | Promise<unknown>;
  onBuildBeforeSgn?: (ctx: PluginContext, payload: unknown) => unknown | Promise<unknown>;
  onBuildAfterSgn?: (ctx: PluginContext, payload: unknown) => unknown | Promise<unknown>;
  onBuildBeforeSgnTxt?: (ctx: PluginContext, payload: unknown) => unknown | Promise<unknown>;
  onBuildAfterSgnTxt?: (ctx: PluginContext, payload: unknown) => unknown | Promise<unknown>;
  onBuildArtifact?: (ctx: PluginContext, payload: unknown) => unknown | Promise<unknown>;
  onBuildComplete?: (ctx: PluginContext, payload: unknown) => unknown | Promise<unknown>;
  onBuildFailed?: (ctx: PluginContext, payload: unknown) => unknown | Promise<unknown>;
  teardown?: (ctx: PluginContext) => unknown | Promise<unknown>;
};

type PluginContext = {
  pluginId: string;
  db: Database;
  dataDir: string;
  log: {
    debug: (message: string) => void;
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
  fetch: typeof fetch;
  broadcast: (channel: string, data: unknown) => void;
};

let plugin: PluginExports | null = null;
let db: Database | null = null;
let ctx: PluginContext | null = null;
let pluginId = "";

function send(msg: WorkerOutbound) {
  self.postMessage(msg);
}

function makeLogger(): PluginContext["log"] {
  return {
    debug: (m) => send({ type: "log", level: "debug", message: m }),
    info: (m) => send({ type: "log", level: "info", message: m }),
    warn: (m) => send({ type: "log", level: "warn", message: m }),
    error: (m) => send({ type: "log", level: "error", message: m }),
  };
}

self.onmessage = async (e: MessageEvent<WorkerInbound>) => {
  const msg = e.data;

  if (msg.type === "boot") {
    try {
      pluginId = msg.pluginId;
      db = new Database(msg.dbPath, { create: true });
      try {
        db.exec("PRAGMA journal_mode = WAL");
        db.exec("PRAGMA synchronous = NORMAL");
        db.exec("PRAGMA foreign_keys = ON");
      } catch {}

      const dataDir = path.join(msg.pluginRoot, msg.pluginId, "data");
      ctx = {
        pluginId,
        db,
        dataDir,
        log: makeLogger(),
        fetch: globalThis.fetch.bind(globalThis),
        broadcast: (channel, data) => send({ type: "broadcast", channel, data }),
      };

      const moduleUrl = `${pathToFileURL(msg.serverScript).href}?v=${Date.now()}`;
      const mod = await import(/* @vite-ignore */ moduleUrl);
      plugin = (mod.default || mod) as PluginExports;

      if (typeof plugin.setup === "function") {
        await plugin.setup(ctx);
      }

      send({ type: "ready" });
    } catch (err) {
      const error = err instanceof Error ? `${err.message}\n${err.stack || ""}` : String(err);
      send({ type: "boot_error", error });
    }
    return;
  }

  if (msg.type === "event") {
    if (!plugin || !ctx) return;
    if (typeof plugin.onEvent !== "function") return;
    try {
      await plugin.onEvent(ctx, msg.clientId, msg.event, msg.payload);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      send({ type: "log", level: "error", message: `onEvent(${msg.event}) failed: ${error}` });
    }
    return;
  }

  if (msg.type === "rpc") {
    if (!plugin || !ctx) {
      send({ type: "rpc_reply", id: msg.id, ok: false, error: "Plugin not initialised" });
      return;
    }
    const handler = plugin.rpc?.[msg.method];
    if (typeof handler !== "function") {
      send({ type: "rpc_reply", id: msg.id, ok: false, error: `Unknown RPC method: ${msg.method}` });
      return;
    }
    try {
      const result = await handler(ctx, msg.params, { caller: msg.caller });
      send({ type: "rpc_reply", id: msg.id, ok: true, result: result ?? null });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack || "" : "";
      console.error(`[plugin-worker] RPC ${msg.method} error: ${error}`, stack);
      send({ type: "rpc_reply", id: msg.id, ok: false, error });
    }
    return;
  }

  if (msg.type === "build_hook") {
    if (!plugin || !ctx) {
      send({ type: "build_hook_reply", id: msg.id, ok: false, error: "Plugin not initialised" });
      return;
    }
    const handler =
      plugin.buildHooks?.[msg.hook] ||
      (msg.hook === "prepare" ? plugin.onBuildPrepare : undefined) ||
      (msg.hook === "target" ? plugin.onBuildTarget : undefined) ||
      (msg.hook === "post_build" ? plugin.onBuildPostBuild : undefined) ||
      (msg.hook === "before_upx" ? plugin.onBuildBeforeUpx : undefined) ||
      (msg.hook === "after_upx" ? plugin.onBuildAfterUpx : undefined) ||
      (msg.hook === "before_script_wrapper" ? plugin.onBuildBeforeScriptWrapper : undefined) ||
      (msg.hook === "after_script_wrapper" ? plugin.onBuildAfterScriptWrapper : undefined) ||
      (msg.hook === "before_ipa" ? plugin.onBuildBeforeIpa : undefined) ||
      (msg.hook === "after_ipa" ? plugin.onBuildAfterIpa : undefined) ||
      (msg.hook === "before_donut" ? plugin.onBuildBeforeDonut : undefined) ||
      (msg.hook === "after_donut" ? plugin.onBuildAfterDonut : undefined) ||
      (msg.hook === "before_linux_shellcode" ? plugin.onBuildBeforeLinuxShellcode : undefined) ||
      (msg.hook === "after_linux_shellcode" ? plugin.onBuildAfterLinuxShellcode : undefined) ||
      (msg.hook === "before_sgn" ? plugin.onBuildBeforeSgn : undefined) ||
      (msg.hook === "after_sgn" ? plugin.onBuildAfterSgn : undefined) ||
      (msg.hook === "before_sgn_txt" ? plugin.onBuildBeforeSgnTxt : undefined) ||
      (msg.hook === "after_sgn_txt" ? plugin.onBuildAfterSgnTxt : undefined) ||
      (msg.hook === "artifact" ? plugin.onBuildArtifact : undefined) ||
      (msg.hook === "complete" ? plugin.onBuildComplete : undefined) ||
      (msg.hook === "failed" ? plugin.onBuildFailed : undefined);
    if (typeof handler !== "function") {
      send({ type: "build_hook_reply", id: msg.id, ok: true, result: null });
      return;
    }
    try {
      const result = await handler(ctx, msg.payload);
      send({ type: "build_hook_reply", id: msg.id, ok: true, result: result ?? null });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack || "" : "";
      console.error(`[plugin-worker] build hook ${msg.hook} error: ${error}`, stack);
      send({ type: "build_hook_reply", id: msg.id, ok: false, error });
    }
    return;
  }

  if (msg.type === "shutdown") {
    if (plugin && ctx && typeof plugin.teardown === "function") {
      try {
        await plugin.teardown(ctx);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        send({ type: "log", level: "warn", message: `teardown failed: ${error}` });
      }
    }
    try { db?.close(); } catch {}
    db = null;
    plugin = null;
    ctx = null;
    return;
  }
};
