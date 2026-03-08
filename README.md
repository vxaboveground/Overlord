<p align="center">
  <img src="https://raw.githubusercontent.com/vxaboveground/Overlord/refs/heads/main/Overlord-Server/public/assets/353030.png" alt="Overlord" />
</p>

# Overlord

# [TELEGRAM SERVER JOIN NOW NO EXCUSES WE GIVE SUPPORT AND IT'S FUN](https://t.me/WindowsBatch)

Hello, I made this project for fun.

----

[Using Docker](#Using-Docker)<br>
[Prod Packages](#Using-Production-packages-(Windows))

----

## Using-Docker

*Please keep in mind you should run docker with nessesary perms, have access to the internet and actually have docker installed. 
Install-Debian-Linux(GIVE ME SUDO).sh is a good start point*

Just use docker please the src is fine to use as well but you need golang, bun, garble and openssl.

To use docker copy the docker-compose.yml to your working directory and run


```sh
docker compose up
```

On first startup, if secrets are not provided through environment variables,
Overlord generates them and persists them to `data/save.json` (inside Docker:
`/app/data/save.json`). This includes:

- JWT signing secret
- Agent auth token

Initial bootstrap login defaults to username `admin` and password `admin`
unless overridden with `OVERLORD_USER` / `OVERLORD_PASS`.

Keep `save.json` private and backed up. Use values from that file if you need
to recover JWT or agent token values.

to update run

```sh
docker compose pull
```

### Faster local rebuilds (BuildKit cache)

`docker-compose.yml` now includes local BuildKit cache settings under `build.cache_from` / `build.cache_to`.
Use these commands when changing source code and rebuilding locally:

```sh
docker compose build
docker compose up -d
```

or in one step:

```sh
docker compose up --build -d
```

Build cache is stored in `.docker-cache/buildx` and reused across builds.

### UI client build cache (runtime)

Client builds triggered from the Overlord UI now use a dedicated persistent cache volume:

- volume: `overlord-client-build-cache`
- mount path: `/app/client-build-cache`
- env var: `OVERLORD_CLIENT_BUILD_CACHE_DIR` (default `/app/client-build-cache`)

This cache is used only for runtime client builds (`go build` / `garble build` from the Build page) and stays warm across container restarts and updates.

## Docker TLS with certbot

If you want to avoid self-signed certificates in Docker/production, enable certbot TLS settings:

- Set `OVERLORD_TLS_CERTBOT_ENABLED=true`
- Set `OVERLORD_TLS_CERTBOT_DOMAIN=your-domain.com`
- Mount letsencrypt into the container (for example `- /etc/letsencrypt:/etc/letsencrypt:ro`)

By default Overlord reads:

- cert: `/etc/letsencrypt/live/<domain>/fullchain.pem`
- key: `/etc/letsencrypt/live/<domain>/privkey.pem`
- ca: `/etc/letsencrypt/live/<domain>/chain.pem`

These can be changed with:
`OVERLORD_TLS_CERTBOT_LIVE_PATH`,
`OVERLORD_TLS_CERTBOT_CERT_FILE`,
`OVERLORD_TLS_CERTBOT_KEY_FILE`, and
`OVERLORD_TLS_CERTBOT_CA_FILE`.

It's literally just docker any question chatgpt can answer so don't worry.

## Reverse proxy TLS offload (Render, etc.)

Some platforms (such as Render Web Services) terminate TLS at the edge and expect your container to serve plain HTTP on the internal port.

For those platforms, set:

- `OVERLORD_TLS_OFFLOAD=true`

Defaults are unchanged. If `OVERLORD_TLS_OFFLOAD` is not set (or false), Overlord keeps its current behavior and serves HTTPS/WSS directly with configured/self-signed/certbot certificates.

When offload mode is enabled:

- Container listener is `http://0.0.0.0:$PORT` (internal only)
- External URL should still be `https://...` via your platform proxy
- Health checks should target `http://localhost:$PORT/health` inside the container
- Do not expose the internal container port directly to the public internet

## Using-Production-packages-(Windows)

Build a production-ready package where the server can still build client binaries at runtime:

```bat
build-prod-package.bat
```

Linux/macOS:

```bash
./build-prod-package.sh
```

Windows output folder:

```text
release
```

Windows package includes:
- `Overlord-Client`
- `overlord-server.exe`
- `overlord-server-linux-x64`
- `start-prod-release.bat`
- `start-prod-release.sh`
- `public`

`build-prod-package.bat` also minifies `public/assets/*.js` into the release package.

Note: both packaging scripts always skip building client binaries and export `Overlord-Client` source for runtime builds.
