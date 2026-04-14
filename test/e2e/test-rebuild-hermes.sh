#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Hermes rebuild upgrade E2E — same upgrade scenario as OpenClaw but for Hermes:
#
#   1. Install NemoClaw (install.sh)
#   2. Build a Hermes base image with an OLDER version (v2026.3.12)
#   3. Build a minimal Hermes sandbox image (no current-Dockerfile patches)
#   4. Create sandbox via openshell directly
#   5. Write marker files into Hermes state dirs
#   6. Restore the current Hermes base image
#   7. Run `nemoclaw <name> rebuild --yes`
#   8. Verify marker files survived + version upgraded
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set (real key, starts with nvapi-)
#
# Environment variables:
#   NEMOCLAW_NON_INTERACTIVE=1             — required
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 — required
#   NVIDIA_API_KEY                         — required

set -euo pipefail

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-rebuild-hm}"
OLD_HERMES_VERSION="v2026.3.12"
MARKER_FILE="/sandbox/.hermes-data/memories/rebuild-marker.txt"
MARKER_CONTENT="REBUILD_HM_E2E_$(date +%s)"
REGISTRY_FILE="$HOME/.nemoclaw/sandboxes.json"
SESSION_FILE="$HOME/.nemoclaw/onboard-session.json"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}[PASS]${NC} $1"; }
fail() {
  echo -e "${RED}[FAIL]${NC} $1" >&2
  exit 1
}
info() { echo -e "${YELLOW}[INFO]${NC} $1"; }

# ── Preflight ───────────────────────────────────────────────────────
[ -n "${NVIDIA_API_KEY:-}" ] || fail "NVIDIA_API_KEY is required"
[ "${NEMOCLAW_NON_INTERACTIVE:-}" = "1" ] || fail "NEMOCLAW_NON_INTERACTIVE=1 is required"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

info "Hermes rebuild upgrade E2E (old: ${OLD_HERMES_VERSION}, sandbox: ${SANDBOX_NAME})"

# ── Phase 1: Install NemoClaw ───────────────────────────────────────
info "Phase 1: Installing NemoClaw via install.sh..."

export NEMOCLAW_NON_INTERACTIVE=1
export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
export NEMOCLAW_SANDBOX_NAME="${SANDBOX_NAME}"
export NEMOCLAW_RECREATE_SANDBOX=1
export NEMOCLAW_AGENT=hermes

INSTALL_LOG="/tmp/nemoclaw-e2e-install.log"
bash "${REPO_ROOT}/install.sh" --non-interactive >"$INSTALL_LOG" 2>&1 || true

# Source shell profile to pick up nvm/PATH changes
if [ -f "$HOME/.bashrc" ]; then
  # shellcheck source=/dev/null
  source "$HOME/.bashrc" 2>/dev/null || true
fi
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
fi
if [ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  export PATH="$HOME/.local/bin:$PATH"
fi

command -v nemoclaw >/dev/null 2>&1 || fail "nemoclaw not found on PATH after install"
command -v openshell >/dev/null 2>&1 || fail "openshell not found on PATH after install"
pass "NemoClaw installed"

# Destroy the sandbox that install.sh created — we'll make our own old one
nemoclaw "${SANDBOX_NAME}" destroy --yes 2>/dev/null || true

# ── Phase 2: Build old Hermes base image ───────────────────────────
info "Phase 2: Building Hermes base image with ${OLD_HERMES_VERSION}..."

OLD_BASE_TAG="nemoclaw-hermes-old-base:e2e-rebuild"

docker build \
  --build-arg "HERMES_VERSION=${OLD_HERMES_VERSION}" \
  -f "${REPO_ROOT}/agents/hermes/Dockerfile.base" \
  -t "${OLD_BASE_TAG}" \
  "${REPO_ROOT}" \
  || fail "Failed to build old Hermes base image"

pass "Old Hermes base image built (${OLD_HERMES_VERSION})"

# ── Phase 3: Create old sandbox via openshell ───────────────────────
info "Phase 3: Creating sandbox with old Hermes via openshell..."

# Build a minimal Dockerfile — NOT the full agents/hermes/Dockerfile which
# patches files that may not exist in the old Hermes version.
TESTDIR=$(mktemp -d)
cat >"${TESTDIR}/Dockerfile" <<DOCKERFILE
FROM ${OLD_BASE_TAG}
USER sandbox
WORKDIR /sandbox
RUN mkdir -p /sandbox/.hermes-data/memories \
             /sandbox/.hermes-data/sessions \
             /sandbox/.hermes-data/workspace \
    && echo '{}' > /sandbox/.hermes-data/config.yaml
CMD ["/bin/bash"]
DOCKERFILE

openshell sandbox create --name "${SANDBOX_NAME}" --from "${TESTDIR}/Dockerfile" --no-tty -- true
rm -rf "${TESTDIR}"

# Wait for Ready
for _i in $(seq 1 30); do
  if openshell sandbox list 2>/dev/null | grep -q "${SANDBOX_NAME}.*Ready"; then
    break
  fi
  sleep 5
done
openshell sandbox list 2>/dev/null | grep -q "${SANDBOX_NAME}.*Ready" || fail "Sandbox did not become Ready"

pass "Old Hermes sandbox created"

# ── Phase 4: Write markers + register ───────────────────────────────
info "Phase 4: Writing markers and registering sandbox..."

openshell sandbox exec --name "${SANDBOX_NAME}" -- \
  sh -c "mkdir -p /sandbox/.hermes-data/memories && echo '${MARKER_CONTENT}' > ${MARKER_FILE}" \
  || fail "Failed to write marker file"

VERIFY=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- cat "${MARKER_FILE}" 2>/dev/null || true)
[ "$VERIFY" = "${MARKER_CONTENT}" ] || fail "Marker verification failed"

