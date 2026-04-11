#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Container-based memory benchmark.
# Compares flat MEMORY.md vs typed index at various scales.
# Outputs a markdown report to docs/benchmarks/memory-benchmark-report.md.
#
# Requires Podman (or Docker). No API keys, no network, no GPU.
#
# Usage: bash scripts/benchmark-memory.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPORT_DIR="$REPO_ROOT/docs/benchmarks"
REPORT_PATH="$REPORT_DIR/typed-memory-index-benchmark.md"

CONTAINER_CMD="${CONTAINER_CMD:-$(command -v podman || command -v docker || echo "")}"
if [[ -z "$CONTAINER_CMD" ]]; then
  echo "ERROR: Neither podman nor docker found on PATH."
  exit 1
fi

IMAGE_NAME="nemoclaw-memory-benchmark"
CONTAINER_NAME="nemoclaw-bench-$$"

echo "=== NemoClaw Memory Benchmark ==="
echo "Container runtime: $CONTAINER_CMD"
echo ""

# ---------------------------------------------------------------------------
# 1. Build the plugin
# ---------------------------------------------------------------------------

echo "--- Building plugin ---"
(cd "$REPO_ROOT/nemoclaw" && npm run build)
echo ""

# ---------------------------------------------------------------------------
# 2. Build benchmark container
# ---------------------------------------------------------------------------

echo "--- Building benchmark container ---"
cat <<'DOCKERFILE' | "$CONTAINER_CMD" build -t "$IMAGE_NAME" -f - "$REPO_ROOT"
FROM node:22-slim
WORKDIR /app
COPY nemoclaw/dist/ /app/nemoclaw/dist/
COPY nemoclaw/package.json /app/nemoclaw/package.json
COPY scripts/benchmark-memory-runner.mjs /app/scripts/benchmark-memory-runner.mjs
RUN cd /app/nemoclaw && npm install --omit=dev --ignore-scripts 2>/dev/null || true
RUN cd /app && npm init -y --silent 2>/dev/null && npm install js-tiktoken --ignore-scripts 2>/dev/null || true
DOCKERFILE
echo ""

# ---------------------------------------------------------------------------
# 3. Run benchmark inside container
# ---------------------------------------------------------------------------

echo "--- Running benchmark in container ---"
mkdir -p "$REPORT_DIR"

"$CONTAINER_CMD" run --rm --name "$CONTAINER_NAME" "$IMAGE_NAME" \
  node /app/scripts/benchmark-memory-runner.mjs >"$REPORT_PATH"

echo ""
echo "--- Report written to $REPORT_PATH ---"
echo ""
cat "$REPORT_PATH"

# ---------------------------------------------------------------------------
# 4. Cleanup
# ---------------------------------------------------------------------------

echo ""
echo "--- Cleanup ---"
"$CONTAINER_CMD" rmi "$IMAGE_NAME" --force 2>/dev/null || true
echo "Done."
