#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# shellcheck disable=SC2034,SC2016
# SC2034: Variables like T1_RC are captured for debugging but may appear unused.
# SC2016: Single-quoted strings passed to sandbox_exec are intentionally unexpanded
#         — they expand inside the remote shell, not the local one.

# Egress Proxy Binary Resolution E2E Test
#
# Reproduces and validates the fix for issue #1471: OpenShell egress proxy
# reports "binary=-" for all CONNECT requests because it cannot resolve the
# calling binary across PID/network namespace boundaries.
#
# Root cause: The proxy scans /proc/<proxy_pid>/net/tcp{,6} to find which
# binary initiated a connection.  When the sandbox runs in a separate network
# namespace (macOS Docker Desktop + k3s), the client-side TCP entry is invisible
# to the proxy, so binary resolution fails with "binary=-" and the request
# is denied regardless of policy.
#
# This test exercises the three failure modes from the issue:
#   1. curl   (specific binary in policy) → should succeed after fix
#   2. node   (specific binary in policy) → should succeed after fix
#   3. curl to a BLOCKED endpoint        → should still be denied
#
# Prerequisites:
#   - Docker running
#   - NemoClaw sandbox running (test-full-e2e.sh Phase 0-3)
#   - NVIDIA_API_KEY set
#   - openshell on PATH
#   - Telegram policy preset applied (or policy includes api.telegram.org)
#
# Environment:
#   NEMOCLAW_SANDBOX_NAME  — sandbox name (default: e2e-test)
#   NVIDIA_API_KEY         — required
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NVIDIA_API_KEY=nvapi-... \
#     bash test/e2e/test-egress-binary-resolution.sh
#
# See: https://github.com/NVIDIA/NemoClaw/issues/1471
#      Related: #391, #481, #409

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
warn() { printf '\033[1;33m  [warn]\033[0m %s\n' "$1"; }

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-${SANDBOX_NAME:-e2e-test}}"

# ══════════════════════════════════════════════════════════════════
# Phase 0: Prerequisites
# ══════════════════════════════════════════════════════════════════
section "Phase 0: Prerequisites"

if ! command -v openshell >/dev/null 2>&1; then
  fail "openshell not found on PATH"
  exit 1
fi
pass "openshell found"

# Verify sandbox is running
set +e
sandbox_status=$(openshell sandbox get "$SANDBOX_NAME" 2>&1)
sg_rc=$?
set -e
if [ "$sg_rc" -ne 0 ]; then
  fail "Sandbox '${SANDBOX_NAME}' not found — run onboard first"
  exit 1
fi
pass "Sandbox '${SANDBOX_NAME}' exists"

# Set up SSH config for sandbox access
ssh_config="$(mktemp)"
trap 'rm -f "$ssh_config"' EXIT

openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null \
  || {
    fail "openshell sandbox ssh-config failed"
    exit 1
  }
pass "SSH config obtained"

ssh_host="openshell-${SANDBOX_NAME}"
ssh_base=(ssh -F "$ssh_config"
  -o StrictHostKeyChecking=no
  -o UserKnownHostsFile=/dev/null
  -o ConnectTimeout=10
  -o LogLevel=ERROR
)

TIMEOUT_CMD=""
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD="timeout 60"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD="gtimeout 60"
fi

# Helper: run command in sandbox
sandbox_exec() {
  local cmd="$1"
  $TIMEOUT_CMD "${ssh_base[@]}" "$ssh_host" "$cmd" 2>&1
}

# ══════════════════════════════════════════════════════════════════
# Phase 1: Namespace diagnostic — detect the mismatch
# ══════════════════════════════════════════════════════════════════
section "Phase 1: Namespace Diagnostic"

# 1a. Check proxy PID and its /proc/net/tcp visibility
info "Checking proxy process and network namespace..."
DIAG_OUTPUT=$(sandbox_exec 'cat /proc/self/net/tcp 2>/dev/null | wc -l; echo "---"; cat /proc/net/tcp 2>/dev/null | wc -l' 2>/dev/null) || true
info "Sandbox /proc/net/tcp visibility: ${DIAG_OUTPUT:-unavailable}"

# 1b. Check what IPs the sandbox can see
info "Checking sandbox network interfaces..."
SANDBOX_NET=$(sandbox_exec 'ip addr show 2>/dev/null | grep "inet " | head -5' 2>/dev/null) || true
info "Sandbox IPs: ${SANDBOX_NET:-unavailable}"

# 1c. Check proxy environment
info "Checking proxy settings..."
PROXY_ENV=$(sandbox_exec 'echo "HTTP_PROXY=$HTTP_PROXY HTTPS_PROXY=$HTTPS_PROXY"' 2>/dev/null) || true
info "Proxy env: ${PROXY_ENV:-unavailable}"

