/**
 * In-app update checker.
 *
 * - Queries the GHCR (GitHub Container Registry) OCI API for available image
 *   tags of ghcr.io/vxaboveground/overlord and compares the latest semver tag
 *   to SERVER_VERSION.
 * - Writes/reads trigger and status files in the data directory so the host-side
 *   updater daemon can pick up requests and report progress.
 */

import { resolve } from "path";
import { ensureDataDir } from "../paths";
import { logger } from "../logger";

const dataDir = ensureDataDir();

const UPDATE_REQUEST_FILE = resolve(dataDir, "update-request.json");
const UPDATE_STATUS_FILE = resolve(dataDir, "update-status.json");

const GHCR_IMAGE = "vxaboveground/overlord";

// ---- Semver helpers ----

export function parseVersion(v: string): [number, number, number] | null {
  const m = v.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Returns true when `remote` is strictly newer than `local`. */
export function isNewerVersion(local: string, remote: string): boolean {
  const l = parseVersion(local);
  const r = parseVersion(remote);
  if (!l || !r) return false;
  for (let i = 0; i < 3; i++) {
    if (r[i] > l[i]) return true;
    if (r[i] < l[i]) return false;
  }
  return false;
}

// ---- GHCR registry check ----

export type UpdateCheckResult = {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string;
};

/**
 * Fetches an anonymous bearer token from ghcr.io for the public image.
 */
async function getGhcrToken(): Promise<string> {
  const url = `https://ghcr.io/token?scope=repository:${GHCR_IMAGE}:pull`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Overlord-Update-Checker" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GHCR token request failed ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new Error("GHCR token response missing token field");
  return data.token;
}

/**
 * Lists all tags for the image from the OCI distribution API.
 */
async function listGhcrTags(token: string): Promise<string[]> {
  const url = `https://ghcr.io/v2/${GHCR_IMAGE}/tags/list`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Overlord-Update-Checker",
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GHCR tags list failed ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { tags?: string[] };
  return data.tags || [];
}

/**
 * Finds the highest semver tag from a list of tag strings.
 */
export function findHighestSemverTag(tags: string[]): string | null {
  let best: [number, number, number] | null = null;
  let bestRaw = "";

  for (const tag of tags) {
    const parsed = parseVersion(tag);
    if (!parsed) continue;
    if (
      !best ||
      parsed[0] > best[0] ||
      (parsed[0] === best[0] && parsed[1] > best[1]) ||
      (parsed[0] === best[0] && parsed[1] === best[1] && parsed[2] > best[2])
    ) {
      best = parsed;
      bestRaw = tag.replace(/^v/, "");
    }
  }

  return bestRaw || null;
}

/**
 * Queries the GHCR OCI registry for the latest semver image tag and compares
 * it to the current running version.
 */
export async function checkForUpdate(currentVersion: string): Promise<UpdateCheckResult> {
  const token = await getGhcrToken();
  const tags = await listGhcrTags(token);

  const latestTag = findHighestSemverTag(tags);
  if (!latestTag) {
    logger.warn("[update] No semver tags found on GHCR");
    return {
      updateAvailable: false,
      currentVersion,
      latestVersion: currentVersion,
    };
  }

  const updateAvailable = isNewerVersion(currentVersion, latestTag);

  return {
    updateAvailable,
    currentVersion,
    latestVersion: latestTag,
  };
}

// ---- Trigger / status file helpers ----

export type UpdateRequest = {
  requestedAt: number;
  requestedBy: string;
  targetVersion: string;
};

export type UpdateStatus = {
  state: "idle" | "pending" | "pulling" | "restarting" | "done" | "error";
  message: string;
  progress: number; // 0-100
  updatedAt: number;
  targetVersion?: string;
  log?: string[];
};

const DEFAULT_STATUS: UpdateStatus = {
  state: "idle",
  message: "No update in progress.",
  progress: 0,
  updatedAt: 0,
};

export async function clearUpdateStatus(): Promise<void> {
  try {
    const { unlink } = await import("fs/promises");
    await unlink(UPDATE_STATUS_FILE);
  } catch {
    // File may not exist — that's fine
  }
}

export async function writeUpdateRequest(req: UpdateRequest): Promise<void> {
  await Bun.write(UPDATE_REQUEST_FILE, JSON.stringify(req, null, 2));
  logger.info(`[update] Update request written for version ${req.targetVersion}`);
}

export async function readUpdateStatus(): Promise<UpdateStatus> {
  try {
    const file = Bun.file(UPDATE_STATUS_FILE);
    if (!(await file.exists())) return { ...DEFAULT_STATUS };
    const text = await file.text();
    const data = JSON.parse(text);
    return {
      state: data.state || "idle",
      message: data.message || "",
      progress: Number(data.progress) || 0,
      updatedAt: Number(data.updatedAt) || 0,
      targetVersion: data.targetVersion,
      log: Array.isArray(data.log) ? data.log : undefined,
    };
  } catch {
    return { ...DEFAULT_STATUS };
  }
}

/** Check whether a pending request file exists that hasn't been picked up yet. */
export async function hasPendingRequest(): Promise<boolean> {
  try {
    const file = Bun.file(UPDATE_REQUEST_FILE);
    return await file.exists();
  } catch {
    return false;
  }
}
