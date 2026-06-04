#!/usr/bin/env bash
set -eu
ROOT="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT_DIR="$ROOT/Overlord-Client"
DIST_DIR="$ROOT/dist-clients"
GO_BIN="${GO_BIN:-go}"
GO_TAGS=()

if [ "${NO_PRINTING:-false}" = "true" ]; then
  echo "[client] printing disabled via build tags"
  GO_TAGS+=("-tags" "noprint")
fi

# detect platform
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin) PLATFORM="mac";;
  Linux) PLATFORM="linux";;
  FreeBSD) PLATFORM="freebsd";;
  OpenBSD) PLATFORM="openbsd";;
  *) PLATFORM="unknown";;
esac

echo "[client] platform detected: $OS ($PLATFORM) arch: $ARCH"

# determine expected dist binary name
BIN_NAME=""
if [ "$PLATFORM" = "mac" ]; then
  if [ "$ARCH" = "x86_64" ]; then
    BIN_NAME="agent-darwin-amd64"
  else
    BIN_NAME="agent-darwin-arm64"
  fi
elif [ "$PLATFORM" = "linux" ]; then
  BIN_NAME="agent-linux-amd64"
elif [ "$PLATFORM" = "freebsd" ]; then
  if [ "$ARCH" = "x86_64" ]; then
    BIN_NAME="agent-freebsd-amd64"
  elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
    BIN_NAME="agent-freebsd-arm64"
  fi
elif [ "$PLATFORM" = "openbsd" ]; then
  if [ "$ARCH" = "x86_64" ]; then
    BIN_NAME="agent-openbsd-amd64"
  elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
    BIN_NAME="agent-openbsd-arm64"
  fi
fi

if [ "$PLATFORM" != "mac" ] && [ -n "$BIN_NAME" ] && [ -x "$DIST_DIR/$BIN_NAME" ]; then
  echo "[client] found prebuilt client binary: $DIST_DIR/$BIN_NAME"
  echo "[client] starting prebuilt agent"
  OVERLORD_SERVER="wss://localhost:5173" \
  OVERLORD_AGENT_TOKEN="dev-token-insecure-local-only" \
  OVERLORD_TLS_INSECURE_SKIP_VERIFY="true" \
  OVERLORD_MODE="dev" \
  "${DIST_DIR:?}/$BIN_NAME"
  exit 0
fi

if [ "$PLATFORM" = "mac" ]; then
  echo "[client] macOS dev mode uses a rebuilt stable binary"
else
  echo "[client] no suitable prebuilt client binary found in $DIST_DIR; falling back to 'go run'"
fi

cd "$CLIENT_DIR"
if ! command -v "$GO_BIN" >/dev/null 2>&1; then
    echo "[client] go not found. Set GO_BIN to your Go binary (>=1.21) or install Go." >&2
    exit 1
fi
GO_VER=$($GO_BIN env GOVERSION 2>/dev/null || true)
GO_MINOR=$(echo "$GO_VER" | sed -E 's/^go[0-9]+\.([0-9]+).*/\1/')
if [ -z "$GO_MINOR" ]; then
    echo "[client] unable to determine Go version (got '$GO_VER')." >&2
    exit 1
fi
if [ "$GO_MINOR" -lt 21 ]; then
    echo "[client] Go >=1.21 required (found $GO_VER). Install a newer Go or point GO_BIN to one." >&2
    exit 1
fi
echo "[client] using go at: $(command -v $GO_BIN) ($GO_VER)"
echo "[client] go mod tidy..."
GOTOOLCHAIN=${GOTOOLCHAIN:-auto} \
"$GO_BIN" mod tidy

if [ "$PLATFORM" = "mac" ] && [ -n "$BIN_NAME" ]; then
  mkdir -p "$DIST_DIR"
  DEV_BIN="$DIST_DIR/$BIN_NAME"
  echo "[client] building stable macOS dev binary at $DEV_BIN"
  if [ "${#GO_TAGS[@]}" -gt 0 ]; then
    GOINSECURE="*" \
    GOPROXY="https://proxy.golang.org,direct" \
    GOTOOLCHAIN=${GOTOOLCHAIN:-auto} \
    "$GO_BIN" build "${GO_TAGS[@]}" -o "$DEV_BIN" ./cmd/agent
  else
    GOINSECURE="*" \
    GOPROXY="https://proxy.golang.org,direct" \
    GOTOOLCHAIN=${GOTOOLCHAIN:-auto} \
    "$GO_BIN" build -o "$DEV_BIN" ./cmd/agent
  fi

  echo "[client] starting stable macOS dev binary"
  OVERLORD_SERVER="wss://localhost:5173" \
  OVERLORD_AGENT_TOKEN="dev-token-insecure-local-only" \
  OVERLORD_TLS_INSECURE_SKIP_VERIFY="true" \
  OVERLORD_MODE="dev" \
  exec "$DEV_BIN"
fi

echo "[client] starting agent via 'go run'"
if [ "${#GO_TAGS[@]}" -gt 0 ]; then
  OVERLORD_SERVER="wss://localhost:5173" \
  OVERLORD_AGENT_TOKEN="dev-token-insecure-local-only" \
  OVERLORD_TLS_INSECURE_SKIP_VERIFY="true" \
  OVERLORD_MODE="dev" \
  GOINSECURE="*" \
  GOPROXY="https://proxy.golang.org,direct" \
  GOTOOLCHAIN=${GOTOOLCHAIN:-auto} \
  "$GO_BIN" run "${GO_TAGS[@]}" ./cmd/agent
else
  OVERLORD_SERVER="wss://localhost:5173" \
  OVERLORD_AGENT_TOKEN="dev-token-insecure-local-only" \
  OVERLORD_TLS_INSECURE_SKIP_VERIFY="true" \
  OVERLORD_MODE="dev" \
  GOINSECURE="*" \
  GOPROXY="https://proxy.golang.org,direct" \
  GOTOOLCHAIN=${GOTOOLCHAIN:-auto} \
  "$GO_BIN" run ./cmd/agent
fi
