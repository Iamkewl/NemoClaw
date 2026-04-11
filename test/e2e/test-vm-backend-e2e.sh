#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# VM Backend E2E: install openshell-vm → onboard with VM backend → verify inference → resume → reset
#
# Proves the microVM gateway backend (openshell-vm / libkrun) works end-to-end
# without Docker. Exercises the full user journey: install, onboard, inference,
# resume after kill, and reset to clean slate.
#
# Requires a Linux host with /dev/kvm (GitHub-hosted ubuntu runners have this).
# Does NOT require Docker — the whole point of the VM backend is Docker-free operation.
#
# Prerequisites:
#   - Linux with /dev/kvm
#   - NVIDIA_API_KEY set (real key, starts with nvapi-)
#   - Network access to integrate.api.nvidia.com
#   - Network access to github.com (openshell-vm binary download)
#
# Environment variables:
#   NEMOCLAW_NON_INTERACTIVE=1             — required
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 — required
#   NVIDIA_API_KEY                         — required for NVIDIA Endpoints inference
#   NEMOCLAW_SANDBOX_NAME                  — sandbox name (default: e2e-vm)
#   NEMOCLAW_E2E_TIMEOUT_SECONDS           — overall timeout (default: 900)
#   OPENSHELL_VM_VERSION                   — openshell-vm release tag (default: v0.0.26)
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 \
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#   NVIDIA_API_KEY=nvapi-... \
#     bash test/e2e/test-vm-backend-e2e.sh

set -uo pipefail

# ── Self-timeout wrapper ──
if [ -z "${NEMOCLAW_E2E_NO_TIMEOUT:-}" ]; then
  export NEMOCLAW_E2E_NO_TIMEOUT=1
  TIMEOUT_SECONDS="${NEMOCLAW_E2E_TIMEOUT_SECONDS:-900}"
  if command -v timeout >/dev/null 2>&1; then
    exec timeout -s TERM "$TIMEOUT_SECONDS" bash "$0" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    exec gtimeout -s TERM "$TIMEOUT_SECONDS" bash "$0" "$@"
  fi
fi

PASS=0
FAIL=0
SKIP=0
TOTAL=0

pass() {
  ((PASS++))
  ((TOTAL++))
  printf '\033[32m  PASS: %s\033[0m\n' "$1"
}
fail() {
  ((FAIL++))
  ((TOTAL++))
  printf '\033[31m  FAIL: %s\033[0m\n' "$1"
}
# shellcheck disable=SC2329  # invoked conditionally in test phases
skip() {
  ((SKIP++))
  ((TOTAL++))
  printf '\033[33m  SKIP: %s\033[0m\n' "$1"
}
section() {
  echo ""
  printf '\033[1;36m=== %s ===\033[0m\n' "$1"
}
info() { printf '\033[1;34m  [info]\033[0m %s\n' "$1"; }

# Parse chat completion response — handles both content and reasoning_content
parse_chat_content() {
  python3 -c "
import json, sys
try:
    r = json.load(sys.stdin)
    c = r['choices'][0]['message']
    content = c.get('content') or c.get('reasoning_content') or ''
    print(content.strip())
except Exception as e:
    print(f'PARSE_ERROR: {e}', file=sys.stderr)
    sys.exit(1)
"
}

# Compare semver: returns 0 if $1 >= $2
version_gte() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-vm}"
REGISTRY="$HOME/.nemoclaw/sandboxes.json"
MIN_OPENSHELL="0.0.26"
OPENSHELL_VM_VERSION="${OPENSHELL_VM_VERSION:-v0.0.26}"
MODEL="nvidia/nemotron-3-super-120b-a12b"

# SSH helper — sets up SSH config and common options for sandbox access
setup_ssh() {
  ssh_config="$(mktemp)"
  if ! openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null; then
    rm -f "$ssh_config"
    ssh_config=""
    return 1
  fi
  SSH_OPTS=(-F "$ssh_config" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o LogLevel=ERROR)
  SSH_TARGET="openshell-${SANDBOX_NAME}"
  TIMEOUT_CMD=""
  command -v timeout >/dev/null 2>&1 && TIMEOUT_CMD="timeout 90"
  command -v gtimeout >/dev/null 2>&1 && TIMEOUT_CMD="gtimeout 90"
  return 0
}

