#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Container-based integration test for the typed memory provider.
# Requires Podman (or Docker). No API keys, no network, no GPU.
#
# Usage: bash test/integration/memory-e2e.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Use podman if available, fall back to docker
CONTAINER_CMD="${CONTAINER_CMD:-$(command -v podman || command -v docker || echo "")}"
if [[ -z "$CONTAINER_CMD" ]]; then
  echo "ERROR: Neither podman nor docker found on PATH."
  exit 1
fi

IMAGE_NAME="nemoclaw-memory-e2e-test"
CONTAINER_NAME="nemoclaw-memory-e2e-$$"

echo "=== NemoClaw Memory Provider E2E Test ==="
echo "Container runtime: $CONTAINER_CMD"
echo ""

# ---------------------------------------------------------------------------
# 1. Build the plugin
# ---------------------------------------------------------------------------

echo "--- Building plugin ---"
(cd "$REPO_ROOT/nemoclaw" && npm run build)
echo ""

# ---------------------------------------------------------------------------
# 2. Build a minimal test container
# ---------------------------------------------------------------------------

echo "--- Building test container ---"
cat <<'DOCKERFILE' | "$CONTAINER_CMD" build -t "$IMAGE_NAME" -f - "$REPO_ROOT"
FROM node:22-slim
WORKDIR /app
COPY nemoclaw/dist/ /app/nemoclaw/dist/
COPY nemoclaw/package.json /app/nemoclaw/package.json
COPY test/integration/memory-index.mjs /app/test/integration/memory-index.mjs
COPY test/integration/fixtures/ /app/test/integration/fixtures/
RUN cd /app/nemoclaw && npm install --omit=dev --ignore-scripts 2>/dev/null || true
DOCKERFILE
echo ""

# ---------------------------------------------------------------------------
# 3. Run the integration test inside the container
# ---------------------------------------------------------------------------

echo "--- Running integration test in container ---"
"$CONTAINER_CMD" run --rm --name "$CONTAINER_NAME" "$IMAGE_NAME" \
  node /app/test/integration/memory-index.mjs

EXIT_CODE=$?

# ---------------------------------------------------------------------------
# 4. Cleanup
# ---------------------------------------------------------------------------

echo ""
echo "--- Cleanup ---"
"$CONTAINER_CMD" rmi "$IMAGE_NAME" --force 2>/dev/null || true
echo "Done."

exit $EXIT_CODE
