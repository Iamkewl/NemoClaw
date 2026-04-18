#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Verifies that pinned SHA-256 hashes for downloaded installers still match
# the current upstream scripts.
#
# Checked installers:
#   1. NemoClaw installer  — k8s/nemoclaw-k8s.yaml  (NEMOCLAW_INSTALLER_SHA256)
#   2. Ollama installer    — scripts/install.sh      (OLLAMA_INSTALL_SHA256)
#
# Usage:
#   scripts/check-installer-hash.sh            # exit 0 if current, 1 if stale
#   scripts/check-installer-hash.sh --update   # rewrite stale hashes in-place

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

case "${1:-}" in
  "" | --update) ;;
  *)
    echo "Usage: scripts/check-installer-hash.sh [--update]" >&2
    exit 2
    ;;
esac

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
fetch_hash() {
  local url="$1" tmpfile
  tmpfile=$(mktemp)
  trap 'rm -f "$tmpfile"' RETURN

  curl --proto '=https' --tlsv1.2 -fsSL \
    --connect-timeout 10 --max-time 30 \
    --retry 3 --retry-delay 1 --retry-all-errors \
    -o "$tmpfile" "$url"

  sha256sum "$tmpfile" | cut -d' ' -f1
}

extract_pinned() {
  local file="$1" var_name="$2"
  sed -n "s/.*${var_name}=\"\\([a-f0-9]\\{64\\}\\)\".*/\\1/p" "$file" | head -1
}

update_pinned() {
  local file="$1" old_hash="$2" new_hash="$3"
  sed -i.bak "s/${old_hash}/${new_hash}/" "$file"
  rm -f "${file}.bak"
}

# ---------------------------------------------------------------------------
# Registry of pinned hashes: (label, file, variable, upstream URL)
# ---------------------------------------------------------------------------
LABELS=()
FILES=()
VARS=()
URLS=()

register() { LABELS+=("$1"); FILES+=("$2"); VARS+=("$3"); URLS+=("$4"); }

register "NemoClaw k8s installer" \
  "${REPO_ROOT}/k8s/nemoclaw-k8s.yaml" \
  "NEMOCLAW_INSTALLER_SHA256" \
  "https://www.nvidia.com/nemoclaw.sh"

register "Ollama installer" \
  "${REPO_ROOT}/scripts/install.sh" \
  "OLLAMA_INSTALL_SHA256" \
  "https://ollama.com/install.sh"

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
failures=0

for i in "${!LABELS[@]}"; do
  label="${LABELS[$i]}"
  file="${FILES[$i]}"
  var="${VARS[$i]}"
  url="${URLS[$i]}"

  pinned=$(extract_pinned "$file" "$var")

  if [[ -z "$pinned" ]]; then
    echo "ERROR: no ${var} found in ${file}" >&2
    failures=$((failures + 1))
    continue
  fi

  echo "Checking ${label} (${var})..."
  echo "  Fetching ${url}..."
  upstream=$(fetch_hash "$url")

  if [[ "$pinned" == "$upstream" ]]; then
    echo "  OK: hash is up-to-date (${pinned})"
    continue
  fi

  if [[ "${1:-}" == "--update" ]]; then
    update_pinned "$file" "$pinned" "$upstream"
    echo "  UPDATED ${file}: ${var}"
    echo "    old: ${pinned}"
    echo "    new: ${upstream}"
  else
    echo "  STALE: pinned hash does not match upstream."
    echo "    pinned:   ${pinned}"
    echo "    upstream: ${upstream}"
    failures=$((failures + 1))
  fi
done

if ((failures > 0)); then
  echo ""
  echo "${failures} hash(es) are stale. To update, run:"
  echo ""
  echo "  scripts/check-installer-hash.sh --update"
  echo ""
  exit 1
fi

echo ""
echo "All installer hashes are current."
