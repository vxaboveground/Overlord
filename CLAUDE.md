# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Overlord** is an authorized red-team C2 (command & control) framework consisting of:
- **Overlord-Server**: TypeScript/Bun web server + REST API + WebSocket C2 (port 5173)
- **Overlord-Client**: Go agent deployed on target systems
- **Overlord-Desktop**: Tauri 2 fat client for operators (Rust backend + system webview)
- **Plugin System**: Native plugins (C, C++, Rust, Go) with optional server-side JS

HVNC, keylogging, screen/audio capture, and persistence mechanisms are intentional, authorized features.

## Commands

### Server (Overlord-Server) — runtime: Bun
```bash
cd Overlord-Server
bun run dev               # Start with hot reload
bun run start             # Run from src/index.ts
bun run build             # Build + minify CSS + vendor assets
bun run build:prod:win    # Compile Windows standalone executable
bun run build:prod:linux  # Compile Linux standalone executable
bun run build:css         # Compile Tailwind CSS
bun run watch:css         # Watch CSS changes
bun test ./src            # Run all tests (*.test.ts)
```

### Client (Overlord-Client) — runtime: Go
```bash
cd Overlord-Client
go test ./...             # Run all tests
go build ./cmd/agent      # Build agent binary
```

### Desktop (Overlord-Desktop) — runtime: Tauri 2 (Rust + system webview)
```bash
cd Overlord-Desktop
bun install
bun run vendor            # one-time: copy Inter + Font Awesome into src/vendor/
bun run start             # Dev: tauri dev
bun run build:win         # Windows NSIS installer
bun run build:mac         # macOS DMG
bun run build:linux       # Linux AppImage
```
Output lands in `Overlord-Desktop/src-tauri/target/release/bundle/`.

### Docker
```bash
# Linux (host networking)
docker compose up -d
docker compose up --build -d

# Windows/macOS Docker Desktop
docker compose -f docker-compose.windows.yml up -d
```

### Agent & DLL Builds (from repo root)
```bash
./build-clients.sh        # Cross-compile all agent targets
./build-hvnc-dll.sh       # Build HVNC injection DLL (C++)
./build-hvnc-capture-dll.sh
./build-desktop.sh        # Build Tauri desktop app
```

### Dev helpers (from repo root)
```bash
./start-dev.sh            # Start server (bg) + client (fg)
./generate-certs.sh       # Generate self-signed TLS certs
```

## Architecture

### Communication Flow
```
Agent (Go)  <--wss WebSocket-->  Server (Bun/Node)  <--HTTP/WS-->  Web UI / Desktop (Tauri)
```
- Agent connects to `wss://server:5173/ws` using MsgPack-encoded `WireMessage`
- Server fans out to operator web UI and Desktop app via separate WebSocket sessions
- REST API handles auth, builds, file downloads, plugin management

### Server Subsystems (`Overlord-Server/src/`)
| File/Dir | Role |
|---|---|
| `index.ts` → `main-server.ts` | Entry: HTTP + WebSocket server init |
| `protocol.ts` | Wire protocol types (`WireMessage`, `PluginManifest`) |
| `db.ts` | SQLite operations (users, clients, builds, audit, files) |
| `auth.ts` / `rbac.ts` | JWT auth + role-based access (admin/user/viewer) |
| `wsHandlers.ts` / `wsValidation.ts` | Dispatch + validate incoming WS messages |
| `server/ws-console-rd-hvnc.ts` | Console / RDP / HVNC streaming |
| `server/ws-desktop-audio.ts` | Audio capture streaming |
| `server/ws-file-process-proxy-keylogger.ts` | File, process, keylog WS handlers |
| `server/build-process.ts` | On-demand agent compilation |
| `server/toolchain-manager.ts` | Downloads cross-compile toolchains (mingw, NDK, UPX, ldid) |
| `server/plugin-state-bundle.ts` | ZIP extraction + plugin loading |
| `server/plugin-runtime/` | Isolated per-plugin Node.js VM with private SQLite |
| `server/auto-script-dispatch.ts` | Run scripts automatically on agent connection |
| `server/routes/` | HTTP endpoint handlers (auth, build, client, plugin, file) |

### Client Packages (`Overlord-Client/cmd/agent/`)
| Package | Role |
|---|---|
| `session.go` | Main `runClient()` loop, reconnect logic |
| `transport/` | WebSocket client (`nhooyr.io/websocket`), auto-reconnect |
| `wire/` | MsgPack encode/decode for `WireMessage` |
| `handlers/` | File ops, process mgmt (Windows & Unix build tags) |
| `capture/` | Screen & audio capture |
| `console/` | Shell execution (cmd/bash/PowerShell via PTY) |
| `keylogger/` | Keystroke capture |
| `plugins/` | In-memory native plugin loader (PE loader / memfd / dylib) |
| `persistence/` | Registry + startup folder persistence |
| `criticalproc/` | Critical process protection (Windows) |
| `mutex/` | Single-instance lock |

### Plugin System
- **Bundle**: ZIP containing platform binaries (`<id>-{os}-{arch}.{so|dll|dylib}`) + optional web assets + optional `server.js`
- **C ABI**: `PluginOnLoad`, `PluginOnEvent`, `PluginOnUnload`, `PluginGetRuntime`
- **Server-side JS** (`server.js`): runs in isolated Node.js VM per plugin; has private SQLite (`plugin.db`) and RPC bridge to host
- See `plugins/PLUGINS.md` for full plugin development guide

### Desktop (Overlord-Desktop)
- Tauri 2 (Rust + system webview): much smaller binaries than Electron (~10 MB NSIS)
- `src-tauri/src/lib.rs`: window management, connect/navigate IPC commands, `on_new_window` handler that turns `window.open` calls from the web UI into native popup webviews (so cookies / `SameSite=Strict` auth inherit correctly)
- `src/`: local connect screen (HTML/CSS/JS) — once connected, the main window navigates to the remote Overlord UI
- TLS: passes `--ignore-certificate-errors` to WebView2 on Windows for self-signed certs (macOS/Linux: issue a trusted cert)
- Persists connection settings to the Tauri app-config dir (`%APPDATA%\com.overlord.desktop\connection.json` on Windows)

## Key Configuration
- **Runtime env**: `NODE_ENV=development|production` (controls certbot, logging)
- **TLS**: Auto-generates self-signed certs (`generate-certs.sh`) or certbot/Let's Encrypt
- **Database**: SQLite, persisted to `/app/data/` in Docker
- **Docker networking**: Linux uses host networking; Windows/macOS uses bridge

## Go Monorepo
`go.work` / `go.work.sum` at repo root manages the Go workspace for `Overlord-Client`.

## CI
`.github/workflows/tests.yml` runs `bun test` (server) and `go test ./...` (client) on PRs.
