<p align="center">
  <img src="https://raw.githubusercontent.com/vxaboveground/Overlord/refs/heads/main/Overlord-Server/public/assets/overlord.png" alt="Overlord" width="280" />
</p>

# Overlord

# [TELEGRAM SERVER JOIN NOW NO EXCUSES WE GIVE SUPPORT AND IT'S FUN](https://t.me/Onimai)

Hello, I made this project for fun.

The server is TypeScript on Node/Bun. The client is Go. Operators talk to the server through a web panel or the Electron desktop app, and agents connect over encrypted WebSockets.

Docker is the easiest way to run it.

---

- [Quick Start (Docker)](#quick-start-docker)
  - [Windows](#windows)
  - [Linux](#linux)
  - [macOS](#macos)
- [No Docker (.bat / .sh)](#no-docker-bat--sh)
- [Production Package Scripts](#production-package-scripts)
- [WebRTC Streaming](#webrtc-streaming)
- [OIDC / SSO Login](#oidc--sso-login)
- [Login Branding](#login-branding)
- [Docker Notes (TLS, reverse proxy, cache)](#docker-notes-tls-reverse-proxy-cache)

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
# Add Docker's official GPG key:
sudo apt update
sudo apt install ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

# Add the repository to Apt sources:
sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update
```

On a derivative distro (e.g. Kali), replace the codename expansion with the matching Debian codename, e.g. `bookworm`.

Install Docker:

```bash
sudo apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Make sure the daemon is running:

```bash
sudo systemctl status docker
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
scripts\start-dev.bat
```

Production mode (build + run server executable):

```bat
scripts\start-prod.bat
```

Build client binaries (adds client builds to the build queue):

```bat
scripts\build-clients.bat
```

### Linux / macOS

Make scripts executable once:

```bash
chmod +x scripts/*.sh scripts/*.command
```

Development mode (server in background, client in foreground):

```bash
./scripts/start-dev.sh
```

Only server, or only client:

```bash
./scripts/start-dev.sh server
./scripts/start-dev.sh client
```

Production mode:

```bash
./scripts/start-prod.sh
```

---

## Production Package Scripts

Build a production-ready package where the server can still build client binaries at runtime.

Windows:

```bat
scripts\build-prod-package.bat
```

Output: `release/`

Linux / macOS:

```bash
./scripts/build-prod-package.sh
```

Output: `release/prod-package/`

---

## WebRTC Streaming

The remote desktop viewer has a **Transport** dropdown with three modes:

- **Canvas** (default): H.264 / JPEG / block frames over the existing WebSocket, decoded into a `<canvas>`. Highest latency, works anywhere the WS does.
- **WebRTC P2P**: browser ↔ agent direct. The server only relays SDP and ICE candidates over the existing WS — MediaMTX is not involved. Lowest latency. Fails when both sides are behind aggressive symmetric NAT.
- **WebRTC Relayed**: agent publishes to a MediaMTX sidecar via WHIP, browser plays via WHEP. The server proxies signaling so the existing JWT auth + per-client RBAC still apply. Lowest-effort fallback when P2P can't punch through.

### Building agents with WebRTC

WebRTC is **opt-in per agent build**. In the builder UI, tick the **WebRTC** checkbox before clicking Build. Without it, the Pion stack (~6 MB of Go modules) is not compiled in — any WebRTC start attempt from the operator returns `webrtc support not compiled in` and the viewer falls back to Canvas. The Canvas path always works regardless of the build setting.

The build tag (`overlord_webrtc`) is also available if you build agents outside the UI:

```bash
go build -tags overlord_webrtc ./cmd/agent
```

### MediaMTX sidecar

Compose starts an `overlord-mediamtx` service for Relayed mode. It needs:

- Port `8189/udp` and `8189/tcp` reachable from operators (WebRTC ICE traffic). The Windows / macOS compose publishes these; Linux uses host networking and shares the host's interfaces directly.
- No auth config — the Overlord server proxies every WHIP/WHEP request through `/api/webrtc/...` and enforces the existing operator JWT + RBAC there.

If you only ever want P2P, you can comment out the `mediamtx:` service in your compose file — only Relayed mode depends on it.

### LAN / public access

MediaMTX automatically discovers addresses assigned directly to its network interfaces. This covers ordinary Linux host-network and many LAN deployments, but it cannot reliably infer a public address created by NAT, port forwarding, a cloud load balancer, or a reverse proxy. It also cannot discover which public DNS name you intend operators to use.

Before using **WebRTC Relayed** from another machine, make sure MediaMTX advertises an address that both agents and operators can reach:

- **Linux with host networking and no public NAT:** normally nothing is required; MediaMTX sees the host's interfaces automatically.
- **Public server behind NAT, port forwarding, or a cloud public-IP mapping:** set the public IP or a DNS name that resolves to it.
- **Windows / macOS Docker Desktop:** set the host's reachable LAN/public address because automatic interface discovery sees the container network, not necessarily the Docker host.
- **Same-machine testing on Docker Desktop:** retain `127.0.0.1` in the list.

Set `OVERLORD_WEBRTC_ADDITIONAL_HOSTS` as a comma-separated list in the shell or in a `.env` file next to the compose file:

```env
# LAN example
OVERLORD_WEBRTC_ADDITIONAL_HOSTS=192.168.1.42

# Public DNS plus LAN access
OVERLORD_WEBRTC_ADDITIONAL_HOSTS=stream.example.com,192.168.1.42

# Docker Desktop: same host plus other LAN machines
OVERLORD_WEBRTC_ADDITIONAL_HOSTS=127.0.0.1,192.168.1.42
```

Ensure inbound UDP `8189` is forwarded to the MediaMTX host/container; TCP `8189` is the slower fallback. Recreate the sidecar after changing the setting:

```bash
# Linux
docker compose up -d --force-recreate mediamtx

# Windows / macOS Docker Desktop
docker compose -f docker-compose.windows.yml up -d --force-recreate mediamtx
```

To verify the selected route, open `chrome://webrtc-internals` during a relayed stream and confirm that the chosen remote candidate points to the expected server address and preferably uses UDP.

Automatic public-IP discovery is possible with STUN, but it is not a complete replacement for this setting: it can require random UDP ports, does not discover your intended domain, and can fail behind restrictive or symmetric NAT. For predictable production deployments, explicitly setting the reachable IP/domain and forwarding fixed UDP port `8189` is recommended.

### Advanced MediaMTX customization

The compose file passes a minimal set of `MTX_*` environment variables to MediaMTX — enough for Overlord to work. To change anything else (codecs, paths, ICE servers, etc.), either:

- Add more `MTX_*` variables to the `mediamtx` service's `environment:` block (every option in MediaMTX's docs is supported as an env var), or
- Provide a full `mediamtx.yml` via a bind mount:

  ```yaml
  mediamtx:
    # ...existing config...
    volumes:
      - ./mediamtx.yml:/mediamtx.yml:ro
  ```

  Make sure the file exists on the host *before* the container starts — Docker will otherwise auto-create an empty directory at that path and fail with "not a directory".

---

## OIDC / SSO Login

Overlord supports generic OIDC login for homelab identity providers such as Authentik, Authelia, Keycloak, Zitadel, and Dex. Local username/password login stays enabled as a fallback.

Configure your OIDC provider with this redirect URI:

```text
https://YOUR_OVERLORD_HOST/api/oidc/callback
```

Then set the relevant environment variables:

```env
OVERLORD_OIDC_ENABLED=true
OVERLORD_OIDC_LABEL=Sign in with SSO
OVERLORD_OIDC_ISSUER=https://auth.example.com/application/o/overlord/
OVERLORD_OIDC_CLIENT_ID=overlord
OVERLORD_OIDC_CLIENT_SECRET=change-me
OVERLORD_OIDC_REDIRECT_URI=https://overlord.example.com/api/oidc/callback
OVERLORD_OIDC_DEFAULT_ROLE=viewer
OVERLORD_OIDC_ALLOWED_DOMAINS=example.com
OVERLORD_OIDC_ADMIN_GROUPS=overlord-admins
OVERLORD_OIDC_OPERATOR_GROUPS=overlord-operators
OVERLORD_OIDC_VIEWER_GROUPS=overlord-viewers
```

New OIDC users are linked by the provider's `issuer + sub` identity. Email/username linking to an existing local account is disabled by default; enable `OVERLORD_OIDC_ALLOW_EMAIL_LINK=true` only if you trust your provider's verified email claims.

---

## Login Branding

Self-hosted and enterprise deployments can brand the login screen with environment variables:

```env
OVERLORD_LOGIN_BRAND_NAME=Acme SOC
OVERLORD_NAV_BRAND_NAME=Acme Console
OVERLORD_BRAND_ACCENT_COLOR=#14b8a6
OVERLORD_LOGIN_TITLE=Welcome to Acme Overlord
OVERLORD_LOGIN_SUBTITLE=Sign in with your Acme identity
OVERLORD_LOGIN_LOGO_URL=/assets/acme-logo.png
OVERLORD_LOGIN_LOGO_ALT=Acme logo
OVERLORD_NAV_LOGO_URL=/assets/acme-nav-logo.png
OVERLORD_NAV_LOGO_ALT=Acme logo
OVERLORD_LOGIN_HERO_IMAGE_URL=/assets/acme-login.jpg
OVERLORD_LOGIN_HERO_IMAGE_ALT=Acme operations center
OVERLORD_LOGIN_FOOTER_TEXT=Authorized Acme access only
OVERLORD_LOGIN_SUPPORT_TEXT=Need access help?
OVERLORD_LOGIN_SUPPORT_URL=https://help.example.com
OVERLORD_LOGIN_ICON_CLASS=fa-solid fa-shield-halved
```

Logo, hero, and support URLs accept absolute `http(s)` URLs or root-relative paths. If no logo URL is set, the UI uses `OVERLORD_LOGIN_ICON_CLASS`. The same options can also be managed from Settings → Branding.

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

### macOS CGO builds on Linux/Docker

When a macOS target is selected with CGO enabled, the builder asks for a user-provided macOS SDK archive. Package the complete `MacOSX*.sdk` directory as `.tar.xz`, `.tar.gz`, `.tgz`, or `.tar` and upload it from the Build page. The archive must contain the SDK's `System/Library/Frameworks` and `usr` directories.

The upload is limited to 1 GB, belongs to the authenticated user, can be used for only one build, and is deleted after the build. Unused uploads expire after one hour. The Docker image supplies Clang and LLD; Apple SDK files are never bundled or downloaded by Overlord.

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

### Source IP behind a domain / reverse proxy

If the dashboard, audit log, or IP bans show all agents as `172.x.x.x` (or some other proxy/bridge IP), something between the agent and Bun is rewriting the source IP. Two independent flags govern this:

- `OVERLORD_TLS_OFFLOAD` — TLS terminates at the proxy; Overlord runs plain HTTP internally.
- `OVERLORD_TRUST_PROXY` — honor `X-Forwarded-For` / `X-Real-IP` / `CF-Connecting-IP` so dashboard/audit/IP-bans see the real client. Auto-enabled when `TLS_OFFLOAD=true`.

Common shapes:

| Setup | `TLS_OFFLOAD` | `TRUST_PROXY` |
|---|---|---|
| Domain, no proxy (Linux host networking; certbot inside Overlord; Cloudflare DNS-only) | `false` | `false` |
| Domain, proxy does TLS (Render, nginx terminating TLS → http upstream) | `true` | auto (`true`) |
| Domain, proxy in front but Overlord still does TLS (Cloudflare orange-cloud Full Strict; nginx with `proxy_pass https://`) | `false` | `true` |

Only enable `OVERLORD_TRUST_PROXY` when a trusted reverse proxy is in front. If Overlord is directly exposed and you enable it, agents can spoof their source IP by sending their own `X-Forwarded-For` header, breaking IP bans and audit accuracy. The upstream proxy also has to be configured to inject the header (Cloudflare does by default; nginx/Caddy/Traefik need explicit directives).

If you're using `docker-compose.windows.yml` or `docker-compose.quickstart.yml` (Docker Desktop bridge networking) with **no** reverse proxy, Docker itself rewrites source IPs to the bridge gateway and there is no header to recover from — `TRUST_PROXY` cannot help. Either switch to Linux host networking or put a real reverse proxy in front.

### Notes

- Keep `HOST=0.0.0.0` inside the container. Limit exposure with `OVERLORD_PUBLISH_HOST`, not the bind host.
- If your `.env` secret/password contains `$`, escape it as `$$` to avoid Docker Compose variable-expansion warnings.
