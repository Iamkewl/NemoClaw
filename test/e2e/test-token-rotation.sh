#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# shellcheck disable=SC2034
# SC2034: Some variables are used indirectly or reserved for later phases.

# Telegram Bot Token Rotation E2E Tests
#
# Validates that rotating a Telegram bot token via `nemoclaw onboard` (reuse
# mode) propagates the new credential through the OpenShell provider without
# requiring sandbox recreation.
#
# Flow:
#   1. Create sandbox with invalid token A → provider registered, getMe returns 4xx
#   2. Re-onboard with valid token B (reuse) → provider updated via upsertProvider
#   3. getMe now returns 200 with bot B's identity
#
# This proves the upsertMessagingProviders() → openshell provider update path
# works end-to-end through the L7 proxy rewrite chain.
#
# Prerequisites:
#   - Docker running
#   - NemoClaw installed (install.sh or brev-setup.sh already ran)
#   - NVIDIA_API_KEY set
#   - TELEGRAM_BOT_TOKEN_B must be a valid Telegram bot token
#   - TELEGRAM_BOT_TOKEN_A should be an invalid token (defaults to fake)
#   - openshell on PATH
#
# Environment variables:
#   NVIDIA_API_KEY                         — required
#   NEMOCLAW_NON_INTERACTIVE=1             — required
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 — required
#   NEMOCLAW_SANDBOX_NAME                  — sandbox name (default: e2e-token-rotation)
#   TELEGRAM_BOT_TOKEN_A                   — invalid token for initial install (default: fake)
#   TELEGRAM_BOT_TOKEN_B                   — valid token for rotation (required)
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#     NVIDIA_API_KEY=nvapi-... TELEGRAM_BOT_TOKEN_B=123456:ABC-real-token \
#     bash test/e2e/test-token-rotation.sh
#
# See: https://github.com/NVIDIA/NemoClaw/issues/TC-TEL-05

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

# Determine repo root
if [ -d /workspace ] && [ -f /workspace/install.sh ]; then
  REPO="/workspace"
elif [ -f "$(cd "$(dirname "$0")/../.." && pwd)/install.sh" ]; then
  REPO="$(cd "$(dirname "$0")/../.." && pwd)"
else
  echo "ERROR: Cannot find repo root."
  exit 1
fi

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-token-rotation}"
TOKEN_A="${TELEGRAM_BOT_TOKEN_A:-test-fake-invalid-token-rotation-e2e}"
TOKEN_B="${TELEGRAM_BOT_TOKEN_B:-}"

# Portable timeout: GNU coreutils `timeout` on Linux, `gtimeout` from
# Homebrew coreutils on macOS, or a built-in fallback using background
# process + sleep.
if command -v timeout >/dev/null 2>&1; then
  _timeout() { timeout "$@"; }
elif command -v gtimeout >/dev/null 2>&1; then
  _timeout() { gtimeout "$@"; }
else
  _timeout() {
    local secs="$1"; shift
    "$@" &
    local pid=$!
    ( sleep "$secs"; kill "$pid" 2>/dev/null ) &
    local watcher=$!
    wait "$pid" 2>/dev/null
    local rc=$?
    kill "$watcher" 2>/dev/null
    wait "$watcher" 2>/dev/null || true
    return $rc
  }
fi

