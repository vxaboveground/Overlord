<p align="center">
  <img src="https://raw.githubusercontent.com/vxaboveground/Overlord/refs/heads/main/Overlord-Server/public/assets/overlord.png" alt="Overlord" width="280" />
</p>

# Overlord

Support and discussion: [Telegram](https://t.me/WindowsBatch)

Personal project, shared as-is.

## What is Overlord?

Overlord is a self-hosted command-and-control framework. The server is written in
TypeScript and runs on Node or Bun. The client (agent) is written in Go. Operators
interact with the server through a web panel or the Electron desktop app, and agents
connect over encrypted WebSockets.

Docker is the recommended way to run it.

---

- [Quick Start (Docker)](#quick-start-docker)
- [Without Docker](#without-docker)
- [Production Package](#production-package)
- [Docker Notes](#docker-notes)

---

## Quick Start (Docker)

Install Docker for your OS by following the official guide:
<https://docs.docker.com/get-started/get-docker/>. Once `docker --version` and
`docker compose version` work, continue below.

Clone the repository:

```bash
git clone https://github.com/vxaboveground/Overlord.git
cd Overlord
```

Start the stack:

- **Linux** (host networking):

  ```bash
  docker compose up -d
  ```

- **Windows / macOS**:

  ```bash
  docker compose -f docker-compose.windows.yml up -d
  ```

Open the panel at <https://localhost:5173>. The default login is `admin` / `admin`
unless you set `OVERLORD_USER` / `OVERLORD_PASS`. On first startup, generated
secrets are written to `data/save.json` (inside the container at
`/app/data/save.json`). Keep that file private and back it up.

To update, run the same compose command with `down`, `pull`, then `up -d`. To stop,
run `down`.

---

## Without Docker

You can run Overlord directly from the included scripts. You'll need:

- [Bun](https://bun.sh) in `PATH`
- Go 1.21+ in `PATH`

### Windows

```bat
start-dev.bat        :: dev mode (server + client)
start-prod.bat       :: production mode (build + run)
build-clients.bat    :: queue client builds
```

### Linux / macOS

Make the scripts executable once:

```bash
chmod +x start-dev.sh start-dev-server.sh start-dev-client.sh start-prod.sh build-prod-package.sh
```

Then:

```bash
./start-dev.sh           # server in background, client in foreground
./start-dev.sh server    # server only
./start-dev.sh client    # client only
./start-prod.sh          # production mode
```

---

## Production Package

Build a production-ready package. The packaged server can still build client
binaries at runtime.

| OS              | Command                     | Output                  |
| --------------- | --------------------------- | ----------------------- |
| Windows         | `build-prod-package.bat`    | `release/`              |
| Linux / macOS   | `./build-prod-package.sh`   | `release/prod-package/` |

---

## Docker Notes

### BuildKit cache

`docker-compose.yml` already wires `build.cache_from` and `build.cache_to` to
`.docker-cache/buildx`. Local rebuilds reuse it automatically.

### Runtime client build cache

A persistent volume is used for client builds produced at runtime:

- Volume: `overlord-client-build-cache`
- Mount: `/app/client-build-cache`
- Env: `OVERLORD_CLIENT_BUILD_CACHE_DIR` (default `/app/client-build-cache`)

### Certbot (Let's Encrypt)

To use Let's Encrypt certificates in production:

1. Set `OVERLORD_TLS_CERTBOT_ENABLED=true`.
2. Set `OVERLORD_TLS_CERTBOT_DOMAIN=your-domain.com`.
3. Mount `/etc/letsencrypt` into the container read-only:
   `/etc/letsencrypt:/etc/letsencrypt:ro`.

Default cert paths are `/etc/letsencrypt/live/<domain>/{fullchain,privkey,chain}.pem`.
Override individually with `OVERLORD_TLS_CERTBOT_LIVE_PATH`,
`OVERLORD_TLS_CERTBOT_CERT_FILE`, `OVERLORD_TLS_CERTBOT_KEY_FILE`, or
`OVERLORD_TLS_CERTBOT_CA_FILE`.

### Reverse proxy / TLS offload

If your platform terminates TLS in front of Overlord (Render, Caddy, nginx, etc.),
set:

```
OVERLORD_TLS_OFFLOAD=true
OVERLORD_HEALTHCHECK_URL=http://localhost:5173/health
OVERLORD_PUBLISH_HOST=127.0.0.1
```

The container will serve internal HTTP on `0.0.0.0:$PORT` while the external URL
remains `https://...` via the proxy. Don't expose the internal HTTP port directly.

### Misc

- Keep `HOST=0.0.0.0` inside the container. Use `OVERLORD_PUBLISH_HOST` to limit
  exposure, not the bind host.
- If a secret or password in `.env` contains `$`, escape it as `$$` to avoid
  Docker Compose variable-expansion warnings.
