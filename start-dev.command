#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname "$0")" && pwd)"
SERVER_SCRIPT="$ROOT/start-dev-server.sh"
CLIENT_SCRIPT="$ROOT/start-dev-client.sh"

quote() {
  printf "%q" "$1"
}

pause_for_error() {
  local exit_code=$?
  if [ "$exit_code" -ne 0 ]; then
    echo
    echo "[start-dev] failed with exit code $exit_code"
    echo "Press any key to close this window."
    read -r -n 1 _ || true
  fi
  exit "$exit_code"
}
trap pause_for_error EXIT

if [ "$(uname -s)" != "Darwin" ]; then
  echo "[start-dev] start-dev.command is intended for macOS."
  echo "[start-dev] Use ./start-dev.sh on this platform."
  exit 1
fi

if ! command -v osascript >/dev/null 2>&1; then
  echo "[start-dev] osascript was not found. Use ./start-dev.sh from a terminal instead."
  exit 1
fi

if [ ! -f "$SERVER_SCRIPT" ]; then
  echo "[start-dev] missing $SERVER_SCRIPT" >&2
  exit 1
fi

if [ ! -f "$CLIENT_SCRIPT" ]; then
  echo "[start-dev] missing $CLIENT_SCRIPT" >&2
  exit 1
fi

ROOT_Q="$(quote "$ROOT")"
SERVER_SCRIPT_Q="$(quote "$SERVER_SCRIPT")"
CLIENT_SCRIPT_Q="$(quote "$CLIENT_SCRIPT")"
NO_PRINTING_Q="$(quote "${NO_PRINTING:-false}")"

SERVER_CMD="cd $ROOT_Q && HOST=0.0.0.0 PORT=5173 OVERLORD_DISABLE_AGENT_AUTH=true OVERLORD_AGENT_TOKEN=dev-token-insecure-local-only LOG_LEVEL=debug NODE_ENV=development /bin/bash $SERVER_SCRIPT_Q"
CLIENT_CMD="sleep 3; cd $ROOT_Q && NO_PRINTING=$NO_PRINTING_Q /bin/bash $CLIENT_SCRIPT_Q"

open_terminal() {
  local title="$1"
  local command="$2"

  osascript - "$title" "$command" <<'APPLESCRIPT'
on run argv
  set windowTitle to item 1 of argv
  set shellCommand to item 2 of argv

  tell application "Terminal"
    activate
    do script shellCommand
    delay 0.2
    set custom title of selected tab of front window to windowTitle
  end tell
end run
APPLESCRIPT
}

echo "=== Launching Overlord dev terminals ==="
echo "[start-dev] root: $ROOT"
echo "[start-dev] opening server window..."
open_terminal "Overlord-Server" "$SERVER_CMD"

echo "[start-dev] opening client window..."
open_terminal "Overlord-Client" "$CLIENT_CMD"

echo
echo "Done. Server and client logs are running in separate Terminal windows."
echo "Close those Terminal windows or press Ctrl+C inside them to stop dev processes."
