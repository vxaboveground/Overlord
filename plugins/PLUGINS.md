# Overlord Plugins

This document explains how to build Overlord plugins using the **native plugin system**. Plugins run as native shared libraries (`.so` on Linux, `.dylib` on macOS, in-memory DLL on Windows), giving them full access to system APIs.

Plugins can be written in **any language** that can produce a C-ABI shared library: **Go**, **C**, **C++**, **Rust**, or anything else that compiles to native code.

> TL;DR: A plugin is a zip with platform-specific binaries (`.so`/`.dll`/`.dylib`) plus `<id>.html`, `<id>.css`, `<id>.js`. Upload it in the Plugins page or drop it in Overlord-Server/plugins.

## 1) How plugins are structured

### Required bundle format

A plugin bundle is a zip file named after the plugin ID:

```
<pluginId>.zip
```

Inside the zip (root level), you need:

- **Platform-specific binaries** named `<pluginId>-<os>-<arch>.<ext>`
- **Web assets**: `<pluginId>.html`, `<pluginId>.css`, `<pluginId>.js`

Example for plugin ID `sample`:

```
sample.zip
  ├─ sample-linux-amd64.so
  ├─ sample-linux-arm64.so
  ├─ sample-darwin-arm64.dylib
  ├─ sample-windows-amd64.dll
  ├─ sample.html
  ├─ sample.css
  └─ sample.js
```

When the server extracts the zip:

```
Overlord-Server/plugins/sample/
  ├─ sample-linux-amd64.so
  ├─ sample-linux-arm64.so
  ├─ sample-darwin-arm64.dylib
  ├─ sample-windows-amd64.dll
  ├─ manifest.json          (auto-generated)
  └─ assets/
     ├─ sample.html
     ├─ sample.css
     └─ sample.js
```

### Architecture validation

The server matches binaries to clients by OS and architecture. Binary filenames **must** follow the naming convention `<pluginId>-<os>-<arch>.<ext>`:

| OS       | Arch    | Example filename             |
|----------|---------|------------------------------|
| windows  | amd64   | `sample-windows-amd64.dll`   |
| windows  | arm64   | `sample-windows-arm64.dll`   |
| linux    | amd64   | `sample-linux-amd64.so`      |
| linux    | arm64   | `sample-linux-arm64.so`      |
| darwin   | amd64   | `sample-darwin-amd64.dylib`  |
| darwin   | arm64   | `sample-darwin-arm64.dylib`  |

The server will **never** send an x64 binary to an ARM client (or vice versa). If no binary matches the client's platform, loading is skipped with an error.

### Manifest fields

The auto-generated manifest:

```json
{
  "id": "sample",
  "name": "sample",
  "version": "1.0.0",
  "binaries": {
    "linux-amd64": "sample-linux-amd64.so",
    "linux-arm64": "sample-linux-arm64.so",
    "darwin-arm64": "sample-darwin-arm64.dylib",
    "windows-amd64": "sample-windows-amd64.dll"
  },
  "entry": "sample.html",
  "assets": {
    "html": "sample.html",
    "css": "sample.css",
    "js": "sample.js"
  }
}
```

## 2) Plugin ABI (all languages)

Every plugin — regardless of language — must export **C-callable functions** with specific signatures. The ABI differs slightly between Windows and Unix.

### Required exports

| Export             | Signature (Windows)                                                   | Signature (Linux / macOS)                                                         | Required |
|--------------------|-----------------------------------------------------------------------|-----------------------------------------------------------------------------------|----------|
| `PluginOnLoad`     | `int PluginOnLoad(char* hostInfo, int hostInfoLen, uint64 callback)`  | `int PluginOnLoad(char* hostInfo, int hostInfoLen, uintptr callback, uintptr ctx)` | Yes      |
| `PluginOnEvent`    | `int PluginOnEvent(char* event, int eventLen, char* payload, int payloadLen)` | same                                                                      | Yes      |
| `PluginOnUnload`   | `void PluginOnUnload()`                                               | same                                                                              | Yes      |
| `PluginSetCallback`| `void PluginSetCallback(uint64 callback)`                             | —                                                                                 | Windows only |
| `PluginGetRuntime` | `const char* PluginGetRuntime()`                                      | same                                                                              | Recommended  |

### Host callback

