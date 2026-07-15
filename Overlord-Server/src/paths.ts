import path from "path";
import { existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";

function assertSafeTestDataDir(dir: string): void {
  if (String(process.env.NODE_ENV || "").toLowerCase() !== "test") return;

  if (process.env.OVERLORD_TEST_DATA_DIR !== "1") {
    throw new Error(
      "Refusing to run tests without OVERLORD_TEST_DATA_DIR=1. Use `bun test` so test/preload.ts can create an isolated data directory.",
    );
  }

  const resolvedDir = path.resolve(dir);
  const resolvedTemp = path.resolve(tmpdir());
  const tempPrefix = `${resolvedTemp}${path.sep}`;
  const normalize = (value: string) =>
    process.platform === "win32" ? value.toLowerCase() : value;

  if (!normalize(resolvedDir).startsWith(normalize(tempPrefix))) {
    throw new Error(
      `Refusing to use non-temporary DATA_DIR while NODE_ENV=test: ${resolvedDir}`,
    );
  }
}

export function resolveDataDir(): string {
  const envDir = process.env.DATA_DIR;
  if (envDir && envDir.trim()) {
    assertSafeTestDataDir(envDir);
    return envDir;
  }

  if (String(process.env.NODE_ENV || "").toLowerCase() === "test") {
    throw new Error(
      "Refusing to use the default application data directory while NODE_ENV=test. Run tests through `bun test`.",
    );
  }

  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "Overlord");
  }

  return "./data";
}

export function ensureDataDir(): string {
  const dir = resolveDataDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}