cleanup_ssh() {
  [ -n "${ssh_config:-}" ] && rm -f "$ssh_config"
  ssh_config=""
}

# ══════════════════════════════════════════════════════════════════
# Phase 0: Prerequisites
# ══════════════════════════════════════════════════════════════════
section "Phase 0: Prerequisites"

if [ "$(uname -s)" != "Linux" ]; then
  fail "openshell-vm requires Linux (got: $(uname -s))"
  exit 1
fi
pass "Running on Linux"

if [ -c /dev/kvm ]; then
  pass "/dev/kvm available (KVM virtualization support)"
else
  fail "/dev/kvm not available — openshell-vm requires KVM"
  exit 1
fi

if [ -n "${NVIDIA_API_KEY:-}" ] && [[ "${NVIDIA_API_KEY}" == nvapi-* ]]; then
  pass "NVIDIA_API_KEY is set (starts with nvapi-)"
else
  fail "NVIDIA_API_KEY not set or invalid — required for live inference"
  exit 1
fi

if curl -sf --max-time 10 https://integrate.api.nvidia.com/v1/models >/dev/null 2>&1; then
  pass "Network access to integrate.api.nvidia.com"
else
  fail "Cannot reach integrate.api.nvidia.com"
  exit 1
fi

if [ "${NEMOCLAW_NON_INTERACTIVE:-}" != "1" ]; then
  fail "NEMOCLAW_NON_INTERACTIVE=1 is required"
  exit 1
fi

if [ "${NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE:-}" != "1" ]; then
  fail "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 is required"
  exit 1
fi

if [ ! -f "$REPO_ROOT/install.sh" ]; then
  fail "Cannot find install.sh at $REPO_ROOT/install.sh"
  exit 1
fi
pass "Repo root found: $REPO_ROOT"

# ══════════════════════════════════════════════════════════════════
# Phase 1: Install openshell-vm binary from release assets
# ══════════════════════════════════════════════════════════════════
section "Phase 1: Install openshell-vm binary"

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64 | amd64) ARCH_LABEL="x86_64" ;;
  aarch64 | arm64) ARCH_LABEL="aarch64" ;;
  *)
    fail "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

VM_ASSET="openshell-vm-${ARCH_LABEL}-unknown-linux-musl.tar.gz"
VM_CHECKSUM_FILE="openshell-vm-checksums-sha256.txt"
VM_TMPDIR="$(mktemp -d)"
trap 'rm -rf "$VM_TMPDIR"' EXIT

info "Downloading openshell-vm from NVIDIA/OpenShell release ${OPENSHELL_VM_VERSION}..."

download_vm_with_curl() {
  local tag="${OPENSHELL_VM_VERSION}"
  # Strip leading 'v' for the download URL if present — GitHub releases
  # use the tag name as-is in the URL path.
  curl -fsSL "https://github.com/NVIDIA/OpenShell/releases/download/${tag}/${VM_ASSET}" \
    -o "$VM_TMPDIR/$VM_ASSET"
  curl -fsSL "https://github.com/NVIDIA/OpenShell/releases/download/${tag}/${VM_CHECKSUM_FILE}" \
    -o "$VM_TMPDIR/$VM_CHECKSUM_FILE"
}

if command -v gh >/dev/null 2>&1; then
  if GH_PROMPT_DISABLED=1 GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}" \
    gh release download "$OPENSHELL_VM_VERSION" --repo NVIDIA/OpenShell \
    --pattern "$VM_ASSET" --dir "$VM_TMPDIR" 2>/dev/null \
    && GH_PROMPT_DISABLED=1 GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}" \
      gh release download "$OPENSHELL_VM_VERSION" --repo NVIDIA/OpenShell \
      --pattern "$VM_CHECKSUM_FILE" --dir "$VM_TMPDIR" 2>/dev/null; then
    : # gh succeeded
  else
    info "gh CLI download failed — falling back to curl"
    rm -f "$VM_TMPDIR/$VM_ASSET" "$VM_TMPDIR/$VM_CHECKSUM_FILE"
    download_vm_with_curl
  fi
else
  download_vm_with_curl
fi

if [ -f "$VM_TMPDIR/$VM_CHECKSUM_FILE" ]; then
  info "Verifying SHA-256 checksum..."
  if (cd "$VM_TMPDIR" && grep -F "$VM_ASSET" "$VM_CHECKSUM_FILE" | shasum -a 256 -c -); then
    pass "SHA-256 checksum verified"
  else
    fail "SHA-256 checksum verification failed for $VM_ASSET"
    exit 1
  fi
