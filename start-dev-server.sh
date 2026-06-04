#!/usr/bin/env bash
set -eu
ROOT="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$ROOT/Overlord-Server"
BUN_BIN="${BUN_BIN:-bun}"

# detect platform
OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM="mac";;
  Linux) PLATFORM="linux";;
  *) PLATFORM="unknown";;
esac

echo "[server] platform detected: $OS ($PLATFORM)"

cd "$SERVER_DIR"
if ! command -v "$BUN_BIN" >/dev/null 2>&1; then
    echo "[server] bun not found. Set BUN_BIN to your bun binary or install bun for this environment." >&2
    exit 1
fi
echo "[server] using bun at: $(command -v $BUN_BIN)"
echo "[server] bun install..."
"$BUN_BIN" install
echo "[server] building Tailwind CSS..."
"$BUN_BIN" run build:css
echo "[server] building vendor assets..."
"$BUN_BIN" run vendor
echo "[server] starting bun dev (foreground)"
# Use exec so the script process is replaced by the bun process. This keeps the
# bun process as a child of the dispatcher so the dispatcher can kill it.
export OVERLORD_AGENT_TOKEN="dev-token-insecure-local-only"
exec "$BUN_BIN" run dev
