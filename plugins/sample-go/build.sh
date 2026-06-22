#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="${1:-${ROOT_DIR}}"
NATIVE_DIR="${PLUGIN_DIR}/native"
PLUGIN_NAME="sample"
ZIP_OUT="${PLUGIN_DIR}/${PLUGIN_NAME}.zip"

if [[ ! -d "${NATIVE_DIR}" ]]; then
  echo "[error] native folder not found: ${NATIVE_DIR}" >&2
  exit 1
fi

pushd "${NATIVE_DIR}" >/dev/null

# Detect current OS/arch for default build
HOST_OS="$(go env GOOS)"
HOST_ARCH="$(go env GOARCH)"

# Build matrix - can be overridden with BUILD_TARGETS env var
# Format: "os-arch os-arch ..."  e.g. "linux-amd64 linux-arm64 darwin-arm64"
DEFAULT_TARGETS="${HOST_OS}-${HOST_ARCH}"
BUILD_TARGETS="${BUILD_TARGETS:-${DEFAULT_TARGETS}}"

BUILT_FILES=()

for target in ${BUILD_TARGETS}; do
  os="${target%%-*}"
  arch="${target#*-}"

  if [[ "${os}" == "windows" ]]; then
    ext="dll"
  elif [[ "${os}" == "darwin" ]]; then
    ext="dylib"
  else
    ext="so"
  fi
  buildmode="c-shared"

  outfile="${PLUGIN_DIR}/${PLUGIN_NAME}-${os}-${arch}.${ext}"
  echo "[build] GOOS=${os} GOARCH=${arch} CGO_ENABLED=1 go build -buildmode=${buildmode} -o ${outfile}"
  CGO_ENABLED=1 GOOS="${os}" GOARCH="${arch}" go build -buildmode="${buildmode}" -o "${outfile}" .
  BUILT_FILES+=("${PLUGIN_NAME}-${os}-${arch}.${ext}")
done

popd >/dev/null

rm -f "${ZIP_OUT}"

# Collect files to zip
ZIP_FILES=()
for bf in "${BUILT_FILES[@]}"; do
  ZIP_FILES+=("${bf}")
done
# Add web assets
for asset in "${PLUGIN_NAME}.html" "${PLUGIN_NAME}.css" "${PLUGIN_NAME}.js"; do
  if [[ -f "${PLUGIN_DIR}/${asset}" ]]; then
    ZIP_FILES+=("${asset}")
  fi
done

if command -v zip >/dev/null 2>&1; then
  (cd "${PLUGIN_DIR}" && zip -q "${ZIP_OUT}" "${ZIP_FILES[@]}")
else
  echo "[error] zip not found. Please install zip." >&2
  exit 1
fi

# Optional: sign the plugin if PLUGIN_SIGN_KEY is set
if [[ -n "${PLUGIN_SIGN_KEY:-}" ]]; then
  if command -v bun >/dev/null 2>&1; then
    echo "[sign] Signing plugin with key: ${PLUGIN_SIGN_KEY}"
    bun run "${ROOT_DIR}/../../Overlord-Server/scripts/plugin-sign.ts" --key "${PLUGIN_SIGN_KEY}" "${ZIP_OUT}"
  else
    echo "[warn] bun not found, skipping plugin signing" >&2
  fi
fi

echo "[ok] ${ZIP_OUT}"
