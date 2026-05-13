# Overlord Desktop

A native desktop (fat) client for the Overlord server, built with [Tauri 2](https://tauri.app) (Rust backend + system webview).

## Features

- Native desktop window with a connection screen for the operator
- Remembers your last server address across launches
- TLS toggle for connecting to HTTPS or HTTP servers
- Accepts self-signed certificates (Windows / WebView2 via `--ignore-certificate-errors`)
- `window.open` from the web UI (audio, console, HVNC, etc.) opens native popup windows that inherit the parent's session
- Cross-platform (macOS, Windows, Linux)

## Prerequisites

- [Rust](https://rustup.rs) (stable toolchain)
- [Bun](https://bun.sh) (to run the Tauri CLI and vendor script)
- Platform deps for Tauri — see https://tauri.app/start/prerequisites/
  - **Windows:** Microsoft Edge WebView2 (preinstalled on Windows 11)
  - **macOS:** Xcode CLT
  - **Linux:** `webkit2gtk-4.1`, `libayatana-appindicator3-dev`, `librsvg2-dev`

## Quick Start

```bash
cd Overlord-Desktop
bun install
bun run vendor         # copy Inter + Font Awesome into src/vendor/
bun run start          # tauri dev
```

The first `start` will compile the Rust backend (slow on first run; cached afterwards).

## Building for Distribution

Before building, generate icons from a 1024x1024 PNG (only needed once):

```bash
bun run tauri icon path/to/icon.png
```

Then:

```bash
bun run build:win      # Windows NSIS installer
bun run build:mac      # macOS DMG
bun run build:linux    # Linux AppImage
```

Or from the repo root: `./build-desktop.sh` (or `build-desktop.bat` on Windows) picks the right target for the current OS.

Output lands in `src-tauri/target/release/bundle/`. The CI workflow in `.github/workflows/desktop-release.yml` builds the Windows NSIS installer on every push to `main` that touches `Overlord-Desktop/` and publishes it as a GitHub Release tagged `Overlord-Desktop-v<version>`.

## Configuration

On first connect, the app saves your connection to the Tauri config dir:

- **Windows:** `%APPDATA%\com.overlord.desktop\connection.json`
- **macOS:** `~/Library/Application Support/com.overlord.desktop/connection.json`
- **Linux:** `~/.config/com.overlord.desktop/connection.json`

Defaults: port **5173**, TLS **enabled**.

## Notes

- **Self-signed certs:** handled via WebView2's `--ignore-certificate-errors` flag (Windows). On macOS/Linux the system webview does not currently expose an equivalent flag through Tauri's config — issue a trusted cert (e.g. mkcert / Let's Encrypt) for production use on those platforms.
- **Popups:** `window.open` calls from the web UI (audio, console, HVNC, etc.) are caught by Tauri's `on_new_window` handler and turned into real WebView2 popups. This is intentional — it's the only way the popup webview inherits the parent's auth cookie (which is `SameSite=Strict`).
- **Footprint:** ~10 MB installer vs. ~80 MB for an Electron equivalent.

## Project Layout

```
Overlord-Desktop/
├── package.json              # Tauri CLI + vendor deps
├── scripts/vendor.ts         # copies Inter + Font Awesome into src/vendor/
├── src/                      # frontend (HTML/CSS/JS) — the connect screen
│   ├── index.html
│   ├── style.css
│   └── renderer.js
└── src-tauri/                # Rust backend
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── capabilities/default.json
    ├── permissions/app-commands.toml
    └── src/{main,lib}.rs     # IPC commands + on_new_window popup handler
```