# Run a command inside the sandbox and capture output
sandbox_exec() {
  local cmd="$1"
  local ssh_config
  ssh_config="$(mktemp)"
  openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null

  local result
  result=$(_timeout 60 ssh -F "$ssh_config" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" \
    "$cmd" \
    2>&1) || true

  rm -f "$ssh_config"
  echo "$result"
}

# Call Telegram getMe from inside the sandbox and print "<status_code> <body>"
# The sandbox holds a placeholder token; the OpenShell L7 proxy rewrites it
# to the real credential on egress.
telegram_get_me() {
  sandbox_exec 'node -e "
const https = require(\"https\");
const token = process.env.TELEGRAM_BOT_TOKEN || \"missing\";
const url = \"https://api.telegram.org/bot\" + token + \"/getMe\";
const req = https.get(url, (res) => {
  let body = \"\";
  res.on(\"data\", (d) => body += d);
  res.on(\"end\", () => console.log(res.statusCode + \" \" + body.slice(0, 500)));
});
req.on(\"error\", (e) => console.log(\"ERROR: \" + e.message));
req.setTimeout(30000, () => { req.destroy(); console.log(\"TIMEOUT\"); });
"' 2>/dev/null || true
}

# Extract HTTP status code from telegram_get_me output, filtering Node.js warnings
extract_status() {
  echo "$1" | grep -E '^[0-9]' | head -1 | awk '{print $1}'
}

# Extract bot username from a Telegram getMe JSON response body
extract_bot_username() {
  echo "$1" | grep -E '^[0-9]' | head -1 | sed 's/^[0-9]* //' | \
    node -e "
      let d=''; process.stdin.on('data',c=>d+=c);
      process.stdin.on('end',()=>{
        try { const r=JSON.parse(d); console.log(r.result&&r.result.username||''); }
        catch { console.log(''); }
      });
    " 2>/dev/null || true
}

# ══════════════════════════════════════════════════════════════════
# Phase 0: Prerequisites
# ══════════════════════════════════════════════════════════════════
section "Phase 0: Prerequisites"

if [ -z "${NVIDIA_API_KEY:-}" ]; then
  fail "R0: NVIDIA_API_KEY not set"
  exit 1
fi
pass "R0: NVIDIA_API_KEY is set"

if ! docker info >/dev/null 2>&1; then
  fail "R0: Docker is not running"
  exit 1
fi
pass "R0: Docker is running"

if [ -z "$TOKEN_B" ]; then
  fail "R0: TELEGRAM_BOT_TOKEN_B not set — a valid Telegram bot token is required for rotation testing"
  exit 1
fi
pass "R0: TELEGRAM_BOT_TOKEN_B is set"

info "Token A (invalid): ${TOKEN_A:0:20}... (${#TOKEN_A} chars)"
info "Token B (valid):   ${TOKEN_B:0:20}... (${#TOKEN_B} chars)"
info "Sandbox name: $SANDBOX_NAME"

# ══════════════════════════════════════════════════════════════════
# Phase 1: Install NemoClaw with token A (invalid)
# ══════════════════════════════════════════════════════════════════
section "Phase 1: Install NemoClaw with token A (invalid)"

cd "$REPO" || exit 1

# Pre-cleanup: destroy any leftover sandbox from previous runs
info "Pre-cleanup..."
if command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
fi
if command -v openshell >/dev/null 2>&1; then
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
  openshell gateway destroy -g nemoclaw 2>/dev/null || true
fi
pass "R1: Pre-cleanup complete"

# Export token A for initial install.
# Use the "open" policy tier so the telegram preset is applied — the default
# "balanced" tier does not include messaging presets, which blocks egress to
# api.telegram.org and causes the getMe calls to fail.
export TELEGRAM_BOT_TOKEN="$TOKEN_A"
export NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
export NEMOCLAW_RECREATE_SANDBOX=1
export NEMOCLAW_POLICY_TIER="open"

info "Running install.sh --non-interactive with token A..."
info "Expected duration: 5-10 minutes on first run."

INSTALL_LOG="/tmp/nemoclaw-e2e-rotation-install.log"
bash install.sh --non-interactive >"$INSTALL_LOG" 2>&1 &
install_pid=$!
tail -f "$INSTALL_LOG" --pid=$install_pid 2>/dev/null &
tail_pid=$!
wait $install_pid
install_exit=$?
kill $tail_pid 2>/dev/null || true
wait $tail_pid 2>/dev/null || true

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
  pass "R1: install.sh completed (exit 0)"
else
  fail "R1: install.sh failed (exit $install_exit)"
  info "Last 30 lines of install log:"
  tail -30 "$INSTALL_LOG" 2>/dev/null || true
  exit 1
fi

# Verify tools are on PATH
if ! command -v openshell >/dev/null 2>&1; then
  fail "R1: openshell not found on PATH after install"
  exit 1
fi
pass "R1: openshell installed ($(openshell --version 2>&1 || echo unknown))"

if ! command -v nemoclaw >/dev/null 2>&1; then
  fail "R1: nemoclaw not found on PATH after install"
  exit 1
fi
pass "R1: nemoclaw installed at $(command -v nemoclaw)"

# Verify sandbox is ready
sandbox_list=$(openshell sandbox list 2>&1 || true)
if echo "$sandbox_list" | grep -q "$SANDBOX_NAME.*Ready"; then
  pass "R1: Sandbox '$SANDBOX_NAME' is Ready"
else
  fail "R1: Sandbox '$SANDBOX_NAME' not Ready (list: ${sandbox_list:0:200})"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
# Phase 2: Verify sandbox and provider with token A
# ══════════════════════════════════════════════════════════════════
section "Phase 2: Verify sandbox and provider (token A)"

# R3: Telegram provider exists in gateway
PROVIDER_NAME="${SANDBOX_NAME}-telegram-bridge"
if openshell provider get "$PROVIDER_NAME" >/dev/null 2>&1; then
  pass "R2: Provider '$PROVIDER_NAME' exists in gateway"
else
  fail "R2: Provider '$PROVIDER_NAME' not found in gateway"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
# Phase 3: Verify token A is active (getMe should return 4xx)
# ══════════════════════════════════════════════════════════════════
section "Phase 3: Verify token A is active (expect 4xx)"

info "Calling Telegram getMe from inside sandbox (token A — invalid)..."
tg_response_a=$(telegram_get_me)
tg_status_a=$(extract_status "$tg_response_a")

info "Telegram API response (token A): ${tg_response_a:0:300}"

if [ "$tg_status_a" = "401" ] || [ "$tg_status_a" = "404" ]; then
  # Telegram returns 401 or 404 for invalid tokens. Either status proves the
  # L7 proxy rewrote the placeholder and the request reached the real API.
  pass "R3: getMe returned $tg_status_a with token A — L7 proxy chain works, invalid token rejected by Telegram"
elif [ "$tg_status_a" = "200" ]; then
  fail "R3: getMe returned 200 with token A — token A should be invalid but got success"
elif echo "$tg_response_a" | grep -q "TIMEOUT"; then
  skip "R3: Telegram API timed out (network issue, not a plumbing failure)"
elif echo "$tg_response_a" | grep -q "ERROR"; then
  fail "R3: Telegram API call failed: ${tg_response_a:0:200}"
else
  fail "R3: Unexpected response (status=$tg_status_a): ${tg_response_a:0:200}"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 4: Rotate token — re-onboard with token B (valid)
# ══════════════════════════════════════════════════════════════════
section "Phase 4: Rotate to token B via nemoclaw onboard (reuse)"

# Export the new token and re-onboard. In non-interactive mode with an existing
# ready sandbox, onboard reuses the sandbox and calls upsertMessagingProviders()
# which issues `openshell provider update` with the new credential.
export TELEGRAM_BOT_TOKEN="$TOKEN_B"
# Do NOT set NEMOCLAW_RECREATE_SANDBOX — the whole point is reuse.
unset NEMOCLAW_RECREATE_SANDBOX

# Remove stale lock from previous runs
rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true

info "Running nemoclaw onboard (non-interactive, reuse mode) with token B..."
ONBOARD_LOG="/tmp/nemoclaw-e2e-rotation-onboard.log"
NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
  NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  TELEGRAM_BOT_TOKEN="$TOKEN_B" \
  nemoclaw onboard --non-interactive >"$ONBOARD_LOG" 2>&1
onboard_exit=$?

if [ $onboard_exit -eq 0 ]; then
  pass "R4: nemoclaw onboard (reuse) completed (exit 0)"
else
  fail "R4: nemoclaw onboard (reuse) failed (exit $onboard_exit)"
  info "Last 30 lines of onboard log:"
  tail -30 "$ONBOARD_LOG" 2>/dev/null || true
  exit 1
fi

# R6: Provider still exists after re-onboard
if openshell provider get "$PROVIDER_NAME" >/dev/null 2>&1; then
  pass "R5: Provider '$PROVIDER_NAME' still present after re-onboard"
else
  fail "R5: Provider '$PROVIDER_NAME' disappeared after re-onboard"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 5: Verify token B is active (getMe should return 200)
# ══════════════════════════════════════════════════════════════════
section "Phase 5: Verify token B is active (expect 200)"

info "Calling Telegram getMe from inside sandbox (token B — valid)..."
tg_response_b=$(telegram_get_me)
tg_status_b=$(extract_status "$tg_response_b")

info "Telegram API response (token B): ${tg_response_b:0:300}"

if [ "$tg_status_b" = "200" ]; then
  pass "R6: getMe returned 200 — token B is active after rotation"

  # Extract bot identity from the response to confirm it's bot B
  bot_username_b=$(extract_bot_username "$tg_response_b")
  if [ -n "$bot_username_b" ]; then
    pass "R7: Bot identity after rotation: @${bot_username_b}"
    info "Token rotation confirmed — gateway now routes with token B (bot @${bot_username_b})"
  else
    skip "R7: Could not extract bot username from response (response may be truncated)"
  fi
elif [ "$tg_status_b" = "401" ] || [ "$tg_status_b" = "404" ]; then
  fail "R6: getMe returned $tg_status_b — token B was NOT picked up by the gateway (rotation failed)"
elif echo "$tg_response_b" | grep -q "TIMEOUT"; then
  skip "R6: Telegram API timed out (network issue, not a plumbing failure)"
  skip "R7: Skipped — getMe timed out"
elif echo "$tg_response_b" | grep -q "ERROR"; then
  fail "R6: Telegram API call failed: ${tg_response_b:0:200}"
else
  fail "R6: Unexpected response (status=$tg_status_b): ${tg_response_b:0:200}"
fi

# # ══════════════════════════════════════════════════════════════════
# # Phase 6: Cleanup
# # ══════════════════════════════════════════════════════════════════
# section "Phase 6: Cleanup"

# info "Destroying sandbox '$SANDBOX_NAME'..."
# nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
# openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true

# # Verify cleanup
# if openshell sandbox list 2>&1 | grep -q "$SANDBOX_NAME"; then
#   fail "R8: Sandbox '$SANDBOX_NAME' still present after cleanup"
# else
#   pass "R8: Sandbox '$SANDBOX_NAME' removed"
# fi

# ══════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════
echo ""
echo "========================================"
echo "  Token Rotation Test Results:"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Skipped: $SKIP"
echo "    Total:   $TOTAL"
echo "========================================"

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  Token rotation tests PASSED.\033[0m\n'
  exit 0
else
  printf '\n\033[1;31m  %d test(s) FAILED.\033[0m\n' "$FAIL"
  exit 1
fi
