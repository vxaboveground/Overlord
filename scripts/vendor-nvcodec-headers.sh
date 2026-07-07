#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEST_DIR="${ROOT_DIR}/Overlord-Client/third_party/nvcodec"
DEST_HEADER="${DEST_DIR}/nvEncodeAPI.h"
REPO_URL="${NV_CODEC_HEADERS_REPO:-https://github.com/FFmpeg/nv-codec-headers.git}"
REF="${NV_CODEC_HEADERS_REF:-master}"
FORCE="${FORCE_NV_CODEC_HEADERS:-0}"

if [[ "${1:-}" == "--force" ]]; then
  FORCE=1
fi

if [[ -s "${DEST_HEADER}" && "${FORCE}" != "1" ]]; then
  echo "nvEncodeAPI.h already exists: ${DEST_HEADER}"
  echo "Use --force or FORCE_NV_CODEC_HEADERS=1 to refresh it."
  exit 0
fi

command -v git >/dev/null 2>&1 || {
  echo "git is required to vendor nv-codec-headers" >&2
  exit 1
}

TMP_DIR="${DEST_DIR}/.nv-codec-headers.tmp"
rm -rf "${TMP_DIR}"
mkdir -p "${DEST_DIR}"

echo "Cloning ${REPO_URL} (${REF})..."
git clone --depth 1 --branch "${REF}" "${REPO_URL}" "${TMP_DIR}"

SRC_HEADER="${TMP_DIR}/include/ffnvcodec/nvEncodeAPI.h"
if [[ ! -s "${SRC_HEADER}" ]]; then
  echo "Expected header not found: ${SRC_HEADER}" >&2
  rm -rf "${TMP_DIR}"
  exit 1
fi

cp "${SRC_HEADER}" "${DEST_HEADER}"
rm -rf "${TMP_DIR}"

echo "Vendored ${DEST_HEADER}"