else
  info "No checksum file available — skipping verification"
fi

tar xzf "$VM_TMPDIR/$VM_ASSET" -C "$VM_TMPDIR"

VM_TARGET_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
mkdir -p "$VM_TARGET_DIR"
install -m 755 "$VM_TMPDIR/openshell-vm" "$VM_TARGET_DIR/openshell-vm"

if [[ ":$PATH:" != *":$VM_TARGET_DIR:"* ]]; then
  export PATH="$VM_TARGET_DIR:$PATH"
fi

if command -v openshell-vm >/dev/null 2>&1; then
  VM_VERSION=$(openshell-vm --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo "unknown")
  pass "openshell-vm installed: $VM_VERSION (at $(command -v openshell-vm))"
else
  fail "openshell-vm not found on PATH after install"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
# Phase 2: Install NemoClaw (with VM backend)
# ══════════════════════════════════════════════════════════════════
section "Phase 2: Install NemoClaw via install.sh (VM backend)"

# Pre-cleanup: destroy any leftover sandbox/gateway from previous runs
info "Pre-cleanup..."
if command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
fi
if command -v openshell >/dev/null 2>&1; then
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
  openshell gateway destroy -g nemoclaw 2>/dev/null || true
fi
rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true
pass "Pre-cleanup complete"

cd "$REPO_ROOT" || {
  fail "Could not cd to repo root: $REPO_ROOT"
  exit 1
}

info "Running install.sh --non-interactive with NEMOCLAW_GATEWAY_BACKEND=vm..."

INSTALL_LOG="$(mktemp)"
env \
  NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
  NEMOCLAW_RECREATE_SANDBOX=1 \
  NEMOCLAW_GATEWAY_BACKEND=vm \
  bash install.sh --non-interactive >"$INSTALL_LOG" 2>&1 &
install_pid=$!
tail -f "$INSTALL_LOG" --pid=$install_pid 2>/dev/null &
tail_pid=$!
wait $install_pid
install_exit=$?
kill $tail_pid 2>/dev/null || true
wait $tail_pid 2>/dev/null || true
rm -f "$INSTALL_LOG"

# Source shell profile to pick up nvm/PATH changes from install.sh
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

if [ $install_exit -eq 0 ]; then
  pass "install.sh completed (exit 0)"
else
  fail "install.sh failed (exit $install_exit)"
  exit 1
fi

if command -v nemoclaw >/dev/null 2>&1; then
  pass "nemoclaw on PATH: $(command -v nemoclaw)"
else
  fail "nemoclaw not found on PATH after install"
  exit 1
fi

