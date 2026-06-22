import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  arePluginNeedsApproved,
  compilePluginTypeScript,
  computePluginNeedsHash,
  loadPluginBundle,
  type PluginState,
} from "./plugin-state-bundle";

let tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "overlord-plugin-bundle-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots = [];
});

describe("loadPluginBundle", () => {
  test("matches plugin binaries when clients report a pretty Windows OS name", async () => {
    const root = await createTempRoot();
    const pluginDir = join(root, "sample-c");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "manifest.json"),
      JSON.stringify({
        id: "sample-c",
        name: "sample-c",
        binaries: { "windows-amd64": "sample-c-windows-amd64.dll" },
      }),
    );
    await writeFile(join(pluginDir, "sample-c-windows-amd64.dll"), "test-binary");

    const bundle = await loadPluginBundle(root, "sample-c", async () => {}, "Windows 11 Pro 24H2", "amd64");

    expect(bundle.binaryPath).toBe(join(pluginDir, "sample-c-windows-amd64.dll"));
    expect(bundle.size).toBe("test-binary".length);
  });

  test("loads wasm manifest independently of client platform", async () => {
    const root = await createTempRoot();
    const pluginDir = join(root, "wasm-demo");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "plugin.wasm"), Buffer.from([0x00, 0x61, 0x73, 0x6d]));
    await writeFile(
      join(pluginDir, "manifest.json"),
      JSON.stringify({
        id: "wasm-demo",
        name: "WASM Demo",
        apiVersion: 2,
        runtime: "wasm",
        wasm: "plugin.wasm",
        needs: { files: [{ bucket: "downloads", access: ["list", "read"], reason: "Import files" }] },
      }),
    );

    const bundle = await loadPluginBundle(root, "wasm-demo", async () => {}, "Windows 11", "amd64");

    expect(bundle.manifest.apiVersion).toBe(2);
    expect(bundle.manifest.runtime).toBe("wasm");
    expect(bundle.manifest.wasm).toBe("plugin.wasm");
    expect(bundle.binaryPath).toBe(join(root, "wasm-demo", "plugin.wasm"));
    expect(bundle.size).toBe(4);
  });

  test("computes stable need hashes and invalidates changed approvals", () => {
    const state: PluginState = {
      enabled: {},
      lastError: {},
      autoLoad: {},
      autoStartEvents: {},
      approvedNeeds: {},
    };
    const needs = { files: [{ bucket: "downloads", access: ["read", "list"] }] };
    const sameNeedsDifferentOrder = { files: [{ bucket: "downloads", access: ["list", "read"] }] };
    const changedNeeds = { files: [{ bucket: "downloads", access: ["read", "write"] }] };
    const hash = computePluginNeedsHash(needs);

    expect(hash).toBe(computePluginNeedsHash(sameNeedsDifferentOrder));
    expect(hash).not.toBe(computePluginNeedsHash(changedNeeds));
    expect(arePluginNeedsApproved(state, "demo", needs)).toBe(false);
    state.approvedNeeds.demo = hash;
    expect(arePluginNeedsApproved(state, "demo", sameNeedsDifferentOrder)).toBe(true);
    expect(arePluginNeedsApproved(state, "demo", changedNeeds)).toBe(false);
  });

  test("compiles TypeScript entrypoints with local imports", async () => {
    const root = await createTempRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "shared.ts"), "export const message = 'hello-ts';\n");
    await writeFile(join(root, "src", "ui.ts"), "import { message } from './shared'; document.body.dataset.sample = message;\n");
    await writeFile(join(root, "src", "server.ts"), "import { message } from './shared'; export default { rpc: { ping() { return { message }; } } };\n");
    await compilePluginTypeScript(join(root, "src", "ui.ts"), join(root, "assets", "sample-ts.js"), "browser", "sample-ts");
    await compilePluginTypeScript(join(root, "src", "server.ts"), join(root, "server.js"), "bun", "sample-ts");

    const uiJs = await readFile(join(root, "assets", "sample-ts.js"), "utf-8");
    const serverJs = await readFile(join(root, "server.js"), "utf-8");
    expect(uiJs).toContain("hello-ts");
    expect(serverJs).toContain("hello-ts");
  });
});
