#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="${1:-${ROOT_DIR}}"
NATIVE_DIR="${PLUGIN_DIR}/native"
PLUGIN_NAME="sample-cpp"
ZIP_OUT="${PLUGIN_DIR}/${PLUGIN_NAME}.zip"

if [[ ! -f "${NATIVE_DIR}/plugin.cpp" ]]; then
  echo "[error] native/plugin.cpp not found in ${NATIVE_DIR}" >&2
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

# Resolve the C++ compiler for a given target os-arch pair.
# Override with CXX=<compiler> for custom toolchains.
resolve_cxx() {
  local t_os="$1" t_arch="$2"

  # Honour explicit CXX override
  if [[ -n "${CXX:-}" ]]; then echo "${CXX}"; return; fi

  # Native compilation
  if [[ "${t_os}" == "${HOST_OS}" && "${t_arch}" == "${HOST_ARCH}" ]]; then
    echo "g++"; return
  fi

  # Cross-compilation
  case "${t_os}-${t_arch}" in
    linux-amd64)    echo "x86_64-linux-gnu-g++" ;;
    linux-arm64)    echo "aarch64-linux-gnu-g++" ;;
    linux-arm)      echo "arm-linux-gnueabihf-g++" ;;
    windows-amd64)  echo "x86_64-w64-mingw32-g++" ;;
    windows-arm64)  echo "aarch64-w64-mingw32-g++" ;;
    darwin-amd64)   echo "x86_64-apple-darwin-g++" ;;
    darwin-arm64)   echo "aarch64-apple-darwin-g++" ;;
    *)              echo "g++" ;;
  esac
}

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

  cxx="$(resolve_cxx "${os}" "${arch}")"
  if ! command -v "${cxx}" >/dev/null 2>&1; then
    echo "[error] cross-compiler '${cxx}' not found for ${os}-${arch}. Install it or set CXX=<compiler>." >&2
    exit 1
  fi

  outfile="${PLUGIN_DIR}/${PLUGIN_NAME}-${os}-${arch}.${ext}"
  echo "[build] ${cxx} -shared -fPIC -O2 -o ${outfile} ${NATIVE_DIR}/plugin.cpp"
  ${cxx} -shared -fPIC -O2 -o "${outfile}" "${NATIVE_DIR}/plugin.cpp"
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
