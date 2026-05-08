<p align="center">
  <img src="https://raw.githubusercontent.com/vxaboveground/Overlord/refs/heads/main/Overlord-Server/public/assets/overlord.png" alt="Overlord" width="500" />
</p>

# Overlord

Hello, I made this project for fun.

The server is TypeScript on Node/Bun. The client is Go. Operators talk to the server through a web panel or the Electron desktop app, and agents connect over encrypted WebSockets.

Docker is the easiest way to run it.

---

##### ***READ THE [QUICK START (Docker)](#quick-start-docker) BEFORE JOINING THE TELEGRAM FOR SUPPORT***
Community & Support:
- [Somaliware (telegram channel)](https://t.me/WindowsBatch)
- [Plugins (telegram channel)](https://t.me/OverlordPluginz)
- [FAQ](https://github.com/vxaboveground/Overlord/FAQ/README.md) <!-- | *faq section for less bloat here :D* | ~ this shouldve been a comment anyway </3 -->

<br>
New to overlord? Follow our guide:

- [Quick Start (Docker)](#quick-start-docker)
  - [Windows](#windows)
  - [Linux](#linux)
  - [macOS](#macos)

  
<br>
Other:

- [No Docker (.bat / .sh)](#no-docker-bat--sh)
- [Production Package Scripts](#production-package-scripts)
- [Docker Notes (TLS, reverse proxy, cache)](#docker-notes-tls-reverse-proxy-cache)

---
---

## Quick Start (Docker)

Pick your OS below. Each section is self-contained: install Docker, get the project, start it.

> Windows and macOS use `docker-compose.windows.yml`. Linux uses the default `docker-compose.yml` (host networking).

After the first start, open `https://localhost:5173`. Default login is `admin` / `admin` unless you set `OVERLORD_USER` / `OVERLORD_PASS`. First startup writes generated secrets to `data/save.json` (inside the container: `/app/data/save.json`) — keep that file private and back it up.

---

### Windows

<details>
<summary>Step-by-step: Windows</summary>
<br>

**1. Install Docker Desktop**

Either from the website:

- https://docs.docker.com/desktop/setup/install/windows-install/

Or with winget:

```powershell
winget install -e --id Docker.DockerDesktop
```

Start Docker Desktop once, then verify:

```powershell
docker --version
docker compose version
```

**2. Get the project**

```powershell
git clone https://github.com/vxaboveground/Overlord.git
cd Overlord
```

**3. Start it**

```powershell
docker compose -f docker-compose.windows.yml up -d
```

**4. Open the panel**

```text
https://localhost:5173
```

**5. Update later**

```powershell
docker compose -f docker-compose.windows.yml down
docker compose -f docker-compose.windows.yml pull
docker compose -f docker-compose.windows.yml up -d
```

**6. Stop**

```powershell
docker compose -f docker-compose.windows.yml down
```

</details>

---

### Linux

<details>
<summary>Step-by-step: Linux (Debian / Ubuntu / Kali)</summary>
<br>

**1. Install Docker**

Official docs: https://docs.docker.com/engine/install/debian/

Set up Docker's apt repository:

```bash
sudo apt update
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update
```

On a derivative distro (e.g. Kali), replace the codename expansion with the matching Debian codename, e.g. `bookworm`.

Install Docker:

```bash
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Make sure the daemon is running:

```bash
sudo systemctl start docker
```

Optional — run Docker without sudo:

```bash
sudo usermod -aG docker $USER
newgrp docker
```

Verify:

```bash
docker --version
docker compose version
```

**2. Grab the compose file**

Make a folder for it, drop in the file, and you're done:

```bash
mkdir overlord && cd overlord
wget https://raw.githubusercontent.com/vxaboveground/Overlord/refs/heads/main/docker-compose.yml
```

No `wget`? Use `curl`:

```bash
mkdir overlord && cd overlord
curl -O https://raw.githubusercontent.com/vxaboveground/Overlord/refs/heads/main/docker-compose.yml
```

**3. Start it**

```bash
docker compose up -d
```

The image is pulled automatically from `ghcr.io/vxaboveground/overlord:latest` on first run.

**4. Open the panel**

```text
https://localhost:5173

or 

https://IP:5173
```

**5. Update later**

From the same folder:

```bash
docker compose down
docker compose pull
docker compose up -d
```

**6. Stop**

```bash
docker compose down
```

</details>

---

### macOS

<details>
<summary>Step-by-step: macOS</summary>
<br>

**1. Install Docker Desktop**

Either from the website:

- https://docs.docker.com/desktop/setup/install/mac-install/

Or with Homebrew:

```bash
brew install --cask docker
```

Start Docker Desktop once, then verify:

```bash
docker --version
docker compose version
```

**2. Get the project**

```bash
git clone https://github.com/vxaboveground/Overlord.git
cd Overlord
```

**3. Start it**

macOS uses the same compose file as Windows:

```bash
docker compose -f docker-compose.windows.yml up -d
```

**4. Open the panel**

```text
https://localhost:5173
```

**5. Update later**

```bash
docker compose -f docker-compose.windows.yml down
docker compose -f docker-compose.windows.yml pull
docker compose -f docker-compose.windows.yml up -d
```

**6. Stop**

```bash
docker compose -f docker-compose.windows.yml down
```

</details>

---

## No Docker (.bat / .sh)

If you don't want Docker, use the included scripts.

Prerequisites:

- Bun in PATH
- Go 1.21+ in PATH

### Windows

Development mode (starts server + client):

```bat
start-dev.bat
```

Production mode (build + run server executable):

```bat
start-prod.bat
```

Build client binaries (adds client builds to the build queue):

```bat
build-clients.bat
```

### Linux / macOS

Make scripts executable once:

```bash
chmod +x start-dev.sh start-dev-server.sh start-dev-client.sh start-prod.sh build-prod-package.sh
```

Development mode (server in background, client in foreground):

```bash
./start-dev.sh
```

Only server, or only client:

```bash
./start-dev.sh server
./start-dev.sh client
```

Production mode:

```bash
./start-prod.sh
```

---

## Production Package Scripts

Build a production-ready package where the server can still build client binaries at runtime.

Windows:

```bat
build-prod-package.bat
```

Output: `release/`

Linux / macOS:

```bash
./build-prod-package.sh
```

Output: `release/prod-package/`

---

## Docker Notes (TLS, reverse proxy, cache)

Notes on configs and workarounds.

### BuildKit cache for faster rebuilds

`docker-compose.yml` ships with `build.cache_from` and `build.cache_to` pointing at `.docker-cache/buildx`. Local builds reuse it automatically — no extra setup.

### Runtime client build cache

The compose setup uses a persistent volume for runtime client builds:

- Volume: `overlord-client-build-cache`
- Mount: `/app/client-build-cache`
- Env: `OVERLORD_CLIENT_BUILD_CACHE_DIR` (default `/app/client-build-cache`)

### Certbot TLS

To use Let's Encrypt certificates in production Docker:

1. Set `OVERLORD_TLS_CERTBOT_ENABLED=true`
2. Set `OVERLORD_TLS_CERTBOT_DOMAIN=your-domain.com`
3. Mount letsencrypt into the container read-only, e.g. `/etc/letsencrypt:/etc/letsencrypt:ro`

Default cert paths:

```
cert: /etc/letsencrypt/live/<domain>/fullchain.pem
key:  /etc/letsencrypt/live/<domain>/privkey.pem
ca:   /etc/letsencrypt/live/<domain>/chain.pem
```

Override with:

- `OVERLORD_TLS_CERTBOT_LIVE_PATH`
- `OVERLORD_TLS_CERTBOT_CERT_FILE`
- `OVERLORD_TLS_CERTBOT_KEY_FILE`
- `OVERLORD_TLS_CERTBOT_CA_FILE`

### Reverse proxy TLS offload

If your platform terminates TLS before traffic reaches Overlord (Render, Caddy, nginx, etc.), set:

```
OVERLORD_TLS_OFFLOAD=true
OVERLORD_HEALTHCHECK_URL=http://localhost:5173/health
OVERLORD_PUBLISH_HOST=127.0.0.1
```

When enabled:

- Container serves internal HTTP on `0.0.0.0:$PORT`
- External URL stays `https://...` through your platform proxy
- Health checks should use `http://localhost:$PORT/health` inside the container
- Don't expose the internal container HTTP port directly to the internet

### Notes

- Keep `HOST=0.0.0.0` inside the container. Limit exposure with `OVERLORD_PUBLISH_HOST`, not the bind host.
- If your `.env` secret/password contains `$`, escape it as `$$` to avoid Docker Compose variable-expansion warnings.

- Keep `HOST=0.0.0.0` inside the container. Limiting exposure should be done with publish binding (`OVERLORD_PUBLISH_HOST`), not server bind host.
- If your `.env` secret/password includes `$`, escape as `$$` to avoid Docker Compose variable-expansion warnings.
