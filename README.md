<p align="center">
  <img src="https://raw.githubusercontent.com/vxaboveground/Overlord/refs/heads/main/Overlord-Server/public/assets/353030.png" alt="Overlord" />
</p>

# Overlord

# [TELEGRAM SERVER JOIN NOW NO EXCUSES WE GIVE SUPPORT AND IT'S FUN](https://t.me/WindowsBatch)

Hello, I made this project for fun.

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
- Initial admin bootstrap password

Keep `save.json` private and backed up. Use values from that file if you need
to recover bootstrap access.

to update run

```sh
docker compose pull
```

It's literally just docker any question chatgpt can answer so don't worry.

## Production package (Windows)

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