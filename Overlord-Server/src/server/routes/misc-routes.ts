import { authenticateRequest } from "../../auth";
import { AuditAction, getAuditLogs, logAudit } from "../../auditLog";
import { logger } from "../../logger";
import { getConfig, updateSecurityConfig, updateTlsConfig, updateOidcConfig, updateAppearanceConfig, updateChatConfig, getExportableConfig, importFullConfig, updateRegistrationConfig, updateBuildRateLimitConfig, updateThumbnailsConfig, updateInputArchiveConfig } from "../../config";
import {
  saveBrandingImage,
  getClientMetricsSummary,
  getClientMetricsSummaryForUser,
  getDatabaseFileSizeBytes,
  getSharedUiSettings,
  listClients,
  saveSharedUiSettings,
} from "../../db";
import { getThumbnailStats } from "../../thumbnails";
import { getClientCount, getOnlineClients } from "../../clientManager";
import { metrics } from "../../metrics";
import { requirePermission } from "../../rbac";
import { getUserTelegramChatId, setUserTelegramChatId, getUserClientAccessScope, listUserClientRuleIdsByAccess, canUserAccessClient, canUserAccessFeature, getUserById, getUserInputArchiveEnabled, setUserInputArchiveEnabled, type FeatureName } from "../../users";
import { buildClientGraph } from "../client-graph";
import { runCertbotSetup } from "../certbot-setup";
import {
  getActiveProxies,
  startProxy,
  stopProxy,
} from "../socks5-proxy-manager";

let activeServerProfile: Promise<any> | null = null;
let jscRuntimePromise: Promise<any> | null | undefined;
let inspectorRuntimePromise: Promise<any> | null | undefined;

type MiscRouteDeps = {
  CORS_HEADERS: Record<string, string>;
  SERVER_VERSION: string;
  PUBLIC_ROOT: string;
  requestIP?: (req: Request) => { address?: string } | null | undefined;
  getConsoleSessionCount: () => number;
  getRdSessionCount: () => number;
  getFileBrowserSessionCount: () => number;
  getProcessSessionCount: () => number;
  tlsCertPath?: string;
  tlsSource?: "certbot" | "configured" | "self-signed";
};

const BRAND_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const BRAND_IMAGE_KINDS = new Set(["nav-logo", "login-logo", "hero-image", "tab-icon", "dashboard-background"]);

function detectBrandImage(bytes: Uint8Array, contentType: string): { ext: string; type: string } | null {
  const type = contentType.toLowerCase().split(";")[0].trim();
  const isPng = bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isGif = bytes.length >= 6 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
    bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61;
  const isWebp = bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  const isIco = bytes.length >= 6 &&
    bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00;

  if (isPng && (!type || type === "image/png")) return { ext: "png", type: "image/png" };
  if (isJpeg && (!type || type === "image/jpeg" || type === "image/jpg")) return { ext: "jpg", type: "image/jpeg" };
  if (isGif && (!type || type === "image/gif")) return { ext: "gif", type: "image/gif" };
  if (isWebp && (!type || type === "image/webp")) return { ext: "webp", type: "image/webp" };
  if (isIco && (!type || type === "image/x-icon" || type === "image/vnd.microsoft.icon")) {
    return { ext: "ico", type: "image/x-icon" };
  }
  return null;
}

function maskOidcSettings() {
  const oidc = getConfig().oidc;
  return {
    ...oidc,
    clientSecret: "",
    clientSecretSet: Boolean(oidc.clientSecret),
  };
}