# Register in NemoClaw registry
python3 -c "
import json
reg = {'sandboxes': {'${SANDBOX_NAME}': {
    'name': '${SANDBOX_NAME}',
    'createdAt': '$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    'model': 'nvidia/nemotron-3-super-120b-a12b',
    'provider': 'nvidia-prod',
    'gpuEnabled': False,
    'policies': [],
    'policyTier': None,
    'agent': 'hermes',
    'agentVersion': '2026.3.12'
}}, 'defaultSandbox': '${SANDBOX_NAME}'}
with open('${REGISTRY_FILE}', 'w') as f:
    json.dump(reg, f, indent=2)

sess_path = '${SESSION_FILE}'
try:
    with open(sess_path) as f:
        sess = json.load(f)
except Exception:
    sess = {}
sess['sandboxName'] = '${SANDBOX_NAME}'
sess['agent'] = 'hermes'
sess['status'] = 'complete'
with open(sess_path, 'w') as f:
    json.dump(sess, f, indent=2)
print('Registry and session updated')
"

pass "Markers written, sandbox registered"

# ── Phase 5: Restore current Hermes base image ─────────────────────
info "Phase 5: Building current Hermes base image..."

docker build \
  -f "${REPO_ROOT}/agents/hermes/Dockerfile.base" \
  -t "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:latest" \
  "${REPO_ROOT}" \
  || fail "Failed to build current Hermes base image"

pass "Current Hermes base image built"

# ── Phase 6: Rebuild ────────────────────────────────────────────────
info "Phase 6: Running nemoclaw rebuild..."

nemoclaw "${SANDBOX_NAME}" rebuild --yes || fail "Rebuild failed"

pass "Rebuild completed"

# ── Phase 7: Verify ─────────────────────────────────────────────────
info "Phase 7: Verifying results..."

# Marker file survived
RESTORED=$(openshell sandbox exec --name "${SANDBOX_NAME}" -- cat "${MARKER_FILE}" 2>/dev/null || true)
if [ "$RESTORED" = "${MARKER_CONTENT}" ]; then
  pass "Marker file survived rebuild"
else
  fail "Marker file lost: got '${RESTORED}', expected '${MARKER_CONTENT}'"
fi

# Registry updated
REGISTRY_VERSION=$(python3 -c "
import json
with open('${REGISTRY_FILE}') as f:
    data = json.load(f)
sb = data.get('sandboxes', {}).get('${SANDBOX_NAME}', {})
print(sb.get('agentVersion', 'null'))
" 2>/dev/null || echo "error")
if [ "$REGISTRY_VERSION" != "null" ] && [ "$REGISTRY_VERSION" != "2026.3.12" ]; then
  pass "Registry agentVersion updated to ${REGISTRY_VERSION}"
else
  fail "Registry agentVersion not updated: ${REGISTRY_VERSION}"
fi

# No credentials in backup
BACKUP_DIR="$HOME/.nemoclaw/rebuild-backups/${SANDBOX_NAME}"
if [ -d "$BACKUP_DIR" ]; then
  CRED_LEAKS=$(find "$BACKUP_DIR" \( -name "*.json" -o -name "*.yaml" \) -exec grep -l "nvapi-\|sk-\|Bearer " {} \; 2>/dev/null || true)
  if [ -z "$CRED_LEAKS" ]; then
    pass "No credentials in backup"
  else
    fail "Credentials found: $CRED_LEAKS"
  fi
fi

# ── Cleanup ─────────────────────────────────────────────────────────
info "Cleaning up..."
nemoclaw "${SANDBOX_NAME}" destroy --yes 2>/dev/null || true
docker rmi "${OLD_BASE_TAG}" 2>/dev/null || true

echo ""
echo -e "${GREEN}Hermes rebuild upgrade E2E passed.${NC}"
