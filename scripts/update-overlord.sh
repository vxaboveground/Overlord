#!/usr/bin/env bash
# Manual one-shot updater — pulls latest GHCR image and restarts.
set -euo pipefail

ROOT="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/docker-compose.yml"
DOCKER_IMAGE="${DOCKER_IMAGE:-ghcr.io/vxaboveground/overlord:latest}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found" >&2
  exit 1
fi

echo "[1/3] Pulling latest image: $DOCKER_IMAGE"
docker pull "$DOCKER_IMAGE"

echo "[2/3] Restarting Overlord..."
DOCKER_IMAGE="$DOCKER_IMAGE" docker compose -f "$COMPOSE_FILE" up -d

echo "[3/3] Status"
docker compose -f "$COMPOSE_FILE" ps
