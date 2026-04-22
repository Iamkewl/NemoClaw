#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Brev Ollama E2E — verifies the local Ollama inference path on a real Brev
# instance (the environment that produces issue #1924).
#
# Assumes brev-e2e.test.ts beforeAll has already:
#   - Installed Ollama on the host and pulled qwen2.5:0.5b
#   - Run `nemoclaw onboard --provider=ollama` to build the e2e-test sandbox
# This script only exercises the "sandbox → host.openshell.internal → Ollama
# auth proxy → Ollama" networking chain (PR #1922) and an inference probe.
#
# Env:
#   SANDBOX_NAME   — default: e2e-test (matches beforeAll's sandbox)
#   OLLAMA_MODEL   — default: qwen2.5:0.5b
#   SKIP_INFERENCE — 1 to skip the inference probe

set -uo pipefail

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

SANDBOX_NAME="${SANDBOX_NAME:-e2e-test}"
OLLAMA_MODEL="${OLLAMA_MODEL:-qwen2.5:0.5b}"
OLLAMA_PORT=11434
# Matches OLLAMA_CONTAINER_PORT in nemoclaw/src/lib/ports.ts — keep in sync.
OLLAMA_CONTAINER_PORT=11435

# ── Preflight ───────────────────────────────────────────────────────────────
section "Preflight"

if command -v nemoclaw >/dev/null 2>&1; then
  pass "nemoclaw on PATH"
else
  fail "nemoclaw not on PATH"
  exit 1
fi

if command -v ollama >/dev/null 2>&1; then
  pass "ollama on host"
else
  fail "ollama not on host — beforeAll install missed"
  exit 1
fi

if curl -sf --max-time 5 "http://127.0.0.1:${OLLAMA_PORT}/api/tags" >/dev/null 2>&1; then
  pass "Ollama responding on 127.0.0.1:${OLLAMA_PORT}"
else
  fail "Ollama not responding on host"
  exit 1
fi

if nemoclaw list 2>/dev/null | awk '{print $1}' | grep -qxF "$SANDBOX_NAME"; then
  pass "Sandbox '$SANDBOX_NAME' registered"
else
  fail "Sandbox '$SANDBOX_NAME' missing from nemoclaw list"
  exit 1
fi

# #1924 regression guard — the pre-auth-proxy error message must not resurface.
if [[ -f /tmp/nemoclaw-onboard.log ]] && grep -q "Ensure Ollama listens on 0.0.0.0" /tmp/nemoclaw-onboard.log; then
  fail "Onboard regression (#1924) — legacy pre-auth-proxy error in onboard log"
fi

# ── Auth proxy reachability ─────────────────────────────────────────────────
section "Auth proxy"

if curl -sf --max-time 5 "http://127.0.0.1:${OLLAMA_CONTAINER_PORT}/api/tags" >/dev/null 2>&1; then
  pass "Auth proxy responding on 127.0.0.1:${OLLAMA_CONTAINER_PORT}"
else
  fail "Auth proxy not responding on ${OLLAMA_CONTAINER_PORT} — onboard did not start it"
fi

# ── Container reachability (the core #1924 assertion) ───────────────────────
section "Container → host.openshell.internal reachability"

# Standalone docker probe: matches getLocalProviderContainerReachabilityCheck
# in src/lib/local-inference.ts:156-176.
if docker run --rm \
  --add-host "host.openshell.internal:host-gateway" \
  curlimages/curl:latest \
  -sf --max-time 5 "http://host.openshell.internal:${OLLAMA_CONTAINER_PORT}/api/tags" >/dev/null 2>&1; then
  pass "Docker container reached auth proxy via host.openshell.internal"
else
  fail "#1924 reachability — container could not reach host.openshell.internal:${OLLAMA_CONTAINER_PORT}"
fi

# Sandbox-level probe through OpenShell-managed networking. Cap at 20s: if the
# exec wrapper itself hangs (exit 124), that's a distinct signal from the
# docker host-gateway probe above — surface it loudly rather than silently
# skipping, so the hang remains investigable.
sandbox_probe_exit=0
timeout 20 openshell sandbox exec --name "$SANDBOX_NAME" -- \
  curl -sf --max-time 5 "http://host.openshell.internal:${OLLAMA_CONTAINER_PORT}/api/tags" >/dev/null 2>&1 || sandbox_probe_exit=$?
if [[ $sandbox_probe_exit -eq 0 ]]; then
  pass "Sandbox reached auth proxy via host.openshell.internal"
elif [[ $sandbox_probe_exit -eq 124 ]]; then
  fail "openshell sandbox exec hung for >20s — investigate (separate from docker-probe reachability)"
else
  fail "Sandbox could not reach auth proxy (exit $sandbox_probe_exit)"
fi

# ── Inference end-to-end ────────────────────────────────────────────────────
if [[ "${SKIP_INFERENCE:-0}" == "1" ]]; then
  section "Inference probe (skipped)"
  skip "SKIP_INFERENCE=1"
else
  section "Inference end-to-end (CPU)"
  info "Small model on CPU: response may take up to 90s"

  ssh_config=$(mktemp)
  inference_exit=0
  inference_output=""

  if openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null; then
    inference_output=$(timeout 120 ssh -F "$ssh_config" \
      -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile=/dev/null \
      -o ConnectTimeout=10 \
      -o LogLevel=ERROR \
      "openshell-${SANDBOX_NAME}" \
      "curl -s --max-time 90 https://inference.local/v1/chat/completions \
        -H 'Content-Type: application/json' \
        -d '{\"model\":\"$OLLAMA_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly one word: PONG\"}],\"max_tokens\":20}'" \
      2>&1) || inference_exit=$?
  else
    inference_exit=127
  fi
  rm -f "$ssh_config"

  if [[ $inference_exit -eq 124 ]]; then
    fail "Inference timed out after 120s"
  elif [[ $inference_exit -eq 127 ]]; then
    fail "openshell sandbox ssh-config failed"
  elif [[ $inference_exit -ne 0 ]]; then
    fail "ssh to sandbox exited $inference_exit: ${inference_output:0:200}"
  elif [[ -z "$inference_output" ]]; then
    fail "Inference empty response"
  else
    pass "Inference returned a response via sandbox → gateway → auth proxy → Ollama"
  fi
fi

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "============================================================"
echo "  Brev Ollama E2E summary"
echo "============================================================"
printf '  \033[32mPASS:\033[0m %d\n' "$PASS"
printf '  \033[31mFAIL:\033[0m %d\n' "$FAIL"
printf '  \033[33mSKIP:\033[0m %d\n' "$SKIP"
printf '  TOTAL: %d\n' "$TOTAL"
echo "============================================================"

[[ $FAIL -gt 0 ]] && exit 1
exit 0