function clampProfileDuration(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 5000;
  return Math.max(1000, Math.min(30000, Math.floor(parsed)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readProcessCpuUsage(previous?: NodeJS.CpuUsage): NodeJS.CpuUsage | null {
  const cpuUsage = (process as any).cpuUsage;
  if (typeof cpuUsage !== "function") return null;
  return previous ? cpuUsage(previous) : cpuUsage();
}

function readResourceUsage(): any | null {
  const resourceUsage = (process as any).resourceUsage;
  if (typeof resourceUsage !== "function") return null;
  try {
    return resourceUsage();
  } catch {
    return null;
  }
}

async function loadJscRuntime(): Promise<any | null> {
  if (jscRuntimePromise === undefined) {
    try {
      const runtimeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
      jscRuntimePromise = runtimeImport("bun:jsc").catch(() => null);
    } catch {
      jscRuntimePromise = null;
    }
  }
  return jscRuntimePromise;
}

async function loadInspectorRuntime(): Promise<any | null> {
  if (inspectorRuntimePromise === undefined) {
    try {
      const runtimeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
      inspectorRuntimePromise = runtimeImport("node:inspector").catch(() => null);
    } catch {
      inspectorRuntimePromise = null;
    }
  }
  return inspectorRuntimePromise;
}

async function summarizeRuntimeMemory() {
  const mem = process.memoryUsage();
  let jscHeap: any = null;
  let jscMemory: any = null;
  try {
    const jsc = await loadJscRuntime();
    if (typeof jsc?.heapStats === "function") jscHeap = jsc.heapStats();
    if (typeof jsc?.memoryUsage === "function") jscMemory = jsc.memoryUsage();
  } catch { }

  const objectTypeCounts = jscHeap?.objectTypeCounts && typeof jscHeap.objectTypeCounts === "object"
    ? Object.entries(jscHeap.objectTypeCounts)
        .map(([type, count]) => ({ type, count: Number(count) || 0 }))
        .filter((entry) => entry.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 20)
    : [];

  const activeResourcesInfo = typeof (process as any).getActiveResourcesInfo === "function"
    ? (process as any).getActiveResourcesInfo()
    : [];

  const activeResources = Array.isArray(activeResourcesInfo)
    ? Object.entries(activeResourcesInfo.reduce((acc: Record<string, number>, name: string) => {
        acc[name] = (acc[name] || 0) + 1;
        return acc;
      }, {})).map(([type, count]) => ({ type, count }))
    : [];

  return {
    process: {
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external,
      arrayBuffers: (mem as any).arrayBuffers ?? 0,
    },
    jscHeap: jscHeap ? {
      heapSize: jscHeap.heapSize,
      heapCapacity: jscHeap.heapCapacity,
      extraMemorySize: jscHeap.extraMemorySize,
      objectCount: jscHeap.objectCount,
      protectedObjectCount: jscHeap.protectedObjectCount,
      globalObjectCount: jscHeap.globalObjectCount,
      topObjectTypes: objectTypeCounts,
    } : null,
    jscMemory,
    resources: activeResources.sort((a: any, b: any) => b.count - a.count).slice(0, 20),
    components: {
      thumbnails: getThumbnailStats(),
      clients: {
        inMemory: getClientCount(),
        online: getOnlineClients().length,
      },
      database: {
        fileSizeBytes: getDatabaseFileSizeBytes(),
      },
    },
  };
}

function normalizeProfileUrl(url: string): string {
  if (!url) return "(runtime)";
  const clean = url.replace(/^file:\/\//, "").replaceAll("\\", "/");
  const parts = clean.split("/");
  return parts.slice(-3).join("/");
}

function summarizeCpuProfile(profile: any, durationMs: number) {
  const nodes = Array.isArray(profile?.nodes) ? profile.nodes : [];
  const samples = Array.isArray(profile?.samples) ? profile.samples : [];
  const timeDeltas = Array.isArray(profile?.timeDeltas) ? profile.timeDeltas : [];
  const nodeById = new Map<number, any>();
  const parentById = new Map<number, number>();

  for (const node of nodes) {
    if (typeof node?.id !== "number") continue;
    nodeById.set(node.id, node);
    if (Array.isArray(node.children)) {
      for (const childId of node.children) {
        if (typeof childId === "number") parentById.set(childId, node.id);
      }
    }
  }

  const functionTotals = new Map<string, any>();
  const moduleTotals = new Map<string, any>();
  const stackTotals = new Map<string, any>();
  let totalUs = 0;

  samples.forEach((nodeId: number, index: number) => {
    const node = nodeById.get(nodeId);
    if (!node) return;
    const deltaUs = Number(timeDeltas[index]) || 0;
    totalUs += deltaUs;
    const frame = node.callFrame || {};
    const name = frame.functionName || "(anonymous)";
    const moduleName = normalizeProfileUrl(frame.url || "");
    const location = frame.url
      ? `${moduleName}:${(Number(frame.lineNumber) || 0) + 1}`
      : moduleName;
    const key = `${name}\n${location}`;
    const current = functionTotals.get(key) || { name, location, samples: 0, selfTimeUs: 0 };
    current.samples += 1;
    current.selfTimeUs += deltaUs;
    functionTotals.set(key, current);

    const moduleCurrent = moduleTotals.get(moduleName) || { module: moduleName, samples: 0, selfTimeUs: 0 };
    moduleCurrent.samples += 1;
    moduleCurrent.selfTimeUs += deltaUs;
    moduleTotals.set(moduleName, moduleCurrent);

    const stackFrames: string[] = [];
    let cursor: number | undefined = nodeId;
    while (typeof cursor === "number" && stackFrames.length < 8) {
      const stackNode = nodeById.get(cursor);
      if (!stackNode) break;
      const stackFrame = stackNode.callFrame || {};
      const stackName = stackFrame.functionName || "(anonymous)";
      stackFrames.push(`${stackName} @ ${normalizeProfileUrl(stackFrame.url || "")}`);
      cursor = parentById.get(cursor);
    }
    const stackKey = stackFrames.join(" <- ");
    const stackCurrent = stackTotals.get(stackKey) || { stack: stackFrames, samples: 0, selfTimeUs: 0 };
    stackCurrent.samples += 1;
    stackCurrent.selfTimeUs += deltaUs;
    stackTotals.set(stackKey, stackCurrent);
  });

  if (!totalUs && samples.length > 0) totalUs = durationMs * 1000;
  const decorate = (item: any) => ({
    ...item,
    selfTimeMs: item.selfTimeUs / 1000,
    percent: totalUs > 0 ? (item.selfTimeUs / totalUs) * 100 : 0,
  });

  return {
    totalSamples: samples.length,
    totalTimeMs: totalUs / 1000,
    topFunctions: Array.from(functionTotals.values()).map(decorate).sort((a, b) => b.samples - a.samples).slice(0, 25),
    topModules: Array.from(moduleTotals.values()).map(decorate).sort((a, b) => b.samples - a.samples).slice(0, 12),
    topStacks: Array.from(stackTotals.values()).map(decorate).sort((a, b) => b.samples - a.samples).slice(0, 10),
  };
}

const SHARED_UI_SETTING_FEATURES: Record<string, FeatureName> = {
  remote_desktop: "remote_desktop",
  hvnc: "hvnc",
  webcam: "webcam",
};

function pickString(value: unknown, allowed: readonly string[]): string | undefined {
  if (typeof value !== "string") return undefined;
  return allowed.includes(value) ? value : undefined;
}

function pickBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function pickSteppedNumber(
  value: unknown,
  min: number,
  max: number,
  step = 1,
): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  const clamped = Math.max(min, Math.min(max, Math.round(parsed)));
  return Math.round(clamped / step) * step;
}

function assignIfDefined(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value !== undefined) target[key] = value;
}

function sanitizeSharedUiSettings(scope: string, raw: unknown): Record<string, unknown> {
  const input = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const out: Record<string, unknown> = {};

  assignIfDefined(out, "display", pickSteppedNumber(input.display, 0, 63));
  assignIfDefined(out, "quality", pickSteppedNumber(input.quality, 10, 100, 5));
  assignIfDefined(out, "preferH264", pickBoolean(input.preferH264));
  assignIfDefined(out, "webrtcMode", pickString(input.webrtcMode, ["off", "p2p", "relayed"]));
  assignIfDefined(out, "mouse", pickBoolean(input.mouse));
  assignIfDefined(out, "keyboard", pickBoolean(input.keyboard));
  assignIfDefined(out, "clipboardSync", pickBoolean(input.clipboardSync));

  if (scope === "remote_desktop") {
    assignIfDefined(out, "resolution", pickString(input.resolution, ["720", "1080", "1440", "-1"]));
    assignIfDefined(out, "targetFps", pickString(input.targetFps, ["30", "60", "90", "120", "144", "165", "240"]));
    assignIfDefined(out, "cursor", pickBoolean(input.cursor));
    assignIfDefined(out, "duplication", pickBoolean(input.duplication));
    assignIfDefined(out, "audio", pickBoolean(input.audio));
    assignIfDefined(out, "audioTransport", pickString(input.audioTransport, ["off", "p2p", "relayed"]));
    assignIfDefined(out, "smoothing", pickSteppedNumber(input.smoothing, 0, 80, 5));
    assignIfDefined(out, "recordMode", pickString(input.recordMode, ["normal", "compact"]));
    assignIfDefined(out, "recordFps", pickString(input.recordFps, ["", "3", "5", "10", "15", "30", "60"]));
  } else if (scope === "hvnc") {
    assignIfDefined(out, "resolution", pickString(input.resolution, ["720", "1080", "1440", "-1"]));
    assignIfDefined(out, "dxgi", pickBoolean(input.dxgi));
    assignIfDefined(out, "uia", pickBoolean(input.uia));
    assignIfDefined(out, "cloneProfile", pickBoolean(input.cloneProfile));
    assignIfDefined(out, "cloneLite", pickBoolean(input.cloneLite));
    assignIfDefined(out, "killIfRunning", pickBoolean(input.killIfRunning));
  } else if (scope === "webcam") {
    assignIfDefined(out, "camera", pickSteppedNumber(input.camera, 0, 63));
    assignIfDefined(out, "fps", pickSteppedNumber(input.fps, 1, 120));
    assignIfDefined(out, "audio", pickBoolean(input.audio));
    assignIfDefined(out, "audioTransport", pickString(input.audioTransport, ["off", "p2p", "relayed"]));
  }

  return out;
}

async function runInspectorCpuProfile(durationMs: number) {
  const inspector = await loadInspectorRuntime();
  const Session = (inspector as any).Session;
  if (typeof Session !== "function") {
    throw new Error("Runtime inspector profiler is unavailable");
  }

  const session = new Session();
  const post = (method: string, params?: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
    session.post(method, params || {}, (error: Error | null, result: any) => {
      if (error) reject(error);
      else resolve(result);
    });
  });

  session.connect();
  try {
    await post("Profiler.enable");
    await post("Profiler.setSamplingInterval", { interval: 1000 });
    await post("Profiler.start");
    await sleep(durationMs);
    const result = await post("Profiler.stop");
    await post("Profiler.disable").catch(() => undefined);
    return result?.profile || null;
  } finally {
    session.disconnect();
  }
}

async function collectServerProfile(durationMs: number) {
  const startedAt = Date.now();
  const beforeCpu = readProcessCpuUsage();
  const beforeResource = readResourceUsage();
  const beforeMemory = await summarizeRuntimeMemory();
  let cpuProfile: any = null;
  let profilerError: string | null = null;

  try {
    cpuProfile = await runInspectorCpuProfile(durationMs);
  } catch (error: any) {
    profilerError = String(error?.message || error || "CPU profiler failed");
    await sleep(durationMs);
  }

  const elapsedMs = Date.now() - startedAt;
  const cpuDelta = beforeCpu ? readProcessCpuUsage(beforeCpu) : null;
  const afterResource = readResourceUsage();
  const afterMemory = await summarizeRuntimeMemory();
  const cpuTotalUs = cpuDelta ? (cpuDelta.user + cpuDelta.system) : 0;

  return {
    ok: true,
    startedAt,
    durationMs: elapsedMs,
    requestedDurationMs: durationMs,
    cpu: {
      userUs: cpuDelta?.user ?? null,
      systemUs: cpuDelta?.system ?? null,
      totalUs: cpuTotalUs || null,
      processPercent: elapsedMs > 0 && cpuTotalUs > 0 ? (cpuTotalUs / (elapsedMs * 1000)) * 100 : null,
      resourceBefore: beforeResource,
      resourceAfter: afterResource,
      profilerError,
      summary: cpuProfile ? summarizeCpuProfile(cpuProfile, elapsedMs) : null,
      rawProfile: cpuProfile,
    },
    memory: {
      before: beforeMemory,
      after: afterMemory,
    },
  };
}

export async function handleMiscRoutes(
  req: Request,
  url: URL,
  deps: MiscRouteDeps,
): Promise<Response | null> {
  if (req.method === "GET" && url.pathname === "/api/metrics") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const snapshot = metrics.getSnapshot();

    const clientSummary = user.role === "admin"
      ? getClientMetricsSummary()
      : getClientMetricsSummaryForUser(user.userId);
    snapshot.clients.total = clientSummary.total;
    snapshot.clients.online = clientSummary.online;
    snapshot.clients.offline = clientSummary.total - clientSummary.online;
    snapshot.clients.byOS = clientSummary.byOS;
    snapshot.clients.byCountry = clientSummary.byCountry;

    snapshot.sessions.console = deps.getConsoleSessionCount();
    snapshot.sessions.remoteDesktop = deps.getRdSessionCount();
    snapshot.sessions.fileBrowser = deps.getFileBrowserSessionCount();
    snapshot.sessions.process = deps.getProcessSessionCount();

    const requestedHistoryLimit = Number(url.searchParams.get("historyLimit") || 240);
    const historyLimit = Number.isFinite(requestedHistoryLimit)
      ? Math.max(1, Math.min(2000, requestedHistoryLimit))
      : 240;
    const history = metrics.getHistory().slice(-historyLimit);

    return new Response(JSON.stringify({ snapshot, history }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (req.method === "GET" && url.pathname === "/api/client-graph") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });

    const limit = Math.max(25, Math.min(500, Number(url.searchParams.get("limit") || 300)));
    const search = (url.searchParams.get("q") || "").trim().toLowerCase();
    const statusFilter = url.searchParams.get("status") || "all";
    const groupFilter = url.searchParams.get("group") || "all";
    let allowedClientIds: string[] | undefined;
    let deniedClientIds: string[] | undefined;

    if (user.role !== "admin") {
      const scope = getUserClientAccessScope(user.userId);
      if (scope === "none") {
        return Response.json(buildClientGraph([]), { headers: deps.CORS_HEADERS });
      }
      if (scope === "allowlist") {
        allowedClientIds = listUserClientRuleIdsByAccess(user.userId, "allow");
      } else if (scope === "denylist") {
        deniedClientIds = listUserClientRuleIdsByAccess(user.userId, "deny");
      }
    }

    const clients = listClients({
      page: 1,
      pageSize: limit,
      search,
      sort: "last_seen_desc",
      statusFilter,
      osFilter: "all",
      countryFilter: "all",
      enrollmentFilter: "approved",
      groupFilter,
      allowedClientIds,
      deniedClientIds,
    });

    const graph = buildClientGraph(clients.items);
    graph.summary.totalClients = clients.total;
    return Response.json(graph, { headers: deps.CORS_HEADERS });
  }

  if (url.pathname === "/health") {
    return new Response("ok", { headers: deps.CORS_HEADERS });
  }

  if (req.method === "GET" && url.pathname === "/api/version") {
    return new Response(JSON.stringify({ version: deps.SERVER_VERSION }), {
      headers: {
        ...deps.CORS_HEADERS,
        "Content-Type": "application/json",
      },
    });
  }

  if (url.pathname.startsWith("/api/ui-settings/")) {
    const user = await authenticateRequest(req);
    if (!user) {
      return Response.json({ error: "Not authenticated" }, { status: 401 });
    }

    const scope = decodeURIComponent(url.pathname.slice("/api/ui-settings/".length));
    const feature = SHARED_UI_SETTING_FEATURES[scope];
    if (!feature) {
      return Response.json({ error: "Unknown UI settings scope" }, { status: 404 });
    }
    if (!canUserAccessFeature(user.userId, user.role, feature)) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    if (req.method === "GET") {
      const record = getSharedUiSettings(scope);
      let settings: Record<string, unknown> = {};
      if (record?.settingsJson) {
        try {
          settings = sanitizeSharedUiSettings(scope, JSON.parse(record.settingsJson));
        } catch {
          settings = {};
        }
      }
      return Response.json(
        {
          scope,
          settings,
          updatedAt: record?.updatedAt || null,
          updatedByUserId: record?.updatedByUserId || null,
        },
        { headers: deps.CORS_HEADERS },
      );
    }

    if (req.method === "PUT") {
      let body: any = {};
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }

      const settings = sanitizeSharedUiSettings(scope, body?.settings);
      const record = saveSharedUiSettings(scope, JSON.stringify(settings), user.userId);
      return Response.json(
        {
          ok: true,
          scope,
          settings,
          updatedAt: record.updatedAt,
          updatedByUserId: record.updatedByUserId,
        },
        { headers: deps.CORS_HEADERS },
      );
    }

    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  if (url.pathname === "/api/settings/telegram") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (req.method === "GET") {
      const chatId = getUserTelegramChatId(user.userId);
      return Response.json({ telegramChatId: chatId || "" });
    }

    if (req.method === "PUT") {
      let body: any = {};
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }

      const chatId = typeof body?.telegramChatId === "string" ? body.telegramChatId.trim() : null;
      const result = setUserTelegramChatId(user.userId, chatId || null);
      if (!result.success) {
        return Response.json({ error: result.error }, { status: 400 });
      }

      return Response.json({ success: true, telegramChatId: chatId || "" });
    }
  }

  if (url.pathname === "/api/settings/security") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      requirePermission(user, "system:security");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    if (req.method === "GET") {
      return Response.json({ security: getConfig().security }, { headers: deps.CORS_HEADERS });
    }

    if (req.method === "PUT") {
      let body: any = {};
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }

      if (Boolean(body?.mfaRequiredForAdmins)) {
        const dbUser = getUserById(user.userId);
        if (!dbUser?.mfa_enabled) {
          return Response.json(
            { error: "Enable MFA on your own admin account before requiring it for admins." },
            { status: 400 },
          );
        }
      }

      const updated = await updateSecurityConfig({
        sessionTtlHours: Number(body?.sessionTtlHours),
        loginMaxAttempts: Number(body?.loginMaxAttempts),
        loginWindowMinutes: Number(body?.loginWindowMinutes),
        loginLockoutMinutes: Number(body?.loginLockoutMinutes),
        passwordMinLength: Number(body?.passwordMinLength),
        passwordRequireUppercase: Boolean(body?.passwordRequireUppercase),
        passwordRequireLowercase: Boolean(body?.passwordRequireLowercase),
        passwordRequireNumber: Boolean(body?.passwordRequireNumber),
        passwordRequireSymbol: Boolean(body?.passwordRequireSymbol),
        mfaRequiredForAdmins: Boolean(body?.mfaRequiredForAdmins),
        mfaRequiredForNonAdmins: Boolean(body?.mfaRequiredForNonAdmins),
      });

      logAudit({
        timestamp: Date.now(),
        username: user.username,
        ip: deps.requestIP?.(req)?.address || "unknown",
        action: AuditAction.COMMAND,
        details: "Updated security settings",
        success: true,
      });

      return Response.json({ ok: true, security: updated }, { headers: deps.CORS_HEADERS });
    }
  }

  if (url.pathname === "/api/settings/tls") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      requirePermission(user, "system:tls");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    if (req.method === "GET") {
      return Response.json({ tls: getConfig().tls }, { headers: deps.CORS_HEADERS });
    }

    if (req.method === "PUT") {
      let body: any = {};
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }

      const updated = await updateTlsConfig({
        certPath: typeof body?.certPath === "string" ? body.certPath : undefined,
        keyPath: typeof body?.keyPath === "string" ? body.keyPath : undefined,
        caPath: typeof body?.caPath === "string" ? body.caPath : undefined,
        certbot: {
          enabled: Boolean(body?.certbot?.enabled),
          livePath: typeof body?.certbot?.livePath === "string" ? body.certbot.livePath : undefined,
          domain: typeof body?.certbot?.domain === "string" ? body.certbot.domain : undefined,
          certFileName:
            typeof body?.certbot?.certFileName === "string" ? body.certbot.certFileName : undefined,
          keyFileName:
            typeof body?.certbot?.keyFileName === "string" ? body.certbot.keyFileName : undefined,
          caFileName:
            typeof body?.certbot?.caFileName === "string" ? body.certbot.caFileName : undefined,
        },
      });

      logAudit({
        timestamp: Date.now(),
        username: user.username,
        ip: deps.requestIP?.(req)?.address || "unknown",
        action: AuditAction.COMMAND,
        details: "Updated TLS settings",
        success: true,
      });

      return Response.json({ ok: true, tls: updated }, { headers: deps.CORS_HEADERS });
    }
  }

  if (url.pathname === "/api/settings/oidc") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    try {
      requirePermission(user, "system:oidc");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    if (req.method === "GET") {
      return Response.json({ oidc: maskOidcSettings() }, { headers: deps.CORS_HEADERS });
    }

    if (req.method === "PUT") {
      let body: any = {};
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }

      const updated = await updateOidcConfig({
        enabled: Boolean(body?.enabled),
        label: typeof body?.label === "string" ? body.label : undefined,
        issuer: typeof body?.issuer === "string" ? body.issuer : undefined,
        clientId: typeof body?.clientId === "string" ? body.clientId : undefined,
        clientSecret: typeof body?.clientSecret === "string" && body.clientSecret.length > 0 ? body.clientSecret : undefined,
        redirectUri: typeof body?.redirectUri === "string" ? body.redirectUri : undefined,
        scopes: body?.scopes,
        clientAuthMethod: body?.clientAuthMethod,
        autoProvision: Boolean(body?.autoProvision),
        allowEmailLink: Boolean(body?.allowEmailLink),
        defaultRole: body?.defaultRole,
        allowedEmails: body?.allowedEmails,
        allowedDomains: body?.allowedDomains,
        groupClaim: typeof body?.groupClaim === "string" ? body.groupClaim : undefined,
        adminGroups: body?.adminGroups,
        operatorGroups: body?.operatorGroups,
        viewerGroups: body?.viewerGroups,
      });

      logAudit({
        timestamp: Date.now(),
        username: user.username,
        ip: deps.requestIP?.(req)?.address || "unknown",
        action: AuditAction.COMMAND,
        details: `Updated OIDC settings (enabled=${updated.enabled})`,
        success: true,
      });

      return Response.json({ ok: true, oidc: maskOidcSettings() }, { headers: deps.CORS_HEADERS });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/settings/tls/certbot/setup") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      requirePermission(user, "system:tls");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const domain = String(body?.domain || "").trim();
    const email = String(body?.email || "").trim();
    const livePath = String(body?.livePath || "/etc/letsencrypt/live").trim() || "/etc/letsencrypt/live";

    try {
      const result = await runCertbotSetup({ domain, email, livePath });

      const updated = await updateTlsConfig({
        certbot: {
          enabled: true,
          livePath,
          domain,
          certFileName: "fullchain.pem",
          keyFileName: "privkey.pem",
          caFileName: "chain.pem",
        },
      });

      logAudit({
        timestamp: Date.now(),
        username: user.username,
        ip: deps.requestIP?.(req)?.address || "unknown",
        action: AuditAction.COMMAND,
        details: `Ran certbot setup for domain ${domain}`,
        success: true,
      });

      return Response.json(
        {
          ok: true,
          tls: updated,
          certbot: {
            certPath: result.certPath,
            keyPath: result.keyPath,
            caPath: result.caPath,
            output: result.output,
          },
          message:
            "Certificate issued and certbot TLS mode enabled. Restart the server/container to load the new certificate.",
        },
        { headers: deps.CORS_HEADERS },
      );
    } catch (error: any) {
      logger.error("[TLS] certbot auto-setup failed", error);

      logAudit({
        timestamp: Date.now(),
        username: user.username,
        ip: deps.requestIP?.(req)?.address || "unknown",
        action: AuditAction.COMMAND,
        details: `Certbot setup failed for domain ${domain}`,
        success: false,
        errorMessage: String(error?.message || error),
      });

      return Response.json(
        {
          ok: false,
          error: String(error?.message || "Certbot setup failed"),
        },
        { status: 400, headers: deps.CORS_HEADERS },
      );
    }
  }

  if (req.method === "GET" && url.pathname === "/api/audit-logs") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    try {
      requirePermission(user, "audit:view");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    const page = Math.max(1, Number(url.searchParams.get("page") || 1));
    const pageSize = Math.max(1, Math.min(100, Number(url.searchParams.get("pageSize") || 50)));
    const targetClientId = (url.searchParams.get("clientId") || "").trim();
    const action = (url.searchParams.get("action") || "").trim();
    const actionsRaw = (url.searchParams.get("actions") || "").trim();
    const actions = actionsRaw
      ? actionsRaw
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : undefined;
    const startDate = Number(url.searchParams.get("startDate") || 0) || undefined;
    const endDate = Number(url.searchParams.get("endDate") || 0) || undefined;
    const successOnly = url.searchParams.get("successOnly") === "true";

    let allowedClientIds: string[] | undefined;
    let deniedClientIds: string[] | undefined;
    if (user.role !== "admin") {
      const scope = getUserClientAccessScope(user.userId);
      if (scope === "none") {
        return Response.json({ logs: [], total: 0, page, pageSize }, { headers: deps.CORS_HEADERS });
      }
      if (scope === "allowlist") {
        allowedClientIds = listUserClientRuleIdsByAccess(user.userId, "allow");
      } else if (scope === "denylist") {
        deniedClientIds = listUserClientRuleIdsByAccess(user.userId, "deny");
      }
    }

    const result = getAuditLogs({
      page,
      pageSize,
      targetClientId: targetClientId || undefined,
      action: action || undefined,
      actions,
      startDate,
      endDate,
      successOnly,
      allowedClientIds,
      deniedClientIds,
    });

    return Response.json(result, { headers: deps.CORS_HEADERS });
  }

  if (req.method === "GET" && url.pathname === "/api/proxy/list") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (user.role === "viewer") {
      return new Response("Forbidden", { status: 403 });
    }
    const proxies = getActiveProxies().filter((p) =>
      canUserAccessClient(user.userId, user.role, p.clientId),
    );
    return Response.json({ proxies }, { headers: deps.CORS_HEADERS });
  }

  if (req.method === "POST" && url.pathname === "/api/proxy/start") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (user.role === "viewer") {
      return new Response("Forbidden", { status: 403 });
    }
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, message: "Invalid JSON" }, { status: 400 });
    }
    const clientId = typeof body?.clientId === "string" ? body.clientId.trim() : "";
    const port = typeof body?.port === "number" ? Math.floor(body.port) : 0;
    if (!clientId) {
      return Response.json({ ok: false, message: "clientId is required" }, { status: 400 });
    }
    if (!canUserAccessClient(user.userId, user.role, clientId)) {
      return Response.json({ ok: false, message: "Forbidden: Client access denied" }, { status: 403 });
    }
    if (port < 1 || port > 65535) {
      return Response.json({ ok: false, message: "port must be 1-65535" }, { status: 400 });
    }
    const result = startProxy(clientId, port);
    logAudit({
      timestamp: Date.now(),
      username: user.username,
      ip: deps.requestIP?.(req)?.address || "unknown",
      action: AuditAction.COMMAND,
      details: `Started SOCKS5 proxy on port ${port} for client ${clientId}`,
      success: result.ok,
      errorMessage: result.ok ? undefined : result.message,
    });
    return Response.json(result, {
      status: result.ok ? 200 : 400,
      headers: deps.CORS_HEADERS,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/proxy/stop") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (user.role === "viewer") {
      return new Response("Forbidden", { status: 403 });
    }
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, message: "Invalid JSON" }, { status: 400 });
    }
    const port = typeof body?.port === "number" ? Math.floor(body.port) : 0;
    if (port < 1 || port > 65535) {
      return Response.json({ ok: false, message: "port must be 1-65535" }, { status: 400 });
    }
    const owner = getActiveProxies().find((p) => p.port === port);
    if (owner && !canUserAccessClient(user.userId, user.role, owner.clientId)) {
      return Response.json({ ok: false, message: "Forbidden: Client access denied" }, { status: 403 });
    }
    const result = stopProxy(port);
    logAudit({
      timestamp: Date.now(),
      username: user.username,
      ip: deps.requestIP?.(req)?.address || "unknown",
      action: AuditAction.COMMAND,
      details: `Stopped SOCKS5 proxy on port ${port}${owner ? ` (client ${owner.clientId})` : ""}`,
      success: result.ok,
      errorMessage: result.ok ? undefined : result.message,
    });
    return Response.json(result, {
      status: result.ok ? 200 : 400,
      headers: deps.CORS_HEADERS,
    });
  }

  if (req.method === "GET" && url.pathname === "/api/cert/info") {
    return Response.json(
      { source: deps.tlsSource || "unknown" },
      { headers: { "Content-Type": "application/json", ...deps.CORS_HEADERS } },
    );
  }

  if (req.method === "GET" && url.pathname === "/api/settings/export") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    try {
      requirePermission(user, "system:export-import");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    const exportData = getExportableConfig(deps.SERVER_VERSION);

    logAudit({
      timestamp: Date.now(),
      username: user.username,
      ip: deps.requestIP?.(req)?.address || "unknown",
      action: AuditAction.COMMAND,
      details: "Exported settings",
      success: true,
    });

    const dateStr = new Date().toISOString().slice(0, 10);
    return new Response(JSON.stringify(exportData, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="overlord-settings-${dateStr}.json"`,
        ...deps.CORS_HEADERS,
      },
    });
  }

  if (req.method === "POST" && url.pathname === "/api/settings/import") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    try {
      requirePermission(user, "system:export-import");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (!body || typeof body !== "object") {
      return Response.json({ error: "Expected a JSON object" }, { status: 400 });
    }

    try {
      const result = await importFullConfig(body);

      logAudit({
        timestamp: Date.now(),
        username: user.username,
        ip: deps.requestIP?.(req)?.address || "unknown",
        action: AuditAction.COMMAND,
        details: `Imported settings: ${result.applied.join(", ") || "none"}`,
        success: true,
      });

      return Response.json({ ok: true, applied: result.applied, warnings: result.warnings }, { headers: deps.CORS_HEADERS });
    } catch (error: any) {
      logAudit({
        timestamp: Date.now(),
        username: user.username,
        ip: deps.requestIP?.(req)?.address || "unknown",
        action: AuditAction.COMMAND,
        details: "Settings import failed",
        success: false,
        errorMessage: String(error?.message || error),
      });

      return Response.json({ ok: false, error: String(error?.message || "Import failed") }, { status: 400, headers: deps.CORS_HEADERS });
    }
  }

  if (url.pathname === "/api/settings/chat") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      requirePermission(user, "system:chat");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    if (req.method === "GET") {
      return Response.json({ chat: getConfig().chat }, { headers: deps.CORS_HEADERS });
    }

    if (req.method === "PUT") {
      let body: any = {};
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }

      const updated = await updateChatConfig({
        retentionDays: Number(body?.retentionDays),
      });

      logAudit({
        timestamp: Date.now(),
        username: user.username,
        ip: deps.requestIP?.(req)?.address || "unknown",
        action: AuditAction.COMMAND,
        details: `Updated chat settings: retention=${updated.retentionDays} days`,
        success: true,
      });

      return Response.json({ ok: true, chat: updated }, { headers: deps.CORS_HEADERS });
    }
  }

  if (url.pathname === "/api/settings/input-archive") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (req.method === "GET") {
      return Response.json(
        {
          myEnabled: getUserInputArchiveEnabled(user.userId),
          inputArchive: getConfig().inputArchive,
        },
        { headers: deps.CORS_HEADERS },
      );
    }

    if (req.method === "PUT") {
      let body: any = {};
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400, headers: deps.CORS_HEADERS });
      }

      if (body?.myEnabled !== undefined) {
        const result = setUserInputArchiveEnabled(user.userId, Boolean(body.myEnabled));
        if (!result.success) {
          return Response.json({ error: result.error || "Failed to save input archive preference" }, { status: 500, headers: deps.CORS_HEADERS });
        }
      }

      let updated = getConfig().inputArchive;
      if (body?.inputArchive !== undefined) {
        try {
          requirePermission(user, "system:input-archive");
        } catch (error) {
          if (error instanceof Response) return error;
          return new Response("Forbidden", { status: 403 });
        }

        updated = await updateInputArchiveConfig({
          enabled: body.inputArchive?.enabled !== undefined ? Boolean(body.inputArchive.enabled) : undefined,
          retentionDays: body.inputArchive?.retentionDays !== undefined ? Number(body.inputArchive.retentionDays) : undefined,
          maxFileBytes: body.inputArchive?.maxFileBytes !== undefined ? Number(body.inputArchive.maxFileBytes) : undefined,
          pollIntervalSeconds: body.inputArchive?.pollIntervalSeconds !== undefined ? Number(body.inputArchive.pollIntervalSeconds) : undefined,
        });

        logAudit({
          timestamp: Date.now(),
          username: user.username,
          ip: deps.requestIP?.(req)?.address || "unknown",
          action: AuditAction.COMMAND,
          details: `Updated input archive settings (enabled=${updated.enabled}, retention=${updated.retentionDays}d, poll=${updated.pollIntervalSeconds}s)`,
          success: true,
        });
      }

      return Response.json(
        {
          ok: true,
          myEnabled: getUserInputArchiveEnabled(user.userId),
          inputArchive: updated,
        },
        { headers: deps.CORS_HEADERS },
      );
    }
  }

  if (url.pathname === "/api/settings/appearance") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    try {
      requirePermission(user, "system:appearance");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    if (req.method === "GET") {
      const appearance = getConfig().appearance;
      return Response.json(
        {
          customCSS: appearance?.customCSS || "",
          loginBranding: appearance.loginBranding,
        },
        { headers: deps.CORS_HEADERS },
      );
    }

    if (req.method === "PUT") {
      let body: any = {};
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }

      const customCSS = typeof body?.customCSS === "string" ? body.customCSS : "";
      if (customCSS.length > 51200) {
        return Response.json({ error: "CSS exceeds 50 KB limit" }, { status: 400 });
      }
      const loginBranding =
        body?.loginBranding && typeof body.loginBranding === "object"
          ? body.loginBranding
          : undefined;

      const updated = await updateAppearanceConfig(customCSS, loginBranding);

      logAudit({
        timestamp: Date.now(),
        username: user.username,
        ip: deps.requestIP?.(req)?.address || "unknown",
        action: AuditAction.COMMAND,
        details: "Updated custom CSS",
        success: true,
      });

      return Response.json(
        { ok: true, customCSS: updated.customCSS, loginBranding: updated.loginBranding },
        { headers: deps.CORS_HEADERS },
      );
    }
  }

  if (req.method === "POST" && url.pathname === "/api/settings/appearance/image") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    try {
      requirePermission(user, "system:appearance");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return Response.json({ error: "Invalid upload form" }, { status: 400 });
    }

    const kind = String(form.get("kind") || "");
    if (!BRAND_IMAGE_KINDS.has(kind)) {
      return Response.json({ error: "Invalid branding image type" }, { status: 400 });
    }

    const file = form.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "Missing image file" }, { status: 400 });
    }
    if (file.size <= 0) {
      return Response.json({ error: "Image file is empty" }, { status: 400 });
    }
    if (file.size > BRAND_IMAGE_MAX_BYTES) {
      return Response.json({ error: "Image exceeds 5 MB limit" }, { status: 400 });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const image = detectBrandImage(bytes, file.type || "");
    if (!image) {
      return Response.json({ error: "Only PNG, JPEG, GIF, WebP, or ICO images are allowed" }, { status: 400 });
    }

    saveBrandingImage(kind, image.type, bytes);
    const assetUrl = `/api/branding/image/${kind}`;

    logAudit({
      timestamp: Date.now(),
      username: user.username,
      ip: deps.requestIP?.(req)?.address || "unknown",
      action: AuditAction.COMMAND,
      details: `Uploaded branding image (${kind}, ${bytes.length} bytes)`,
      success: true,
    });

    return Response.json(
      { ok: true, url: assetUrl, contentType: image.type, size: bytes.length },
      { headers: deps.CORS_HEADERS },
    );
  }

  if (req.method === "GET" && url.pathname === "/api/cert/download" && deps.tlsCertPath) {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }
    try {
      const file = Bun.file(deps.tlsCertPath);
      if (await file.exists()) {
        return new Response(file, {
          headers: {
            "Content-Type": "application/x-pem-file",
            "Content-Disposition": 'attachment; filename="overlord-ca.crt"',
            ...deps.CORS_HEADERS,
          },
        });
      }
    } catch { }
    return new Response("Certificate not available", { status: 404 });
  }

  // ── Registration settings (admin only) ──────────────────────────────
  if (url.pathname === "/api/settings/registration") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try { requirePermission(user, "system:registration"); } catch (error) { if (error instanceof Response) return error; return new Response("Forbidden", { status: 403 }); }

    if (req.method === "GET") {
      return Response.json({ registration: getConfig().registration }, { headers: deps.CORS_HEADERS });
    }

    if (req.method === "PUT") {
      let body: any = {};
      try { body = await req.json(); } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }

      const updated = await updateRegistrationConfig({
        mode: body?.mode,
        defaultRole: body?.defaultRole,
        maxUsersTotal: body?.maxUsersTotal !== undefined ? Number(body.maxUsersTotal) : undefined,
        defaultGroupIds: Array.isArray(body?.defaultGroupIds) ? body.defaultGroupIds : undefined,
      });

      logAudit({
        timestamp: Date.now(),
        username: user.username,
        ip: deps.requestIP?.(req)?.address || "unknown",
        action: AuditAction.COMMAND,
        details: `Updated registration settings (mode: ${updated.mode})`,
        success: true,
      });

      return Response.json({ ok: true, registration: updated }, { headers: deps.CORS_HEADERS });
    }
  }

  // ── Build rate limit settings (admin only) ──────────────────────────
  if (url.pathname === "/api/settings/build-rate-limit") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try { requirePermission(user, "system:build-limits"); } catch (error) { if (error instanceof Response) return error; return new Response("Forbidden", { status: 403 }); }

    if (req.method === "GET") {
      return Response.json({ buildRateLimit: getConfig().buildRateLimit }, { headers: deps.CORS_HEADERS });
    }

    if (req.method === "PUT") {
      let body: any = {};
      try { body = await req.json(); } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }

      const updated = await updateBuildRateLimitConfig({
        maxBuildsPerHour: body?.maxBuildsPerHour !== undefined ? Number(body.maxBuildsPerHour) : undefined,
        maxConcurrentPerUser: body?.maxConcurrentPerUser !== undefined ? Number(body.maxConcurrentPerUser) : undefined,
        globalMaxConcurrent: body?.globalMaxConcurrent !== undefined ? Number(body.globalMaxConcurrent) : undefined,
      });

      logAudit({
        timestamp: Date.now(),
        username: user.username,
        ip: deps.requestIP?.(req)?.address || "unknown",
        action: AuditAction.COMMAND,
        details: "Updated build rate limit settings",
        success: true,
      });

      return Response.json({ ok: true, buildRateLimit: updated }, { headers: deps.CORS_HEADERS });
    }
  }

  // ── Thumbnail toggles (GET: any user, PUT: admin only) ─────────────
  if (url.pathname === "/api/settings/thumbnails") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });

    if (req.method === "GET") {
      return Response.json({ thumbnails: getConfig().thumbnails }, { headers: deps.CORS_HEADERS });
    }

    if (req.method === "PUT") {
      try { requirePermission(user, "system:thumbnails"); } catch (error) { if (error instanceof Response) return error; return new Response("Forbidden", { status: 403 }); }

      let body: any = {};
      try { body = await req.json(); } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }

      const updated = await updateThumbnailsConfig({
        dashboardEnabled: body?.dashboardEnabled !== undefined ? Boolean(body.dashboardEnabled) : undefined,
        wallEnabled: body?.wallEnabled !== undefined ? Boolean(body.wallEnabled) : undefined,
      });

      logAudit({
        timestamp: Date.now(),
        username: user.username,
        ip: deps.requestIP?.(req)?.address || "unknown",
        action: AuditAction.COMMAND,
        details: `Updated thumbnail settings (dashboard=${updated.dashboardEnabled}, wall=${updated.wallEnabled})`,
        success: true,
      });

      return Response.json({ ok: true, thumbnails: updated }, { headers: deps.CORS_HEADERS });
    }
  }

  // GET /api/settings/health
  if (req.method === "GET" && url.pathname === "/api/settings/health") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try { requirePermission(user, "system:health"); } catch (error) { if (error instanceof Response) return error; return new Response("Forbidden", { status: 403 }); }

    const mem = process.memoryUsage();
    return Response.json({
      memory: {
        rss: mem.rss,
        heapTotal: mem.heapTotal,
        heapUsed: mem.heapUsed,
        external: mem.external,
        arrayBuffers: (mem as any).arrayBuffers ?? 0,
      },
      uptime: Math.floor(process.uptime()),
      components: {
        thumbnails: getThumbnailStats(),
        clients: {
          inMemory: getClientCount(),
          online: getOnlineClients().length,
        },
        database: {
          fileSizeBytes: getDatabaseFileSizeBytes(),
        },
      },
    });
  }

  // POST /api/settings/gc
  if (req.method === "POST" && url.pathname === "/api/settings/gc") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try { requirePermission(user, "system:health:manage"); } catch (error) { if (error instanceof Response) return error; return new Response("Forbidden", { status: 403 }); }

    const before = process.memoryUsage().heapUsed;
    if (typeof Bun !== "undefined" && typeof (Bun as any).gc === "function") {
      (Bun as any).gc(true);
    }
    const after = process.memoryUsage().heapUsed;
    return Response.json({ ok: true, freedBytes: Math.max(0, before - after) });
  }

  // POST /api/settings/profile
  if (req.method === "POST" && url.pathname === "/api/settings/profile") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try { requirePermission(user, "system:profiler"); } catch (error) { if (error instanceof Response) return error; return new Response("Forbidden", { status: 403 }); }

    if (activeServerProfile) {
      return Response.json({ error: "A server profile capture is already running." }, { status: 409 });
    }

    let body: any = {};
    try { body = await req.json(); } catch { body = {}; }
    const durationMs = clampProfileDuration(body?.durationMs);
    activeServerProfile = collectServerProfile(durationMs);
    try {
      const result = await activeServerProfile;
      logAudit({
        timestamp: Date.now(),
        username: user.username,
        ip: deps.requestIP?.(req)?.address || "unknown",
        action: AuditAction.COMMAND,
        details: `Captured server profile (${durationMs}ms)`,
        success: true,
      });
      return Response.json(result, { headers: deps.CORS_HEADERS });
    } finally {
      activeServerProfile = null;
    }
  }

  return null;
}
