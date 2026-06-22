#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="${1:-${ROOT_DIR}}"
NATIVE_DIR="${PLUGIN_DIR}/native"
PLUGIN_NAME="sample-rust"
ZIP_OUT="${PLUGIN_DIR}/${PLUGIN_NAME}.zip"

if [[ ! -f "${NATIVE_DIR}/Cargo.toml" ]]; then
  echo "[error] native/Cargo.toml not found in ${NATIVE_DIR}" >&2
  exit 1
fi

# Detect current OS/arch
HOST_OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
HOST_ARCH="$(uname -m)"
case "${HOST_ARCH}" in
  x86_64)  HOST_ARCH="amd64" ;;
  aarch64) HOST_ARCH="arm64" ;;
  arm64)   HOST_ARCH="arm64" ;;
esac
case "${HOST_OS}" in
  linux)  HOST_OS="linux"  ;;
  darwin) HOST_OS="darwin" ;;
esac

DEFAULT_TARGETS="${HOST_OS}-${HOST_ARCH}"
BUILD_TARGETS="${BUILD_TARGETS:-${DEFAULT_TARGETS}}"

BUILT_FILES=()

for target in ${BUILD_TARGETS}; do
  os="${target%%-*}"
  arch="${target#*-}"

  if [[ "${os}" == "windows" ]]; then
    ext="dll"
    rust_target="x86_64-pc-windows-gnu"
    [[ "${arch}" == "arm64" ]] && rust_target="aarch64-pc-windows-gnullvm"
    lib_name="sample_rust.dll"
  elif [[ "${os}" == "darwin" ]]; then
    ext="dylib"
    rust_target="x86_64-apple-darwin"
    [[ "${arch}" == "arm64" ]] && rust_target="aarch64-apple-darwin"
    lib_name="libsample_rust.dylib"
  else
    ext="so"
    rust_target="x86_64-unknown-linux-gnu"
    [[ "${arch}" == "arm64" ]] && rust_target="aarch64-unknown-linux-gnu"
    lib_name="libsample_rust.so"
  fi

  outfile="${PLUGIN_DIR}/${PLUGIN_NAME}-${os}-${arch}.${ext}"
  echo "[build] cargo build --release --target=${rust_target} in ${NATIVE_DIR}"
  (cd "${NATIVE_DIR}" && cargo build --release --target="${rust_target}")
  cp "${NATIVE_DIR}/target/${rust_target}/release/${lib_name}" "${outfile}"
  BUILT_FILES+=("${PLUGIN_NAME}-${os}-${arch}.${ext}")
done

rm -f "${ZIP_OUT}"

# Collect files to zip
ZIP_FILES=()
for bf in "${BUILT_FILES[@]}"; do
  ZIP_FILES+=("${bf}")
done
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

echo "[ok] ${ZIP_OUT}"
