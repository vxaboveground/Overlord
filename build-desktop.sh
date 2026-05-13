#!/usr/bin/env bash
set -euo pipefail
echo "=== Building Overlord Desktop (Tauri) ==="
cd "$(dirname "$0")/Overlord-Desktop"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun is required (https://bun.sh)" >&2
  exit 1
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "error: rust toolchain is required (https://rustup.rs)" >&2
  exit 1
fi

bun install
bun run vendor

case "$(uname -s)" in
  Linux*)   bun run build:linux ;;
  Darwin*)  bun run build:mac ;;
  MINGW*|MSYS*|CYGWIN*) bun run build:win ;;
  *)        bun run build ;;
esac

echo "=== Done — bundle output: Overlord-Desktop/src-tauri/target/release/bundle/ ==="