The host passes a callback function pointer during `PluginOnLoad`. The plugin uses it to send events back to the agent.

**Windows** — The callback is a `__stdcall` function:

```c
void __stdcall callback(const char *event, uintptr_t eventLen,
                        const char *payload, uintptr_t payloadLen);
```

**Linux / macOS** — The callback is a standard C function with an opaque context pointer:

```c
void callback(uintptr_t ctx,
              const char *event, int eventLen,
              const char *payload, int payloadLen);
```

The `ctx` value received in `PluginOnLoad` must be passed back as the first argument to every callback invocation.

### PluginGetRuntime (runtime detection)

If a plugin exports `PluginGetRuntime`, the host calls it after loading. It must return a pointer to a static, null-terminated string identifying the runtime:

| Return value | Meaning                               |
|-------------|---------------------------------------|
| `"c"`       | Pure C plugin — fully unloadable      |
| `"cpp"`     | C++ plugin — fully unloadable         |
| `"rust"`    | Rust plugin — fully unloadable        |
| *(absent)*  | Defaults to `"go"` — **not** freed    |

This matters because **Go plugins cannot be fully unloaded** due to [golang/go#11100](https://github.com/golang/go/issues/11100) — Go's runtime spawns threads that cannot be stopped, so calling `FreeLibrary`/`dlclose` on a Go shared library causes a crash. The host uses this information to skip freeing Go plugins while properly reclaiming memory for C/C++/Rust plugins.

The runtime is logged on load and unload:
```
[plugins] loaded plugin "sample-c" (runtime=c, freeable=true)
[plugins] unloaded plugin "sample-c" — memory freed
[plugins] unloaded plugin "sample-go" — memory leaked (go runtime)
```

### HostInfo JSON

The `hostInfo` buffer passed to `PluginOnLoad` is JSON:

```json
{
  "clientId": "abc123",
  "os": "windows",
  "arch": "amd64",
  "version": "1.0.0"
}
```

### Loading mechanism

- **Windows** — DLLs are loaded **entirely in memory** via a custom PE loader. No files are written to disk. This is why Rust's `std::sync::Mutex` (backed by `SRWLOCK`) may not initialize correctly — see the Rust section below.
- **Linux** — Shared libraries are loaded in memory via `memfd_create` + `dlopen` on `/proc/self/fd/`. No files touch disk.
- **macOS** — Shared libraries are written to a temp file, `dlopen`'d, then the temp file is deleted.

## 3) Sample plugins by language

### Go (`sample-go/`)

Go plugins use `-buildmode=c-shared` with platform-specific export wrappers.

**Project structure:**
```
sample-go/native/
  ├─ main.go              (shared core logic)
  ├─ exports_unix.go      (exports for Linux/macOS)
  ├─ exports_windows.go   (exports for Windows)
  └─ go.mod
```

**Linux / macOS exports:**
```go
//export PluginOnLoad
func PluginOnLoad(hostInfo *C.char, hostInfoLen C.int, cb C.uintptr_t, ctx C.uintptr_t) C.int

//export PluginOnEvent
func PluginOnEvent(event *C.char, eventLen C.int, payload *C.char, payloadLen C.int) C.int

//export PluginOnUnload
func PluginOnUnload()
```

**Windows exports:**
```go
//export PluginOnLoad
func PluginOnLoad(hostInfo *C.char, hostInfoLen C.int, callbackPtr C.ulonglong) C.int

//export PluginOnEvent
func PluginOnEvent(event *C.char, eventLen C.int, payload *C.char, payloadLen C.int) C.int

//export PluginOnUnload
func PluginOnUnload()

//export PluginSetCallback
func PluginSetCallback(callbackPtr C.ulonglong)
```

**Build:**
```bash
CGO_ENABLED=1 go build -buildmode=c-shared -o sample-windows-amd64.dll ./native
```

> **Note:** Go plugins do **not** export `PluginGetRuntime` and default to the `"go"` runtime. They are intentionally never freed on unload to prevent crashes from orphaned Go runtime threads.

---

### C (`sample-c/`)

Pure C plugins are the simplest — no runtime, no GC, fully unloadable.

**Project structure:**
```
sample-c/
  ├─ native/plugin.c
  ├─ sample-c.html
  ├─ sample-c.css
  └─ sample-c.js
```

**Key points:**
- Uses `__declspec(dllexport)` on Windows, `__attribute__((visibility("default")))` on Unix
- Has a `DllMain` entry point on Windows (receives `DLL_PROCESS_ATTACH` / `DLL_PROCESS_DETACH`)
- Exports `PluginGetRuntime` → returns `"c"`
- No heap allocations required — can use stack buffers for all responses

**Minimal example (Windows callback):**
```c
#ifdef _WIN32
typedef void (__stdcall *host_callback_t)(
    const char *event, uintptr_t eventLen,
    const char *payload, uintptr_t payloadLen);
#else
typedef void (*host_callback_t)(
    uintptr_t ctx,
    const char *event, int eventLen,
    const char *payload, int payloadLen);
#endif

static host_callback_t g_callback;

EXPORT int PluginOnLoad(const char *hostInfo, int hostInfoLen, ...) {
    // Parse hostInfo JSON, store callback, return 0 on success
}

EXPORT int PluginOnEvent(const char *event, int eventLen,
                         const char *payload, int payloadLen) {
    // Handle events, call g_callback() to respond
    return 0;
}

EXPORT void PluginOnUnload(void) {
    // Cleanup
}

EXPORT const char *PluginGetRuntime(void) { return "c"; }
```

**Build:**
```bash
# MSVC
cl /LD /O2 plugin.c /Fe:sample-c-windows-amd64.dll

# MinGW / gcc
gcc -shared -O2 -o sample-c-windows-amd64.dll plugin.c

# Linux
gcc -shared -fPIC -O2 -o sample-c-linux-amd64.so plugin.c
```

---

### C++ (`sample-cpp/`)

C++ plugins can use the full standard library (STL containers, `std::mutex`, `std::string`, etc.) while still being fully unloadable.

**Project structure:**
```
sample-cpp/
  ├─ native/plugin.cpp
  ├─ sample-cpp.html
  ├─ sample-cpp.css
  └─ sample-cpp.js
```

**Key points:**
- All exports wrapped in `extern "C"` to prevent name mangling
- Can freely use `std::string`, `std::unordered_map`, `std::mutex`, etc.
- Exports `PluginGetRuntime` → returns `"cpp"`

**Build:**
```bash
# MSVC
cl /LD /EHsc /O2 plugin.cpp /Fe:sample-cpp-windows-amd64.dll

# MinGW / g++
g++ -shared -O2 -o sample-cpp-windows-amd64.dll plugin.cpp

# Linux
g++ -shared -fPIC -O2 -o sample-cpp-linux-amd64.so plugin.cpp
```

---

### Rust (`sample-rust/`)

Rust plugins compile as `cdylib` crates. Exports use `#[no_mangle]` and `extern "C"`.

**Project structure:**
```
sample-rust/
  ├─ native/
  │   ├─ Cargo.toml
  │   └─ src/lib.rs
  ├─ sample-rust.html
  ├─ sample-rust.css
  └─ sample-rust.js
```

**Key points:**
- `crate-type = ["cdylib"]` in Cargo.toml
- Uses `extern "stdcall"` for the callback type on Windows, `extern "C"` on Unix
- Exports `PluginGetRuntime` → returns `"rust"`

**⚠️ Important: avoid `std::sync::Mutex` on Windows.** Because the DLL is loaded via an in-memory PE loader (not `LoadLibrary`), Rust's standard `Mutex` (backed by Windows `SRWLOCK`) may not initialize correctly, causing an access violation. Use C-style `static mut` globals instead — this is safe because the Go host serializes all calls through its own mutex.

**Cargo.toml:**
```toml
[lib]
crate-type = ["cdylib"]

[profile.release]
opt-level = "z"
lto = true
strip = true
```

**Build:**
```bash
# Native
cargo build --release

# Cross-compile
cargo build --release --target=x86_64-pc-windows-msvc
cargo build --release --target=aarch64-unknown-linux-gnu
```

## 4) Build scripts & cross-compilation

Each language has `.bat` (Windows) and `.sh` (Unix) build scripts. All scripts support the `BUILD_TARGETS` environment variable to compile for multiple platforms in one invocation.

### Available build scripts

| Language | Windows                  | Unix                    |
|----------|--------------------------|-------------------------|
| Go       | `build-plugin.bat`       | `build-plugin.sh`       |
| C        | `build-plugin-c.bat`     | `build-plugin-c.sh`     |
| C++      | `build-plugin-cpp.bat`   | `build-plugin-cpp.sh`   |
| Rust     | `build-plugin-rust.bat`  | `build-plugin-rust.sh`  |

### Usage

All scripts default to building for the host platform only:

```bash
# Build for current platform
./build-plugin-c.sh

# Build for multiple targets
BUILD_TARGETS="linux-amd64 linux-arm64 windows-amd64" ./build-plugin-c.sh

# Custom plugin directory
./build-plugin-c.sh /path/to/my-plugin
```

```bat
REM Build for current platform
build-plugin-c.bat

REM Build for multiple targets
set BUILD_TARGETS=windows-amd64 windows-arm64
build-plugin-c.bat

REM Custom plugin directory
build-plugin-c.bat C:\path\to\my-plugin
```

### Cross-compilation

**Go** — Cross-compilation is built-in via `GOOS` / `GOARCH` env vars. No extra toolchains needed (unless CGo calls platform-specific APIs).

**Rust** — Cross-compilation uses `--target=` with Rust target triples. Install targets with `rustup target add <triple>`. The build scripts map `os-arch` pairs to triples automatically:

| Target          | Rust triple (`.bat` / MSVC)         | Rust triple (`.sh` / GNU)             |
|-----------------|-------------------------------------|---------------------------------------|
| windows-amd64   | `x86_64-pc-windows-msvc`           | `x86_64-pc-windows-gnu`              |
| windows-arm64   | `aarch64-pc-windows-msvc`          | `aarch64-pc-windows-gnullvm`         |
| linux-amd64     | `x86_64-unknown-linux-gnu`         | `x86_64-unknown-linux-gnu`           |
| linux-arm64     | `aarch64-unknown-linux-gnu`        | `aarch64-unknown-linux-gnu`          |
| darwin-amd64    | `x86_64-apple-darwin`              | `x86_64-apple-darwin`                |
| darwin-arm64    | `aarch64-apple-darwin`             | `aarch64-apple-darwin`               |

**C / C++** — Cross-compilation requires the appropriate cross-compiler toolchain to be installed:

| Target          | C compiler                    | C++ compiler                   |
|-----------------|-------------------------------|--------------------------------|
| linux-amd64     | `x86_64-linux-gnu-gcc`        | `x86_64-linux-gnu-g++`         |
| linux-arm64     | `aarch64-linux-gnu-gcc`       | `aarch64-linux-gnu-g++`        |
| linux-arm       | `arm-linux-gnueabihf-gcc`     | `arm-linux-gnueabihf-g++`      |
| windows-amd64   | `x86_64-w64-mingw32-gcc`      | `x86_64-w64-mingw32-g++`       |
| windows-arm64   | `aarch64-w64-mingw32-gcc`     | `aarch64-w64-mingw32-g++`      |

On Windows `.bat` scripts, MSVC (`cl`) is tried first with the appropriate `/link /machine:` flag, falling back to MinGW if `cl` fails.

On Unix `.sh` scripts, override the compiler with `CC=<compiler>` (C) or `CXX=<compiler>` (C++):

```bash
CC=zig-cc BUILD_TARGETS="linux-arm64" ./build-plugin-c.sh
CXX=zig-c++ BUILD_TARGETS="linux-arm64" ./build-plugin-cpp.sh
```

### Installing cross-compiler toolchains

**Debian/Ubuntu:**
```bash
# ARM64 Linux cross-compilers
sudo apt install gcc-aarch64-linux-gnu g++-aarch64-linux-gnu

# Windows cross-compilers (MinGW)
sudo apt install gcc-mingw-w64-x86-64 g++-mingw-w64-x86-64

# Rust targets
rustup target add aarch64-unknown-linux-gnu x86_64-pc-windows-gnu
```

**macOS (Homebrew):**
```bash
# Linux cross-compilers via musl-cross
brew install FiloSottile/musl-cross/musl-cross

# Rust targets
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

## 5) Install & open a plugin

### Install / upload

- Use the UI at `/plugins` to upload the zip
- Or drop `<pluginId>.zip` into `Overlord-Server/plugins` and restart

### Open the UI

Plugin UI is embedded directly in the main page at:

```
/plugins/<pluginId>?clientId=<CLIENT_ID>
```

The server reads your `<pluginId>.html`, extracts the body content, and renders it inside the standard Overlord layout. Your CSS and JS are loaded from `/plugins/<pluginId>/assets/`.

To get the `clientId` in your JS:

```js
const clientId = new URLSearchParams(window.location.search).get("clientId");
```

## 6) Runtime: how events flow

Overlord plugins have **two parts**:

1. **UI (HTML/CSS/JS)** — Runs in the browser, calls server APIs.
2. **Native module** — Runs in the agent (client) process as a loaded shared library.

### UI → agent (plugin event)

From your UI JS:

```
POST /api/clients/<clientId>/plugins/<pluginId>/event
{
  "event": "ui_message",
  "payload": { "message": "hello" }
}
```

If the plugin is not loaded yet, the server will load it on the client, queue the event, and deliver it once ready.

### Agent → plugin (direct function call)

The agent calls your `OnEvent(event, payload)` function directly with JSON-encoded data. No stdin/stdout pipes, no msgpack — just a direct function call.

### Plugin → agent (callback)

Your plugin sends events back to the host using the callback received during `OnLoad`:

**Go:**
```go
send("echo", []byte(`{"message":"hello back"}`))
```

**C / C++:**
```c
g_callback("echo", 4, "{\"message\":\"hello back\"}", 24);
```

**Rust:**
```rust
let event = b"echo";
let payload = b"{\"message\":\"hello back\"}";
(g_callback)(event.as_ptr(), event.len(), payload.as_ptr(), payload.len());
```

On Windows, the callback uses `__stdcall` calling convention. On Unix, it's a standard C call with the context pointer as the first argument.

### Plugin lifecycle events

The agent sends these events to the server:

- `loaded` on successful load
- `unloaded` when unloaded
- `error` if load or runtime fails

## 7) What can plugins do?

Since plugins run as native code, they can:

- Call any system API (file I/O, network, processes, etc.)
- Use any library available to their language
- Spawn threads / goroutines
- Access hardware
- Do anything a normal native program can do

Plugins have the same capabilities as the agent itself.

| Language | Can be fully unloaded? | Runtime overhead |
|----------|----------------------|------------------|
| C        | Yes                  | None             |
| C++      | Yes                  | Minimal (STL)    |
| Rust     | Yes                  | Minimal          |
| Go       | **No** ([#11100](https://github.com/golang/go/issues/11100)) | Go runtime + GC  |

### UI embedding

Plugin UI pages are embedded **directly** into the main Overlord page — no iframe, no sandbox, no bridge. The server reads your plugin's HTML, extracts the `<body>` content and any `<link>`/`<style>` tags from the `<head>`, and injects them into the standard page layout (with nav bar, Tailwind CSS, etc.).

Your plugin JS runs in the same browsing context as the main UI, so `fetch()` calls to the API work directly — no special bridge or proxy needed.

Plugin assets (CSS, JS, images) are served from `/plugins/<pluginId>/assets/`.

## 8) API surface

### Plugin management

- `GET /api/plugins` — list installed plugins (includes `autoLoad` and `autoStartEvents` per plugin)
- `POST /api/plugins/upload` — upload zip
- `POST /api/plugins/<id>/enable` — enable/disable
- `POST /api/plugins/<id>/autoload` — configure auto-load on client connect
- `DELETE /api/plugins/<id>` — remove (preserves `data/` directory)

### Plugin data directory

- `GET /api/plugins/<id>/data` — list files in the plugin's persistent data directory
- `GET /api/plugins/<id>/data/<path>` — read a file
- `PUT /api/plugins/<id>/data/<path>` — write a file
- `DELETE /api/plugins/<id>/data/<path>` — delete a file or directory
- `POST /api/plugins/<id>/exec` — execute a stored binary (admin/operator only)

See [section 10](#10-server-side-plugin-data-directory) for full details.

### Per-client plugin runtime

- `POST /api/clients/<clientId>/plugins/<pluginId>/load`
- `POST /api/clients/<clientId>/plugins/<pluginId>/event`
- `POST /api/clients/<clientId>/plugins/<pluginId>/unload`

### Useful built-in endpoints

- `POST /api/clients/<clientId>/command`
- `WS /api/clients/<clientId>/rd/ws` (remote desktop)
- `WS /api/clients/<clientId>/console/ws`
- `WS /api/clients/<clientId>/files/ws`
- `WS /api/clients/<clientId>/processes/ws`

## 9) Auto-load plugins on client connect

By default, plugins are only loaded when manually triggered via the API or UI. For plugins that need to run 24/7 on every connected client (e.g. clipboard monitoring, keylogging, persistence), you can configure **auto-load**.

When auto-load is enabled for a plugin, the server will automatically load it onto every client that connects. If the client already has the plugin loaded, it's skipped — no duplicate loads.

You can also configure **auto-start events** — a list of events that are queued and delivered to the plugin immediately after it loads. This lets you pre-configure the plugin without any manual interaction.

### Enable auto-load

```
POST /api/plugins/<pluginId>/autoload
Content-Type: application/json

{
  "autoLoad": true
}
```

### Enable auto-load with auto-start events

```
POST /api/plugins/<pluginId>/autoload
Content-Type: application/json

{
  "autoLoad": true,
  "autoStartEvents": [
    { "event": "add_rule", "payload": { "pattern": "^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$", "replacement": "your-btc-address" } },
    { "event": "start", "payload": {} }
  ]
}
```

The events in `autoStartEvents` are queued in order and delivered to the plugin after it reports `loaded`. This works exactly like calling the event API multiple times, but happens automatically.

### Disable auto-load

```
POST /api/plugins/<pluginId>/autoload
Content-Type: application/json

{
  "autoLoad": false
}
```

### How it works

1. Client connects and completes the enrollment handshake
2. Server sends `hello_ack` (as usual)
3. Server dispatches auto-scripts (as usual)
4. Server checks all plugins with `autoLoad: true` and `enabled: true`
5. For each, if the plugin is **not already loaded** on that client:
   - Sends the plugin binary bundle (chunked)
   - Queues any `autoStartEvents`
6. When the plugin reports `loaded`, queued events are flushed in order

### Checking auto-load status

`GET /api/plugins` returns `autoLoad` and `autoStartEvents` for each plugin:

```json
{
  "plugins": [
    {
      "id": "clipreplace",
      "name": "clipreplace",
      "enabled": true,
      "autoLoad": true,
      "autoStartEvents": [
        { "event": "add_rule", "payload": { "pattern": "...", "replacement": "..." } },
        { "event": "start", "payload": {} }
      ],
      "lastError": ""
    }
  ]
}
```

### Notes

- Auto-load respects the `enabled` flag — disabled plugins are never auto-loaded
- Auto-load state is persisted in `.plugin-state.json` and survives server restarts
- Deleting a plugin also removes its auto-load configuration
- The server selects the correct binary for each client's OS/architecture automatically
- If a plugin binary isn't available for a client's platform, the auto-load silently skips that client

## 10) Server-side plugin data directory

Each plugin has a **persistent data directory** on the server:

```
Overlord-Server/plugins/<pluginId>/data/
```

This directory is **never deleted** when a plugin is removed or reinstalled. It survives the entire plugin lifecycle and gives server-side plugins a dedicated place to store files — SQLite databases, config files, cached data, executables, etc.

### Read/write files

From your plugin UI JS (or any authenticated API consumer):

**List all files**
```
GET /api/plugins/<pluginId>/data
```
```json
{
  "ok": true,
  "files": [
    { "path": "config.json", "size": 128, "isDir": false },
    { "path": "cache", "size": 0, "isDir": true },
    { "path": "cache/data.db", "size": 40960, "isDir": false }
  ]
}
```

**Read a file**
```
GET /api/plugins/<pluginId>/data/<path>
```
Returns the raw file bytes with an appropriate `Content-Type`.

**Write a file**
```
PUT /api/plugins/<pluginId>/data/<path>
Content-Type: application/octet-stream
<raw bytes>
```
Parent directories are created automatically.
```json
{ "ok": true, "path": "config.json", "size": 128 }
```

**Delete a file or directory**
```
DELETE /api/plugins/<pluginId>/data/<path>
```
Deleting a directory removes it recursively.
```json
{ "ok": true, "path": "cache" }
```

### Execute a stored binary

Plugins can store executables in their data directory and run them on the server. This endpoint is restricted to **admin and operator** roles.

```
POST /api/plugins/<pluginId>/exec
Content-Type: application/json

{
  "file": "mytool",
  "args": ["--flag", "value"],
  "stdin": "optional stdin string",
  "timeoutMs": 10000
}
```

| Field | Type | Description |
|-------|------|-------------|
| `file` | string | Path to the binary, relative to the plugin's `data/` directory |
| `args` | string[] | Command-line arguments (optional) |
| `stdin` | string | Text to pipe to stdin (optional) |
| `timeoutMs` | number | Max run time in ms, max 60000, default 30000 |

```json
{
  "ok": true,
  "exitCode": 0,
  "stdout": "tool output here",
  "stderr": ""
}
```

The binary is run from the `data/` directory as the working directory. The server sets the executable bit automatically before running on Unix.

### Example: storing a SQLite database from plugin JS

```js
// Write a new database seed file
await fetch(`/api/plugins/myplugin/data/app.db`, {
  method: "PUT",
  body: dbBytes, // ArrayBuffer
});

// Read it back
const res = await fetch(`/api/plugins/myplugin/data/app.db`);
const db = await res.arrayBuffer();

// List all stored files
const { files } = await (await fetch(`/api/plugins/myplugin/data`)).json();
```

### Notes

- Path traversal is blocked — paths may not escape the `data/` directory
- Null bytes in paths are rejected
- The data directory is created automatically on first use (no pre-setup needed)
- Deleting and reinstalling a plugin leaves `data/` untouched

---

## Plugin Signing

Plugins can be cryptographically signed with Ed25519 keys. The server verifies signatures on upload and displays trust status in the dashboard. Loading unsigned or untrusted plugins requires explicit confirmation.

### Trust Levels

| Status | Badge | Behavior |
|--------|-------|----------|
| **Signed + Trusted** | Green shield | Loads immediately |
| **Signed + Untrusted** | Yellow shield | Must type "confirm" to load |
| **Unsigned** | Orange shield | Must type "confirm" to load |
| **Invalid Signature** | Red shield | Blocked — cannot load |

### Generate a Signing Key

```bash
cd Overlord-Server
bun run scripts/plugin-keygen.ts --out my-signing-key
```

This creates:
- `my-signing-key.key` — private key (keep secret!)
- `my-signing-key.pub` — public key + fingerprint

The fingerprint (64-char hex SHA-256) is printed to the console. Add it to your server config to trust plugins signed with this key.

### Sign a Plugin

```bash
cd Overlord-Server
bun run scripts/plugin-sign.ts --key my-signing-key.key ../plugins/sample-go/sample.zip
```

This injects a `signature.json` into the ZIP containing the Ed25519 public key and signature.

### Add a Trusted Key

**Via config.json:**
```json
{
  "plugins": {
    "trustedKeys": [
      "a1b2c3d4e5f6...64-char-hex-fingerprint..."
    ]
  }
}
```

**Via environment variable:**
```
TRUSTED_PLUGIN_KEYS=fingerprint1,fingerprint2
```

**Via the web UI:** Go to the Plugins page → Trusted Signing Keys section → paste the fingerprint and click Add Key.

**Via API:**
```bash
# Add a trusted key
curl -X POST /api/plugins/trusted-keys \
  -H "Content-Type: application/json" \
  -d '{"fingerprint": "a1b2c3..."}'

# List trusted keys
curl /api/plugins/trusted-keys

# Remove a trusted key
curl -X DELETE /api/plugins/trusted-keys/a1b2c3...
```

### Build Script Integration

Set the `PLUGIN_SIGN_KEY` environment variable to automatically sign plugins during build:

```bash
# Unix
PLUGIN_SIGN_KEY=path/to/my-signing-key.key ./build-plugin.sh

# Windows
set PLUGIN_SIGN_KEY=path\to\my-signing-key.key
build-plugin.bat
```

### How Signing Works

1. The canonical content digest is computed by hashing every file in the ZIP (excluding `signature.json`), sorting filenames alphabetically, and concatenating `filename:sha256hex\n` for each
2. The digest is signed with Ed25519 using the private key
3. The signature, public key, and algorithm are stored as `signature.json` inside the ZIP
4. On upload, the server extracts `signature.json`, recomputes the digest, and verifies the signature using `crypto.subtle.verify("Ed25519", ...)`
5. The signer's fingerprint (`hex(SHA-256(raw_public_key))`) is compared against `plugins.trustedKeys` in the config


