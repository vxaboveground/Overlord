import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";

test("creates isolated test data when the Bun preload was not discovered", async () => {
  const childEnv = { ...process.env };
  delete childEnv.DATA_DIR;
  delete childEnv.OVERLORD_TEST_DATA_DIR;
  childEnv.NODE_ENV = "test";
  // VS Code's Bun adapter injects inspector settings into the test process.
  // A child that inherits them can wait for the same debugger and never exit.
  delete childEnv.BUN_OPTIONS;
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith("BUN_INSPECT")) delete childEnv[key];
  }

  const child = Bun.spawn([
    process.execPath,
    "-e",
    'const { resolveDataDir } = await import("./src/paths.ts"); console.log(resolveDataDir());',
  ], {
    cwd: resolve(import.meta.dirname, ".."),
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect(exitCode, stderr).toBe(0);
  const dataDir = stdout.trim();
  expect(isAbsolute(dataDir)).toBe(true);
  expect(dataDir.toLowerCase().startsWith(resolve(tmpdir()).toLowerCase())).toBe(true);
  await rm(dataDir, { recursive: true, force: true });
});
