import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { ensureDataDir } from "../paths";

const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const UPLOAD_TTL_MS = 60 * 60 * 1000;
const ID_RE = /^[0-9a-f-]{36}$/i;

type UploadMetadata = {
  id: string;
  userId: number;
  filename: string;
  size: number;
  createdAt: number;
  claimed: boolean;
};

export type ClaimedMacosSdk = UploadMetadata & { archivePath: string; uploadDir: string };

function uploadRoot(): string {
  return path.join(ensureDataDir(), "macos-sdk-uploads");
}

function safeArchiveName(value: string): string {
  const decoded = (() => { try { return decodeURIComponent(value); } catch { return value; } })();
  return path.basename(decoded).replace(/[^A-Za-z0-9._+-]/g, "_").slice(0, 160) || "MacOSX.sdk.tar.xz";
}

function supportedArchive(name: string): boolean {
  return /\.(?:tar|tar\.gz|tgz|tar\.xz|txz)$/i.test(name);
}

function readMetadata(dir: string): UploadMetadata | null {
  try { return JSON.parse(fs.readFileSync(path.join(dir, "metadata.json"), "utf8")); } catch { return null; }
}

export function purgeExpiredMacosSdkUploads(now = Date.now()): void {
  const root = uploadRoot();
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    const metadata = readMetadata(dir);
    if (!metadata || (!metadata.claimed && now - metadata.createdAt > UPLOAD_TTL_MS)) {
      try { fs.rmdirSync(dir, { recursive: true }); } catch {}
    }
  }
}

export async function stageMacosSdkUpload(req: Request, userId: number): Promise<UploadMetadata> {
  purgeExpiredMacosSdkUploads();
  if (req.headers.get("x-overlord-sdk-rights") !== "confirmed") {
    throw new Error("You must confirm that you have the right to use the uploaded macOS SDK");
  }
  const filename = safeArchiveName(req.headers.get("x-overlord-filename") || "");
  if (!supportedArchive(filename)) {
    throw new Error("SDK must be a .tar, .tar.gz, .tgz, .tar.xz, or .txz archive");
  }
  const declaredSize = Number(req.headers.get("content-length") || 0);
  if (declaredSize > MAX_ARCHIVE_BYTES) throw new Error("SDK archive exceeds the 1 GB limit");
  if (!req.body) throw new Error("SDK archive is empty");

  const id = uuidv4();
  const dir = path.join(uploadRoot(), id);
  const archivePath = path.join(dir, filename);
  fs.mkdirSync(dir, { recursive: true });
  const writer = fs.createWriteStream(archivePath, { flags: "wx", mode: 0o600 });
  let size = 0;
  try {
    const reader = req.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ARCHIVE_BYTES) throw new Error("SDK archive exceeds the 1 GB limit");
      if (!writer.write(Buffer.from(value))) await new Promise<void>((resolve) => writer.once("drain", resolve));
    }
    await new Promise<void>((resolve, reject) => writer.end((err?: Error | null) => err ? reject(err) : resolve()));
    if (size === 0) throw new Error("SDK archive is empty");
    const metadata: UploadMetadata = { id, userId, filename, size, createdAt: Date.now(), claimed: false };
    fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify(metadata), { mode: 0o600 });
    return metadata;
  } catch (error) {
    writer.destroy();
    try { fs.rmdirSync(dir, { recursive: true }); } catch {}
    throw error;
  }
}

export function claimMacosSdkUpload(id: unknown, userId: number): ClaimedMacosSdk {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new Error("A valid macOS SDK upload is required");
  const dir = path.join(uploadRoot(), id);
  const metadata = readMetadata(dir);
  if (!metadata || metadata.id !== id || metadata.userId !== userId || metadata.claimed) {
    throw new Error("macOS SDK upload was not found, expired, or has already been used");
  }
  if (Date.now() - metadata.createdAt > UPLOAD_TTL_MS) {
    try { fs.rmdirSync(dir, { recursive: true }); } catch {}
    throw new Error("macOS SDK upload expired; please upload it again");
  }
  metadata.claimed = true;
  fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify(metadata), { mode: 0o600 });
  return { ...metadata, archivePath: path.join(dir, metadata.filename), uploadDir: dir };
}

function archiveEntryIsSafe(entry: string): boolean {
  const normalized = entry.trim().replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return false;
  return !normalized.split("/").some((part) => part === "..");
}

async function run(command: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function findSdkRoot(root: string): string | null {
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const current = queue.shift()!;
    const frameworks = path.join(current.dir, "System", "Library", "Frameworks");
    const usr = path.join(current.dir, "usr");
    if (fs.existsSync(frameworks) && fs.existsSync(usr)) return current.dir;
    if (current.depth >= 3) continue;
    for (const entry of fs.readdirSync(current.dir, { withFileTypes: true })) {
      if (entry.isDirectory()) queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }
  return null;
}

export async function extractAndValidateMacosSdk(claim: ClaimedMacosSdk): Promise<string> {
  const extractDir = path.join(claim.uploadDir, "extracted");
  fs.mkdirSync(extractDir, { recursive: true });
  const listing = await run(["tar", "-tf", claim.archivePath]);
  if (listing.exitCode !== 0) throw new Error(`Unable to read macOS SDK archive: ${listing.stderr.trim()}`);
  const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
  if (!entries.length || entries.some((entry) => !archiveEntryIsSafe(entry))) {
    throw new Error("macOS SDK archive contains an unsafe or invalid path");
  }
  const extracted = await run(["tar", "-xf", claim.archivePath, "-C", extractDir, "--no-same-owner", "--no-same-permissions"]);
  if (extracted.exitCode !== 0) throw new Error(`Unable to extract macOS SDK archive: ${extracted.stderr.trim()}`);
  const realRoot = fs.realpathSync(extractDir);
  const verifyLinks = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const item = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(item);
        const lexicalTarget = path.resolve(path.dirname(item), target);
        if (path.isAbsolute(target) || (lexicalTarget !== realRoot && !lexicalTarget.startsWith(realRoot + path.sep))) {
          throw new Error("macOS SDK archive contains a symlink outside the SDK");
        }
        try {
          const resolved = fs.realpathSync(item);
          if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) {
            throw new Error("macOS SDK archive contains a symlink outside the SDK");
          }
        } catch (error: any) {
          if (error?.message?.includes("outside the SDK")) throw error;
          // SDK archives can contain intentionally dangling relative compatibility links.
        }
      } else if (entry.isDirectory()) verifyLinks(item);
    }
  };
  verifyLinks(extractDir);
  const sdkRoot = findSdkRoot(extractDir);
  if (!sdkRoot) throw new Error("Archive does not contain a macOS SDK (expected System/Library/Frameworks and usr)");
  return sdkRoot;
}

export function cleanupMacosSdkUpload(uploadDir: string | undefined): void {
  if (!uploadDir) return;
  const resolved = path.resolve(uploadDir);
  const root = path.resolve(uploadRoot());
  if (path.dirname(resolved) !== root) return;
  try { fs.rmdirSync(resolved, { recursive: true }); } catch {}
}
