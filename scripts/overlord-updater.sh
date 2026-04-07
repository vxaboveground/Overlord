#!/usr/bin/env bash
# ============================================================================
# overlord-updater.sh — Host-side update daemon for Overlord
#
# Watches a trigger file written by the in-app updater API and performs the
# actual docker image pull + restart cycle on the host.
#
# Usage:
#   ./scripts/overlord-updater.sh              # run in foreground
#   systemctl start overlord-updater           # run as systemd service
#
# The daemon polls every POLL_INTERVAL seconds for a trigger file at:
#   <DATA_DIR>/update-request.json
#
# Progress is written to:
#   <DATA_DIR>/update-status.json
#
# Environment variables:
#   OVERLORD_ROOT       — Path to the Overlord repo (default: parent of scripts/)
#   OVERLORD_DATA_DIR   — Path to the data directory (default: Docker volume mount)
#   POLL_INTERVAL       — Seconds between polls (default: 5)
#   DOCKER_IMAGE        — Full image reference (default: ghcr.io/vxaboveground/overlord)
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OVERLORD_ROOT="${OVERLORD_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
COMPOSE_FILE="$OVERLORD_ROOT/docker-compose.yml"

DOCKER_IMAGE="${DOCKER_IMAGE:-ghcr.io/vxaboveground/overlord}"

# Determine the data directory. When Docker uses a named volume, the path is
# typically /var/lib/docker/volumes/overlord-data/_data. Allow override.
if [ -z "${OVERLORD_DATA_DIR:-}" ]; then
  # Try to discover from Docker named volume
  OVERLORD_DATA_DIR="$(docker volume inspect overlord-data --format '{{ .Mountpoint }}' 2>/dev/null || true)"
  if [ -z "$OVERLORD_DATA_DIR" ] || [ ! -d "$OVERLORD_DATA_DIR" ]; then
    # Fallback: local data dir in repo
    OVERLORD_DATA_DIR="$OVERLORD_ROOT/data"
  fi
fi

POLL_INTERVAL="${POLL_INTERVAL:-5}"
REQUEST_FILE="$OVERLORD_DATA_DIR/update-request.json"
STATUS_FILE="$OVERLORD_DATA_DIR/update-status.json"

echo "[overlord-updater] Root:     $OVERLORD_ROOT"
echo "[overlord-updater] Data dir: $OVERLORD_DATA_DIR"
echo "[overlord-updater] Image:    $DOCKER_IMAGE"
echo "[overlord-updater] Polling every ${POLL_INTERVAL}s for: $REQUEST_FILE"

# ---- Helpers ----

write_status() {
  local state="$1"
  local message="$2"
  local progress="$3"
  local target_version="${4:-}"
  local log_line="${5:-}"

  # Build log array incrementally
  local existing_log="[]"
  if [ -f "$STATUS_FILE" ]; then
    existing_log="$(jq -r '.log // []' "$STATUS_FILE" 2>/dev/null || echo '[]')"
  fi

  if [ -n "$log_line" ]; then
    existing_log="$(echo "$existing_log" | jq --arg l "$log_line" '. + [$l]')"
  fi

  # Reset log on new update cycle
  if [ "$state" = "pending" ] && [ "$progress" = "0" ]; then
    existing_log="[]"
    if [ -n "$log_line" ]; then
      existing_log="$(echo '[]' | jq --arg l "$log_line" '. + [$l]')"
    fi
  fi

  jq -n \
    --arg state "$state" \
    --arg message "$message" \
    --argjson progress "$progress" \
    --argjson updatedAt "$(date +%s000)" \
    --arg targetVersion "$target_version" \
    --argjson log "$existing_log" \
    '{state: $state, message: $message, progress: $progress, updatedAt: $updatedAt, targetVersion: $targetVersion, log: $log}' \
    > "$STATUS_FILE"
}

cleanup_request() {
  rm -f "$REQUEST_FILE"
}

# ---- Main update procedure ----

run_update() {
  local target_version
  target_version="$(jq -r '.targetVersion // "unknown"' "$REQUEST_FILE" 2>/dev/null || echo "unknown")"
  local requested_by
  requested_by="$(jq -r '.requestedBy // "unknown"' "$REQUEST_FILE" 2>/dev/null || echo "unknown")"

  echo "[overlord-updater] Update requested by $requested_by to version $target_version"

  write_status "pending" "Update request received. Starting..." 5 "$target_version" "Update requested by $requested_by for version $target_version"

  # Step 1: Pull the new image from GHCR
  local image_ref="${DOCKER_IMAGE}:${target_version}"
  write_status "pulling" "Pulling image ${image_ref} from registry..." 15 "$target_version" "Running: docker pull ${image_ref}"

  local pull_output
  if pull_output="$(docker pull "$image_ref" 2>&1)"; then
    write_status "pulling" "Image pulled successfully." 40 "$target_version" "$pull_output"
  else
    write_status "error" "Image pull failed: $pull_output" 15 "$target_version" "ERROR: docker pull failed: $pull_output"
    cleanup_request
    return 1
  fi

  # Step 2 + 3: Recreate only the server container with the new image.
  # We deliberately target overlord-server only — bringing the whole stack
  # down would kill this updater sidecar before it could restart anything.
  write_status "restarting" "Recreating server container with new image..." 55 "$target_version" "Running: DOCKER_IMAGE=${image_ref} docker compose up -d overlord-server"

  local compose_up_output
  if compose_up_output="$(DOCKER_IMAGE="$image_ref" docker compose -f "$COMPOSE_FILE" up -d overlord-server 2>&1)"; then
    write_status "restarting" "Container started. Waiting for health check..." 80 "$target_version" "$compose_up_output"
  else
    write_status "error" "docker compose up failed: $compose_up_output" 60 "$target_version" "ERROR: docker compose up failed: $compose_up_output"
    cleanup_request
    return 1
  fi

  # Step 4: Wait for health check
  local max_wait=120
  local waited=0
  while [ $waited -lt $max_wait ]; do
    local health
    health="$(docker inspect --format='{{.State.Health.Status}}' overlord-server 2>/dev/null || echo "unknown")"
    if [ "$health" = "healthy" ]; then
      break
    fi
    sleep 5
    waited=$((waited + 5))
    local pct=$((80 + (waited * 15 / max_wait)))
    write_status "restarting" "Waiting for container health... ($waited/${max_wait}s)" "$pct" "$target_version"
  done

  cleanup_request

  local final_health
  final_health="$(docker inspect --format='{{.State.Health.Status}}' overlord-server 2>/dev/null || echo "unknown")"

  if [ "$final_health" = "healthy" ]; then
    write_status "done" "Update to $target_version completed successfully." 100 "$target_version" "Container is healthy. Update complete."
    echo "[overlord-updater] Update to $target_version completed successfully."
  else
    write_status "done" "Update to $target_version applied. Container health: $final_health (may still be starting)." 100 "$target_version" "Container health: $final_health. May need more time to start."
    echo "[overlord-updater] Update applied but health is: $final_health"
  fi
}

# ---- Poll loop ----

trap 'echo "[overlord-updater] Shutting down."; exit 0' SIGTERM SIGINT

while true; do
  if [ -f "$REQUEST_FILE" ]; then
    run_update || true
  fi
  sleep "$POLL_INTERVAL"
done
