# Server-Side Plugins

Server-side plugins run inside the Overlord server process environment. They are for global plugin pages, persistent server data, RPC-backed tools, build pipeline customization, uploads, artifact replacement, signing, or internal release workflows.

They are trusted code. A server-side plugin has normal server filesystem and network access, so treat it like part of the program itself. Use plugin signing and only install code you trust.

## Server-Only Plugins

Set `runtime: "server"` in `config.json`:

```json
{
  "name": "Internal Builder",
  "version": "1.0.0",
  "apiVersion": 2,
  "runtime": "server",
  "description": "Adds custom build buttons and upload hooks."
}
```

Server-only plugins:

| Behavior | Notes |
|----------|-------|
| Plugin Manager look | Shown as server extensions, with worker/build-plugin state where available. |
| Client loading | Never sent to agents. |
| Auto-load | Hidden and unavailable because there is no per-client agent module. |
| Build access | Can hook the builder when `server.js` or `src/server.ts` exports build handlers. |

## Lifecycle

If a bundle includes `server.js` or compiled `src/server.ts`, the server starts one worker for the plugin when the plugin is enabled.

```js
export default {
  async setup(ctx) {
    ctx.log.info("server plugin started");
  },

  async onEvent(ctx, event) {
    ctx.log.info(`plugin event from ${event.clientId}`);
  },

  rpc: {
    async list(ctx, params) {
      return ctx.db.query("select * from items").all();
    },
  },

  async teardown(ctx) {
    ctx.log.info("server plugin stopping");
  },
};
```

## The `ctx` Object

| Field | Description |
|-------|-------------|
| `ctx.pluginId` | Sanitized plugin ID. |
| `ctx.db` | `bun:sqlite` database backed by `plugins/<id>/data/plugin.db`; WAL mode is enabled. |
| `ctx.dataDir` | Absolute path to the plugin's persistent `data/` directory. |
| `ctx.log` | `{ debug, info, warn, error }` forwarded to the server logger as `[plugin:<id>] ...`. |
| `ctx.broadcast(channel, data)` | Sends JSON-serializable data to every UI subscribed to this plugin's SSE stream. |

## Persistent Data

Each plugin owns:

```text
Overlord-Server/plugins/<id>/data/
```

The directory is created automatically and is not removed when a plugin is reinstalled or deleted. Use it for SQLite state, cached files, generated artifacts, helper binaries, or plugin-local configuration.

The server also exposes plugin data APIs for listing, reading, writing, deleting, and running files in that directory. Execution endpoints are restricted to admin/operator roles.

## UI RPC And Broadcasts

Browser UI code can call plugin RPC methods:

```js
const res = await fetch(`/api/plugins/my-plugin/rpc`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ method: "list", params: {} }),
});
const { ok, result, error } = await res.json();
```

Subscribe to server broadcasts:

```js
const stream = new EventSource(`/api/plugins/my-plugin/stream`);
stream.addEventListener("changed", (event) => {
  const payload = JSON.parse(event.data);
  console.log(payload);
});
```

RPC calls require `clients:control`, time out after 30 seconds, and must target a method exported in the plugin's `rpc` map. SSE streams also require `clients:control`.

### Trusted Requests

Server-side plugin code, including build hooks, can make trusted outbound requests with `ctx.fetch(url, options)`. These requests run from the Overlord server process and are not subject to browser CORS.

Browser plugin UI is still normal browser JavaScript. If a plugin page needs to call an API that does not allow browser CORS, call the same-origin proxy instead:

```js
const res = await fetch("/api/plugins/my-plugin/proxy", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    url: "https://example.internal/api/releases",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: { buildId: "abc123" },
  }),
});
```

The proxy requires the signed-in user to have access to that plugin. It only proxies `http:` and `https:` URLs.

## Build Hooks

Server-side plugins can hook the agent builder without shipping agent code. Browser UI is never called from the build process; only `server.js` or compiled `src/server.ts` participates.

```js
export default {
  onBuildPrepare(ctx, payload) {
    return { config: { outputName: "custom-agent" } };
  },

  onBuildTarget(ctx, payload) {
    if (payload.platform === "linux-amd64") {
      return {
        env: { CGO_ENABLED: "0" },
        addTags: ["my_feature"],
        ldflagsAppend: "-X overlord-client/cmd/agent/config.PluginChannel=stable",
        message: "linux-amd64 template patched",
      };
    }
  },

  buildHooks: {
    before_donut(ctx, payload) {
      ctx.log.info(`Donut input: ${payload.file.filename}`);
    },
    after_donut(ctx, payload) {
      ctx.log.info(`Donut output: ${payload.file.filename}`);
    },
    before_sgn(ctx, payload) {
      ctx.log.info(`SGN iterations: ${payload.iterations}`);
    },
    after_sgn(ctx, payload) {
      ctx.log.info(`SGN output: ${payload.file.filename}`);
    },
  },

  async onBuildArtifact(ctx, payload) {
    ctx.log.info(`artifact ready: ${payload.file.path}`);
    return { message: `saw ${payload.file.filename}` };
  },

  async onBuildComplete(ctx, payload) {
    ctx.log.info(`build ${payload.buildId} produced ${payload.files.length} files`);
  },

  onBuildFailed(ctx, payload) {
    ctx.log.warn(`build failed: ${payload.error}`);
  },
};
```

`onBuildTarget` can return:

| Field | Effect |
|-------|--------|
| `env` | Merges string values into the Go build environment. |
| `ldflags` | Replaces the full `-ldflags` string. |
| `ldflagsAppend` | Appends to the existing `-ldflags` string. |
| `tags` | Replaces the full build tag list. |
| `addTags` / `removeTags` | Adds or removes build tags. |
| `outputName` | Renames the target output file after server sanitization. |
| `skip: true` | Skips that target. |
| `message` / `messages` | Writes informational lines into the build stream. |

