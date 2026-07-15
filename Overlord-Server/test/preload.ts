import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const suppliedDataDir =
  process.env.OVERLORD_TEST_DATA_DIR === "1" && process.env.DATA_DIR?.trim()
    ? process.env.DATA_DIR
    : undefined;
const testDataDir = suppliedDataDir ?? mkdtempSync(join(tmpdir(), "overlord-bun-test-"));

// These must be set before any application module imports config or opens the
// singleton SQLite connection.
process.env.NODE_ENV = "test";
process.env.DATA_DIR = testDataDir;
process.env.OVERLORD_TEST_DATA_DIR = "1";

// A persistent config in DATA_DIR prevents the loader from falling back to the
// repository's legacy config.json, which may contain real deployment settings.
writeFileSync(join(testDataDir, "config.json"), "{}\n", "utf8");
