<p align="center">
  <img src="https://raw.githubusercontent.com/vxaboveground/Overlord/refs/heads/main/Overlord-Server/public/assets/overlord.png" alt="Overlord" />
</p>

# Overlord

# [TELEGRAM SERVER JOIN NOW NO EXCUSES WE GIVE SUPPORT AND IT'S FUN](https://t.me/WindowsBatch)

Hello, I made this project for fun.

It is written using a combination of Typescript + Node.JS for the server and GOLang for the client. <br> 
Connections are done via encrypted websockets to connect to the server from the client. <br>
You need to use docker to get this to run easier/for quicker deployment. <br>

---

- [Quick Start (Docker)](#quick-start-docker)
- [Docker Install By OS](#docker-install-by-os)
- [No Docker (.bat / .sh)](#no-docker-bat--sh)
- [Production Package Scripts](#production-package-scripts)
- [Docker Notes (TLS, reverse proxy, cache)](#docker-notes-tls-reverse-proxy-cache)

---

## Quick Start (Docker)

If you just want it running fast, use this.

> **⚠️ The compose file below is for Linux ONLY.** If you are on **Windows** or **macOS**, use `docker-compose.windows.yml` instead. See [Docker Install By OS](#docker-install-by-os) for the correct commands.

<details>

<summary>Installation instructions for Linux</summary>

1. Create a `docker-compose.yml` file and paste this:

```yaml
services:
  overlord-server:
    image: ${DOCKER_IMAGE:-ghcr.io/vxaboveground/overlord:latest}
    build:
      context: .
      dockerfile: Dockerfile
      cache_from:
        - type=local,src=.docker-cache/buildx
      cache_to:
        - type=local,dest=.docker-cache/buildx,mode=max
    container_name: overlord-server
    network_mode: host
    environment:
      PORT: ${PORT:-5173}
      HOST: ${HOST:-0.0.0.0}
      OVERLORD_USER: ${OVERLORD_USER:-admin}
      OVERLORD_PASS: ${OVERLORD_PASS:-}
      JWT_SECRET: ${JWT_SECRET:-}
      OVERLORD_AGENT_TOKEN: ${OVERLORD_AGENT_TOKEN:-}
      NODE_ENV: ${NODE_ENV:-production}
      OVERLORD_TLS_CERT: ${OVERLORD_TLS_CERT:-/app/certs/server.crt}
      OVERLORD_TLS_KEY: ${OVERLORD_TLS_KEY:-/app/certs/server.key}
      OVERLORD_TLS_CA: ${OVERLORD_TLS_CA:-}
      OVERLORD_TLS_OFFLOAD: ${OVERLORD_TLS_OFFLOAD:-false}
      OVERLORD_AUTH_COOKIE_SECURE: ${OVERLORD_AUTH_COOKIE_SECURE:-auto}
      OVERLORD_TLS_CERTBOT_ENABLED: ${OVERLORD_TLS_CERTBOT_ENABLED:-false}
      OVERLORD_TLS_CERTBOT_LIVE_PATH: ${OVERLORD_TLS_CERTBOT_LIVE_PATH:-/etc/letsencrypt/live}
      OVERLORD_TLS_CERTBOT_DOMAIN: ${OVERLORD_TLS_CERTBOT_DOMAIN:-}
      OVERLORD_TLS_CERTBOT_CERT_FILE: ${OVERLORD_TLS_CERTBOT_CERT_FILE:-fullchain.pem}
      OVERLORD_TLS_CERTBOT_KEY_FILE: ${OVERLORD_TLS_CERTBOT_KEY_FILE:-privkey.pem}
      OVERLORD_TLS_CERTBOT_CA_FILE: ${OVERLORD_TLS_CERTBOT_CA_FILE:-chain.pem}
      OVERLORD_CLIENT_BUILD_CACHE_DIR: ${OVERLORD_CLIENT_BUILD_CACHE_DIR:-/app/client-build-cache}
      OVERLORD_FILE_UPLOAD_INTENT_TTL_MS: ${OVERLORD_FILE_UPLOAD_INTENT_TTL_MS:-1800000}
      OVERLORD_FILE_UPLOAD_PULL_TTL_MS: ${OVERLORD_FILE_UPLOAD_PULL_TTL_MS:-1800000}
    volumes:
      - overlord-data:/app/data
      - overlord-certs:/app/certs
      - overlord-client-build-cache:/app/client-build-cache
      - overlord-plugins:/app/plugins
    restart: unless-stopped
    init: true
    security_opt:
      - no-new-privileges:true
    healthcheck:
      test: ["CMD-SHELL", "curl -f ${OVERLORD_HEALTHCHECK_URL:-https://localhost:5173/health} >/dev/null 2>&1 || exit 1"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

volumes:
  overlord-data:
  overlord-certs:
  overlord-client-build-cache:
  overlord-plugins:
```

2. Start it:

```sh
docker compose up -d
```

3. Open the panel:

```text
https://localhost:5173
```

4. Update later:

```sh
docker compose pull
docker compose up -d
```

5. Stop:

```sh
docker compose down
```

First startup generates secrets and stores them in `data/save.json` (inside container: `/app/data/save.json`).
Keep that file private and backed up.

Default bootstrap login is `admin` / `admin` unless you set `OVERLORD_USER` and `OVERLORD_PASS`.

</details>

## Docker Install By OS

### Windows

<details>
  <summary>Installation instructions for Windows</summary>
  <br>
Install Docker Desktop (includes Docker Compose):

- https://docs.docker.com/desktop/setup/install/windows-install/

or with winget:

```powershell
winget install -e --id Docker.DockerDesktop
```

After install, start Docker Desktop once, then verify:

```powershell
docker --version
docker compose version
```

> **Windows users:** use `docker-compose.windows.yml` instead of the default `docker-compose.yml`. The Windows compose file is pre-configured for Docker Desktop on Windows (no `network_mode: host`, correct volume paths, etc.).

Clone the repo or download the files, then run:

```powershell
docker compose -f docker-compose.windows.yml up -d
```

To rebuild after an update:

```powershell
docker compose -f docker-compose.windows.yml up --build -d
```

### Linux (Debian, official apt repo method)

Official docs:

- https://docs.docker.com/engine/install/debian/

Set up Docker's apt repository:

```bash
# Add Docker's official GPG key:
sudo apt update
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

# Add the repository to Apt sources:
sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update
```

If you use a derivative distro (for example Kali), you may need to replace:

```bash
(. /etc/os-release && echo "$VERSION_CODENAME")
```

with the matching Debian codename (for example `bookworm`).

Install latest Docker packages:

```bash
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Verify service status:

```bash
sudo systemctl status docker
```

If your system does not auto-start Docker:

```bash
sudo systemctl start docker
```

Optional (run Docker without sudo):

```bash
sudo usermod -aG docker $USER
newgrp docker
```

Verify CLI:

```bash
docker --version
docker compose version
```

</details>

### macOS


<details>
  <summary>Installation instructions for Mac</summary>
  <br>

Install Docker Desktop:

- https://docs.docker.com/desktop/setup/install/mac-install/

or with Homebrew:

```bash
brew install --cask docker
```

Start Docker Desktop once, then verify:

```bash
docker --version
docker compose version
```

> **macOS users:** use `docker-compose.windows.yml` instead of the default `docker-compose.yml`. The Windows/macOS compose file is pre-configured for Docker Desktop (no `network_mode: host`, correct volume paths, etc.).

Clone the repo or download the files, then run:

```bash
docker compose -f docker-compose.windows.yml up -d
```

To rebuild after an update:

```bash
docker compose -f docker-compose.windows.yml up --build -d
```

</details>

## No Docker (.bat / .sh)

<details>
  <summary>If you do not want Docker, use the included scripts.</summary>
  <br>

Prerequisites for local (non-Docker) runs:

- Bun in PATH
- Go 1.21+ in PATH

</details>

<hr>

### Windows

<details>
  <summary>Script instructions for Windows</summary>
  <br>

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

</details>

<hr>

### Linux / macOS

<details>
  <summary>Installation instructions for Linux / Mac</summary>
  <br>

Make scripts executable once:

```bash
chmod +x start-dev.sh start-dev-server.sh start-dev-client.sh start-prod.sh build-prod-package.sh
```

Development mode (starts server in background + client in foreground):

```bash
./start-dev.sh
```

Only server:

```bash
./start-dev.sh server
```

Only client:

```bash
./start-dev.sh client
```

Production mode:

```bash
./start-prod.sh
```

</details>

## Production Package Scripts

Build a production-ready package where the server can still build client binaries at runtime.

Windows:

```bat
build-prod-package.bat
```

Linux/macOS:

```bash
./build-prod-package.sh
```

Package output:

- Windows script: `release`
- Linux/macOS script: `release/prod-package`

## Docker Notes (TLS, reverse proxy, cache)

<p>Here we will store some notes for you to read depending on what it is. Configs, work arounds etc.</p>

<hr>

### BuildKit cache for faster rebuilds

`docker-compose.yml` includes `build.cache_from` and `build.cache_to` using `.docker-cache/buildx`.

Rebuild:

```sh
docker compose up --build -d
```

<hr>

### Runtime client build cache

The compose setup uses a persistent volume for runtime client builds:

- volume: `overlord-client-build-cache`
- mount: `/app/client-build-cache`
- env: `OVERLORD_CLIENT_BUILD_CACHE_DIR` (default `/app/client-build-cache`)

<hr>

### Certbot TLS

To use certbot certificates in production Docker:

#### Set:        
    OVERLORD_TLS_CERTBOT_ENABLED=true
#### Set:       
    OVERLORD_TLS_CERTBOT_DOMAIN=your-domain.com
    
- Mount letsencrypt into container read-only (example: `/etc/letsencrypt:/etc/letsencrypt:ro`)

#### Default cert paths:       
    cert: /etc/letsencrypt/live/<domain>/fullchain.pem     
    key: /etc/letsencrypt/live/<domain>/privkey.pem      
    ca: /etc/letsencrypt/live/<domain>/chain.pem

#### Override with:       
    OVERLORD_TLS_CERTBOT_LIVE_PATH       
    OVERLORD_TLS_CERTBOT_CERT_FILE
    OVERLORD_TLS_CERTBOT_KEY_FILE
    OVERLORD_TLS_CERTBOT_CA_FILE

<hr>

### Reverse proxy TLS offload (Render, etc.)

#### If your platform terminates TLS before traffic reaches Overlord, set:
 
     OVERLORD_TLS_OFFLOAD=true 
     OVERLORD_HEALTHCHECK_URL=http://localhost:5173/health
     OVERLORD_PUBLISH_HOST=127.0.0.1
 (recommended for local proxies like ngrok)

When enabled:

- container serves internal HTTP on `0.0.0.0:$PORT`
- external URL remains `https://...` through your platform proxy
- health checks should use `http://localhost:$PORT/health` inside the container
- do not expose internal container HTTP port directly to the internet

<hr> 

For ngrok/local reverse proxy use, a common setup is:

```sh
OVERLORD_TLS_OFFLOAD=true
OVERLORD_HEALTHCHECK_URL=http://localhost:5173/health
OVERLORD_PUBLISH_HOST=127.0.0.1
```

Then point ngrok at local HTTP:

```sh
ngrok http http://127.0.0.1:5173
```

<hr>

Notes:

- Keep `HOST=0.0.0.0` inside the container. Limiting exposure should be done with publish binding (`OVERLORD_PUBLISH_HOST`), not server bind host.
- If your `.env` secret/password includes `$`, escape as `$$` to avoid Docker Compose variable-expansion warnings.