## Transform Hook Stages

Implement transform hooks either in `buildHooks` with the snake-case name, or as a named method such as `onBuildBeforeDonut`.

| Hook | Named method | When it runs |
|------|--------------|--------------|
| `post_build` | `onBuildPostBuild` | After the raw Go build output exists. |
| `before_upx` / `after_upx` | `onBuildBeforeUpx` / `onBuildAfterUpx` | Around UPX compression. |
| `before_script_wrapper` / `after_script_wrapper` | `onBuildBeforeScriptWrapper` / `onBuildAfterScriptWrapper` | Around `.bat`, `.cmd`, and `.ps1` wrapping. |
| `before_ipa` / `after_ipa` | `onBuildBeforeIpa` / `onBuildAfterIpa` | Around iOS IPA packaging. |
| `before_donut` / `after_donut` | `onBuildBeforeDonut` / `onBuildAfterDonut` | Around Windows PE to shellcode conversion with Donut. |
| `before_linux_shellcode` / `after_linux_shellcode` | `onBuildBeforeLinuxShellcode` / `onBuildAfterLinuxShellcode` | Around Linux ELF shellcode wrapping. |
| `before_sgn` / `after_sgn` | `onBuildBeforeSgn` / `onBuildAfterSgn` | Around SGN shellcode encoding. |
| `before_sgn_txt` / `after_sgn_txt` | `onBuildBeforeSgnTxt` / `onBuildAfterSgnTxt` | Around SGN TXT artifact conversion. |

Transform hook payloads include:

| Field | Description |
|-------|-------------|
| `buildId` | Current build ID. |
| `platform`, `os`, `arch`, `targetKey` | Target identity. |
| `outDir`, `clientDir` | Build output and client source directories. |
| `config` | Full build config, including selected build plugins. |
| `file` | `{ filename, path, platform, size }` for the current artifact. |

Some stages include extra fields such as `outputFilename`, `outputPath`, `donutArch`, `shellcodeArch`, or `iterations`.

## Artifact Replacement And Uploads

`onBuildArtifact` receives `payload.file` with:

```js
{
  name,
  filename,
  path,
  platform,
  version,
  size,
}
```

Return `file: { filename }` to replace the downloadable build artifact with another file already inside `dist-clients`, or return `files: [...]` to add extra downloadable artifacts from `dist-clients`.

Paths outside the build output directory are ignored for downloadable metadata, but the hook can still upload, copy, sign, or publish files itself because server-side plugins run with normal server privileges.

## Build Plugin Settings, Buttons, And Requirements

Declare builder UI in `config.json`:

```json
{
  "runtime": "server",
  "build": {
    "label": "Uploader",
    "description": "Uploads completed builds to an internal bucket.",
    "enabledByDefault": true,
    "settings": [
      {
        "key": "bucket",
        "label": "Bucket",
        "type": "string",
        "required": true,
        "placeholder": "release-builds"
      },
      {
        "key": "publish",
        "label": "Publish after build",
        "type": "boolean",
        "default": false
      }
    ],
    "actions": [
      {
        "id": "shellcode-release",
        "label": "Shellcode Release",
        "icon": "fa-solid fa-fire",
        "setBuild": { "useDonut": true, "useSgn": true },
        "setSettings": { "publish": true }
      }
    ],
    "requires": [
      {
        "field": "useSgn",
        "truthy": true,
        "message": "Uploader release mode requires SGN to be enabled."
      }
    ]
  }
}
```

Supported setting types are `string`, `textarea`, `number`, `boolean`, and `select`.

Build profiles save these values and send them to hooks as:

```js
payload.config.buildPlugins[ctx.pluginId] // { enabled, settings }
```

Buttons in `build.actions` can set core builder fields through `setBuild` and plugin fields through `setSettings`. Requirements can check:

| Requirement field | Meaning |
|-------------------|---------|
| `field` | Core build field such as `useSgn` or `useDonut`. |
| `pluginSetting` | Setting from this plugin's build settings. |
| `platforms` | Selected build platforms. |

See `plugins/sample-build-hooks` for a minimal server-only build plugin with its own build button and artifact replacement.

## RBAC And Build Plugin Access

Build-hook plugins use the normal per-user plugin access policy. Admins can open a user in the Users page, choose Plugin Access, and set one of these modes:

| Mode | Effect |
|------|--------|
| No Access | The user cannot open plugin pages or use build plugins. |
| Selected Plugins | The user can only open and use checked plugins. |
| All Plugins | The user can use every enabled plugin. |

For build plugins this means:

| Path | Enforcement |
|------|-------------|
| Build page plugin list | `/api/build/plugins` only returns build plugins the user can access. |
| Build start | Inaccessible build plugin settings are ignored server-side, so a user cannot invoke a hidden build hook by editing the request. |
| Plugin RPC/UI/assets | Plugin pages, assets, RPC, and SSE streams require access to that plugin. |

Users still need `clients:build` to build at all. Plugin access is the second gate that decides which build-hook plugins they can see and use.

## Caveats

| Caveat | Detail |
|--------|--------|
| Worker trust | Workers are not a security sandbox. They can access server files/network with normal server permissions. |
| One worker per plugin | RPC calls into the same plugin serialize; long calls block other RPCs for that plugin. |
| SQLite | Each plugin gets a separate DB. Avoid opening the same DB from another process. |
| Worker crash | Crashes are logged and `pluginState.lastError` is set; disable and re-enable the plugin to restart it. |
| Bundled builds | The production build emits both the main server bundle and `src/server/plugin-runtime/worker-host.ts`. |
