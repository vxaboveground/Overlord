import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "overlord-bun-test-"));
writeFileSync(join(dataDir, "config.json"), "{}\n", "utf8");

const child = Bun.spawn(["bun", "test", "src", ...process.argv.slice(2)], {
  cwd: import.meta.dirname + "/..",
  env: {
    ...process.env,
    NODE_ENV: "test",
    DATA_DIR: dataDir,
    OVERLORD_TEST_DATA_DIR: "1",
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

const exitCode = await child.exited;

// Cleanup happens in the parent after Bun Test and every SQLite connection it
// owns have exited, which avoids Windows EBUSY errors from open database files.
rmSync(dataDir, { recursive: true, force: true });
process.exit(exitCode);