if command -v openshell >/dev/null 2>&1; then
  OPENSHELL_VERSION=$(openshell --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  if version_gte "$OPENSHELL_VERSION" "$MIN_OPENSHELL"; then
    pass "openshell $OPENSHELL_VERSION >= $MIN_OPENSHELL"
  else
    fail "openshell $OPENSHELL_VERSION < $MIN_OPENSHELL"
    exit 1
  fi
else
  fail "openshell not found on PATH after install"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
# Phase 3: Verify sandbox is live (VM backend)
# ══════════════════════════════════════════════════════════════════
section "Phase 3: Post-install verification"

# 3a: NemoClaw registry has it
if [ -f "$REGISTRY" ] && grep -Fq "\"${SANDBOX_NAME}\"" "$REGISTRY"; then
  pass "NemoClaw registry contains '$SANDBOX_NAME'"
else
  fail "NemoClaw registry missing '$SANDBOX_NAME' — onboard may have failed"
  exit 1
fi

# 3b: nemoclaw list shows it
if list_output=$(nemoclaw list 2>&1) && grep -Fq "$SANDBOX_NAME" <<<"$list_output"; then
  pass "nemoclaw list shows '$SANDBOX_NAME'"
else
  fail "nemoclaw list doesn't show '$SANDBOX_NAME': ${list_output:0:200}"
  exit 1
fi

# 3c: nemoclaw status works
if status_output=$(nemoclaw "$SANDBOX_NAME" status 2>&1); then
  pass "nemoclaw $SANDBOX_NAME status exits 0"
else
  fail "nemoclaw $SANDBOX_NAME status failed: ${status_output:0:200}"
fi

# 3d: Verify the VM backend was selected (not Docker)
# The gateway should be running via openshell-vm, not a Docker container.
if docker ps --filter "name=openshell-cluster-nemoclaw" --format '{{.Names}}' 2>/dev/null | grep -q "openshell-cluster-nemoclaw"; then
  fail "Docker container found — VM backend should NOT use Docker"
else
  pass "No Docker container for gateway (VM backend confirmed)"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 4: Live inference through VM-backed sandbox
# ══════════════════════════════════════════════════════════════════
section "Phase 4: Live inference (VM backend)"

# 4a: Direct NVIDIA Endpoints (baseline — proves API key works)
info "[LIVE] Direct API test -> integrate.api.nvidia.com..."
api_response=$(curl -s --max-time 30 \
  -X POST https://integrate.api.nvidia.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $NVIDIA_API_KEY" \
  -d '{
    "model": "'"$MODEL"'",
    "messages": [{"role": "user", "content": "Reply with exactly one word: PONG"}],
    "max_tokens": 100
  }' 2>/dev/null) || true

if [ -n "$api_response" ]; then
  api_content=$(echo "$api_response" | parse_chat_content 2>/dev/null) || true
  if grep -qi "PONG" <<<"$api_content"; then
    pass "[LIVE] Direct API: model responded with PONG"
  else
    fail "[LIVE] Direct API: expected PONG, got: ${api_content:0:200}"
  fi
else
  fail "[LIVE] Direct API: empty response from curl"
fi

# 4b: Inference through the VM-backed sandbox (THE definitive test)
info "[LIVE] Sandbox inference: user -> sandbox -> VM gateway -> NVIDIA Endpoints..."

if ! setup_ssh; then
  fail "Could not get SSH config for sandbox"
else
  pass "SSH config obtained"

  if ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "echo alive" >/dev/null 2>&1; then
    pass "SSH into VM-backed sandbox works"
  else
    fail "SSH into VM-backed sandbox failed"
  fi

  # shellcheck disable=SC2029
  sandbox_response=$($TIMEOUT_CMD ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
    "curl -s --max-time 60 https://inference.local/v1/chat/completions \
      -H 'Content-Type: application/json' \
      -d '{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly one word: PONG\"}],\"max_tokens\":100}'" \
    2>&1) || true

  sandbox_content=""
  if [ -n "$sandbox_response" ]; then
    sandbox_content=$(echo "$sandbox_response" | parse_chat_content 2>/dev/null) || true
  fi

  if grep -qi "PONG" <<<"$sandbox_content"; then
    pass "[LIVE] VM sandbox inference: model responded with PONG"
    info "Full path proven: user -> sandbox -> openshell-vm gateway -> NVIDIA Endpoints -> response"
  else
    fail "[LIVE] VM sandbox inference: expected PONG, got: ${sandbox_content:0:200}"
    info "Raw response: ${sandbox_response:0:300}"
  fi

  cleanup_ssh
fi

# ══════════════════════════════════════════════════════════════════
# Phase 5: Resume — kill openshell-vm, re-run onboard --resume
# ══════════════════════════════════════════════════════════════════
section "Phase 5: Resume after openshell-vm kill"

info "Killing openshell-vm process to simulate crash..."
# Find and kill any openshell-vm gateway process
if pkill -f "openshell-vm" 2>/dev/null; then
  pass "openshell-vm process killed"
  sleep 3
else
  info "No openshell-vm process found to kill (may already be stopped)"
fi

info "Running nemoclaw onboard --resume with NEMOCLAW_GATEWAY_BACKEND=vm..."
RESUME_LOG="$(mktemp)"
env \
  NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
  NEMOCLAW_GATEWAY_BACKEND=vm \
  nemoclaw onboard --resume --non-interactive >"$RESUME_LOG" 2>&1
resume_exit=$?
resume_output="$(cat "$RESUME_LOG")"
rm -f "$RESUME_LOG"

if [ $resume_exit -eq 0 ]; then
  pass "Resume completed (exit 0)"
else
  fail "Resume failed (exit $resume_exit)"
  info "Resume output: ${resume_output:0:500}"
fi

# Verify sandbox is still operational after resume
if nemoclaw "$SANDBOX_NAME" status >/dev/null 2>&1; then
  pass "Sandbox '$SANDBOX_NAME' operational after resume"
else
  fail "Sandbox '$SANDBOX_NAME' status failed after resume"
fi

# Verify inference still works after resume
if setup_ssh; then
  info "[LIVE] Post-resume inference test..."
  # shellcheck disable=SC2029
  resume_response=$($TIMEOUT_CMD ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
    "curl -s --max-time 60 https://inference.local/v1/chat/completions \
      -H 'Content-Type: application/json' \
      -d '{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly one word: PONG\"}],\"max_tokens\":100}'" \
    2>&1) || true

  resume_content=""
  if [ -n "$resume_response" ]; then
    resume_content=$(echo "$resume_response" | parse_chat_content 2>/dev/null) || true
  fi

  if grep -qi "PONG" <<<"$resume_content"; then
    pass "[LIVE] Post-resume: inference works through VM sandbox"
  else
    fail "[LIVE] Post-resume: expected PONG, got: ${resume_content:0:200}"
  fi
  cleanup_ssh
else
  fail "Could not get SSH config after resume"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 6: Reset — destroy and verify clean slate
# ══════════════════════════════════════════════════════════════════
section "Phase 6: Reset (clean slate recovery)"

info "Destroying sandbox..."
nemoclaw "$SANDBOX_NAME" destroy --yes 2>&1 | tail -3 || true
openshell gateway destroy -g nemoclaw 2>/dev/null || true

# Verify sandbox is gone
if [ -f "$REGISTRY" ] && grep -Fq "\"${SANDBOX_NAME}\"" "$REGISTRY"; then
  fail "Sandbox '$SANDBOX_NAME' still in registry after destroy"
else
  pass "Sandbox '$SANDBOX_NAME' removed from registry"
fi

# Verify openshell sandbox list doesn't show it
if openshell sandbox list 2>&1 | grep -q "$SANDBOX_NAME"; then
  fail "Sandbox '$SANDBOX_NAME' still in openshell sandbox list after destroy"
else
  pass "Sandbox '$SANDBOX_NAME' gone from openshell sandbox list"
fi

# Re-onboard from scratch to prove clean slate works
info "Re-onboarding from scratch with VM backend to prove clean slate..."
RESET_LOG="$(mktemp)"
env \
  NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
  NEMOCLAW_RECREATE_SANDBOX=1 \
  NEMOCLAW_GATEWAY_BACKEND=vm \
  nemoclaw onboard --non-interactive >"$RESET_LOG" 2>&1 &
reset_pid=$!
tail -f "$RESET_LOG" --pid=$reset_pid 2>/dev/null &
reset_tail_pid=$!
wait $reset_pid
reset_exit=$?
kill $reset_tail_pid 2>/dev/null || true
wait $reset_tail_pid 2>/dev/null || true
rm -f "$RESET_LOG"

if [ $reset_exit -eq 0 ]; then
  pass "Clean slate re-onboard completed (exit 0)"
else
  fail "Clean slate re-onboard failed (exit $reset_exit)"
fi

# Verify the re-created sandbox works
if nemoclaw "$SANDBOX_NAME" status >/dev/null 2>&1; then
  pass "Re-created sandbox '$SANDBOX_NAME' operational"
else
  fail "Re-created sandbox '$SANDBOX_NAME' status failed"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 7: Final cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 7: Final cleanup"

nemoclaw "$SANDBOX_NAME" destroy --yes 2>&1 | tail -3 || true
openshell gateway destroy -g nemoclaw 2>/dev/null || true

if [ -f "$REGISTRY" ] && grep -Fq "\"${SANDBOX_NAME}\"" "$REGISTRY"; then
  fail "Sandbox '$SANDBOX_NAME' still in registry after final cleanup"
else
  pass "Sandbox '$SANDBOX_NAME' cleaned up"
fi

# ══════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════
echo ""
echo "========================================"
echo "  VM Backend E2E Results:"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Skipped: $SKIP"
echo "    Total:   $TOTAL"
echo "========================================"

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  VM Backend E2E PASSED — microVM gateway verified end-to-end (no Docker required).\033[0m\n'
  exit 0
else
  printf '\n\033[1;31m  %d test(s) failed.\033[0m\n' "$FAIL"
  exit 1
fi