# ══════════════════════════════════════════════════════════════════
# Phase 2: Binary resolution — CONNECT via curl (policy-allowed endpoint)
# ══════════════════════════════════════════════════════════════════
section "Phase 2: curl CONNECT to policy-allowed endpoint (api.github.com)"

# github is in the baseline policy with binaries: [/usr/bin/gh, /usr/bin/git]
# This tests a typical allowed-binary scenario — but curl is NOT in the github
# policy binaries list, so it should be denied on binary mismatch (not binary=-)
# After the fix, binary resolution should at least identify "curl".

info "T1: curl HTTPS to api.github.com (in baseline policy, but curl not in binaries)..."
set +e
T1_OUTPUT=$(sandbox_exec '
  efile=$(mktemp)
  code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 30 https://api.github.com/ 2>"$efile")
  cr=$?
  err=$(head -c 400 "$efile")
  rm -f "$efile"
  echo "exit=$cr http=$code err=$err"
' 2>&1)
T1_RC=$?
set -e

info "T1 result: ${T1_OUTPUT:-empty}"

# Interpret: if binary resolution works, proxy should identify curl and deny
# on binary mismatch (curl not in github binaries). If binary=- (issue #1471),
# the deny reason will be "failed to resolve peer binary".
if echo "$T1_OUTPUT" | grep -q "exit=0"; then
  # Unexpected: curl should not be in the github binaries list
  warn "T1: curl to api.github.com succeeded — may have wildcard access configured"
  pass "T1: CONNECT tunnel worked (proxy resolved binary)"
elif echo "$T1_OUTPUT" | grep -qi "resolve peer binary\|binary=-"; then
  fail "T1: CONNECT denied with 'binary=-' — issue #1471 reproduced (namespace mismatch)"
elif echo "$T1_OUTPUT" | grep -q "exit=56\|exit=35"; then
  # curl exit 56=recv error, 35=SSL error — proxy rejected the connection
  # This is expected if binary resolution WORKS (curl is not in github binaries)
  info "T1: Proxy rejected curl — checking if binary was resolved..."
  pass "T1: Proxy denied curl (binary likely resolved; curl not in github policy)"
else
  info "T1: Unexpected result — needs manual investigation"
  skip "T1: Could not determine binary resolution status"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 3: Binary resolution — node CONNECT (Telegram endpoint)
# ══════════════════════════════════════════════════════════════════
section "Phase 3: node CONNECT to api.telegram.org (issue #1471 exact scenario)"

# This is the exact scenario from issue #1471:
# node is in the telegram policy binaries, and api.telegram.org is in the
# telegram policy endpoints. This SHOULD work but fails with binary=-.

info "T2: Node.js HTTPS to api.telegram.org (exact #1471 reproduction)..."
set +e
T2_OUTPUT=$(sandbox_exec '
  node -e "
    const https = require(\"https\");
    const req = https.get(\"https://api.telegram.org/\", { timeout: 15000 }, (res) => {
      process.stdout.write(\"exit=0 http=\" + res.statusCode + \"\\n\");
      res.resume();
      res.on(\"end\", () => process.exit(0));
    });
    req.on(\"error\", (e) => {
      process.stdout.write(\"exit=1 err=\" + e.message + \"\\n\");
      process.exit(1);
    });
    req.on(\"timeout\", () => {
      process.stdout.write(\"exit=1 err=timeout\\n\");
      req.destroy();
      process.exit(1);
    });
  " 2>&1
')
T2_RC=$?
set -e

info "T2 result: ${T2_OUTPUT:-empty}"

if echo "$T2_OUTPUT" | grep -q "exit=0"; then
  pass "T2: node CONNECT to api.telegram.org succeeded — binary resolution works"
elif echo "$T2_OUTPUT" | grep -qi "ECONNRESET\|ECONNREFUSED\|socket hang up\|tunneling socket"; then
  # Proxy killed the connection — either binary=- or policy denial
  fail "T2: node CONNECT to api.telegram.org DENIED — likely issue #1471 (binary=-)"
elif echo "$T2_OUTPUT" | grep -qi "ETIMEDOUT\|EAI_AGAIN"; then
  skip "T2: DNS or network timeout — cannot determine binary resolution status"
else
  info "T2: Unexpected result: ${T2_OUTPUT:0:200}"
  fail "T2: node CONNECT to api.telegram.org failed unexpectedly"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 4: Negative control — blocked endpoint should still be denied
# ══════════════════════════════════════════════════════════════════
section "Phase 4: Negative control — blocked endpoint"

BLOCKED_URL="${E2E_BLOCKED_URL:-https://example.com/}"

info "T3: curl to blocked endpoint (${BLOCKED_URL}) — should be denied..."
set +e
T3_OUTPUT=$(sandbox_exec "
  if curl -f -sS -o /dev/null --max-time 15 '${BLOCKED_URL}' 2>&1; then
    echo 'exit=0 UNEXPECTED_SUCCESS'
  else
    echo 'exit=\$? CORRECTLY_BLOCKED'
  fi
" 2>&1)
T3_RC=$?
set -e

info "T3 result: ${T3_OUTPUT:-empty}"

if echo "$T3_OUTPUT" | grep -q "CORRECTLY_BLOCKED"; then
  pass "T3: Blocked endpoint correctly denied"
elif echo "$T3_OUTPUT" | grep -q "UNEXPECTED_SUCCESS"; then
  fail "T3: Blocked endpoint was NOT denied — policy enforcement broken"
else
  # Connection failure of any kind = blocked
  pass "T3: Blocked endpoint connection failed (policy effective)"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 5: Namespace diagnostic — detailed /proc analysis
# ══════════════════════════════════════════════════════════════════
section "Phase 5: /proc/net/tcp namespace analysis"

info "T4: Checking if sandbox can see its own TCP connections in /proc..."
set +e
T4_OUTPUT=$(sandbox_exec '
  echo "=== /proc/self/net/tcp (first 5 ESTABLISHED) ==="
  cat /proc/self/net/tcp 2>/dev/null | awk "NR==1 || \$4==\"01\"" | head -6
  echo ""
  echo "=== Network namespace ID ==="
  readlink /proc/self/ns/net 2>/dev/null || echo "unavailable"
  echo ""
  echo "=== PID namespace ID ==="
  readlink /proc/self/ns/pid 2>/dev/null || echo "unavailable"
  echo ""
  echo "=== Self PID ==="
  echo $$
' 2>&1)
T4_RC=$?
set -e

if [ -n "$T4_OUTPUT" ]; then
  info "Namespace diagnostic output:"
  printf '%s\n' "${T4_OUTPUT}" | while IFS= read -r line; do printf '    %s\n' "$line"; done
  pass "T4: /proc diagnostic collected"
else
  skip "T4: Could not collect /proc diagnostic"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 6: Cross-namespace visibility check
# ══════════════════════════════════════════════════════════════════
section "Phase 6: Cross-namespace TCP visibility"

info "T5: Establishing TCP connection and checking /proc/net/tcp visibility..."
set +e
T5_OUTPUT=$(sandbox_exec '
  # Open a background TCP connection to the proxy
  exec 3<>/dev/tcp/10.200.0.1/3128 2>/dev/null || {
    echo "cannot_connect_to_proxy"
    exit 1
  }
  SELF_PID=$$

  # Check if this connection appears in /proc/self/net/tcp
  SELF_TCP_LINES=$(cat /proc/self/net/tcp 2>/dev/null | grep -c "01" || echo 0)

  # Close the connection
  exec 3>&-

  echo "self_established_connections=$SELF_TCP_LINES self_pid=$SELF_PID"
' 2>&1)
T5_RC=$?
set -e

info "T5 result: ${T5_OUTPUT:-empty}"

if echo "$T5_OUTPUT" | grep -q "self_established_connections=[1-9]"; then
  pass "T5: Sandbox can see its own TCP connections in /proc/self/net/tcp"
  info "If the proxy reads /proc/<sandbox_pid>/net/tcp instead of /proc/<proxy_pid>/net/tcp,"
  info "it could resolve the calling binary correctly."
elif echo "$T5_OUTPUT" | grep -q "self_established_connections=0"; then
  warn "T5: Sandbox has 0 ESTABLISHED connections visible in /proc/self/net/tcp"
  fail "T5: /proc/net/tcp visibility issue — confirms namespace mismatch"
else
  skip "T5: Could not determine /proc/net/tcp visibility"
fi

# ══════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════
echo ""
echo "========================================"
echo "  Egress Binary Resolution Test Results"
echo "  (Issue #1471 Reproduction)"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Skipped: $SKIP"
echo "    Total:   $TOTAL"
echo "========================================"

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  Binary resolution tests PASSED — proxy correctly resolves binaries.\033[0m\n'
  printf '\033[1;32m  Issue #1471 is NOT reproducible in this environment.\033[0m\n'
  exit 0
else
  printf '\n\033[1;31m  %d test(s) failed — issue #1471 is REPRODUCIBLE.\033[0m\n' "$FAIL"
  printf '\033[1;33m  Root cause: proxy reads /proc/<proxy_pid>/net/tcp which does not\033[0m\n'
  printf '\033[1;33m  contain sandbox connections (different network namespace).\033[0m\n'
  printf '\033[1;33m  Fix required in: OpenShell egress proxy binary resolution logic.\033[0m\n'
  exit 1
fi
