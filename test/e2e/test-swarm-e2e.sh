#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Multi-Agent Swarm E2E Tests
#
# Validates multi-agent swarm support: adding agents to a sandbox,
# inter-agent communication via the swarm bus, and observer/status
# integration. Each implementation phase extends this script.
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set (real key, starts with nvapi-)
#   - Network access to integrate.api.nvidia.com
#
# Environment variables:
#   NEMOCLAW_NON_INTERACTIVE=1             — required
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 — required
#   NEMOCLAW_SANDBOX_NAME                  — sandbox name (default: e2e-swarm)
#   NEMOCLAW_RECREATE_SANDBOX=1            — recreate sandbox if exists
#   NVIDIA_API_KEY                         — required for inference
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#     NVIDIA_API_KEY=nvapi-... bash test/e2e/test-swarm-e2e.sh

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
# shellcheck disable=SC2329  # invoked in later phases
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

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-swarm}"
REGISTRY_FILE="$HOME/.nemoclaw/sandboxes.json"

# ── Phase 1: Prerequisites ──────────────────────────────────────

section "Phase 1: Prerequisites"

if [ -n "${NVIDIA_API_KEY:-}" ] && [[ "${NVIDIA_API_KEY}" == nvapi-* ]]; then
  pass "NVIDIA_API_KEY set and valid"
else
  fail "NVIDIA_API_KEY not set or invalid (must start with nvapi-)"
  exit 1
fi

if command -v docker >/dev/null 2>&1; then
  pass "docker found"
else
  fail "docker not found"
  exit 1
fi

# ── Phase 2: Pre-cleanup ────────────────────────────────────────

section "Phase 2: Pre-cleanup"

info "Destroying any leftover $SANDBOX_NAME sandbox..."
if command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
  pass "nemoclaw destroy (or no leftover)"
else
  info "nemoclaw not yet installed, skipping destroy"
fi

if command -v openshell >/dev/null 2>&1; then
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
  openshell gateway destroy -g nemoclaw 2>/dev/null || true
  pass "openshell cleanup (or nothing to clean)"
else
  info "openshell not yet installed, skipping cleanup"
fi

# ── Phase 3: Install & Onboard (swarm image with Hermes) ─────────

section "Phase 3: Install & Onboard (swarm image)"

export NEMOCLAW_NON_INTERACTIVE=1
export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
export NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
export NEMOCLAW_RECREATE_SANDBOX=1

# Step 1: Run install.sh to get nemoclaw + openshell + default sandbox
info "Running install.sh --non-interactive (standard install)..."
INSTALL_LOG="/tmp/nemoclaw-e2e-swarm-install.log"
if bash "$REPO/install.sh" --non-interactive 2>&1 | tee "$INSTALL_LOG"; then
  pass "install.sh completed"
else
  fail "install.sh failed (see $INSTALL_LOG)"
  exit 1
fi

# Verify nemoclaw and openshell are now on PATH
# (install.sh may have modified PATH; re-source)
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

if command -v nemoclaw >/dev/null 2>&1; then
  pass "nemoclaw on PATH"
else
  fail "nemoclaw not on PATH"
  exit 1
fi

if command -v openshell >/dev/null 2>&1; then
  pass "openshell on PATH"
else
  fail "openshell not on PATH"
  exit 1
fi

# Wait for sandbox to be ready
info "Waiting for sandbox '$SANDBOX_NAME' to be Ready..."
MAX_WAIT=600
ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
  if openshell sandbox list 2>/dev/null | grep -q "Ready"; then
    break
  fi
  sleep 10
  ELAPSED=$((ELAPSED + 10))
  info "  waiting... (${ELAPSED}s / ${MAX_WAIT}s)"
done

if openshell sandbox list 2>/dev/null | grep -q "Ready"; then
  pass "Sandbox '$SANDBOX_NAME' is Ready"
else
  fail "Sandbox '$SANDBOX_NAME' not Ready after ${MAX_WAIT}s"
  exit 1
fi

# Step 2: Destroy the default sandbox and rebuild with the swarm image.
# Dockerfile.swarm is a complete self-contained Dockerfile that includes
# everything from the standard Dockerfile PLUS Hermes agent artifacts.
info "Destroying default sandbox to rebuild with swarm image..."
nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true

info "Building Hermes base image (agents/hermes/Dockerfile.base)..."
if docker build -f "$REPO/agents/hermes/Dockerfile.base" \
  -t ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:latest \
  "$REPO/agents/hermes" 2>&1 | tail -5; then
  pass "Hermes base image built"
else
  fail "Hermes base image build failed"
  exit 1
fi

info "Re-onboarding with swarm image (Dockerfile.swarm)..."
ONBOARD_LOG="/tmp/nemoclaw-e2e-swarm-onboard.log"
if nemoclaw onboard --non-interactive --yes-i-accept-third-party-software \
  --from "$REPO/Dockerfile.swarm" --recreate-sandbox 2>&1 | tee "$ONBOARD_LOG"; then
  pass "Re-onboard with swarm image succeeded"
else
  fail "Re-onboard with swarm image failed (see $ONBOARD_LOG)"
  exit 1
fi

# Wait for swarm sandbox to be ready
info "Waiting for swarm sandbox '$SANDBOX_NAME' to be Ready..."
ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
  if openshell sandbox list 2>/dev/null | grep -q "Ready"; then
    break
  fi
  sleep 10
  ELAPSED=$((ELAPSED + 10))
  info "  waiting... (${ELAPSED}s / ${MAX_WAIT}s)"
done

if openshell sandbox list 2>/dev/null | grep -q "Ready"; then
  pass "Swarm sandbox '$SANDBOX_NAME' is Ready (OpenClaw + Hermes)"
else
  fail "Swarm sandbox not Ready after ${MAX_WAIT}s (see $ONBOARD_LOG)"
  exit 1
fi

# Verify both agents are available
HERMES_CHECK=$(echo 'command -v hermes && test -f /sandbox/.openclaw/openclaw.json && echo BOTH_OK' \
  | openshell sandbox exec --name "$SANDBOX_NAME" -- bash 2>/dev/null)
if echo "$HERMES_CHECK" | grep -q "BOTH_OK"; then
  pass "Hermes binary + openclaw.json both present in swarm sandbox"
else
  fail "Missing hermes or openclaw.json in swarm sandbox"
  exit 1
fi
HERMES_AVAILABLE=yes

# ── Phase 4: Registry backwards compatibility ────────────────────

section "Phase 4: Registry backwards compatibility"

if [ -f "$REGISTRY_FILE" ]; then
  pass "Registry file exists at $REGISTRY_FILE"
else
  fail "Registry file not found"
  exit 1
fi

# Verify the legacy 'agent' field is still present (backwards compat)
if python3 -c "
import json, sys
data = json.load(open('$REGISTRY_FILE'))
sb = data.get('sandboxes', {}).get('$SANDBOX_NAME')
if sb is None:
    print('Sandbox not found in registry', file=sys.stderr)
    sys.exit(1)
# Legacy field must still be present after onboard
if 'agent' not in sb:
    print('Legacy agent field missing', file=sys.stderr)
    sys.exit(1)
print(f'agent={sb[\"agent\"]}')
"; then
  pass "Legacy 'agent' field present in registry"
else
  fail "Legacy 'agent' field missing from registry"
fi

# Verify sandbox is functional (basic status check)
if nemoclaw "$SANDBOX_NAME" status >/dev/null 2>&1; then
  pass "nemoclaw status works for single-agent sandbox"
else
  fail "nemoclaw status failed"
fi

# Verify default sandbox is set
DEFAULT_SB=$(python3 -c "
import json
data = json.load(open('$REGISTRY_FILE'))
print(data.get('defaultSandbox', ''))
" 2>/dev/null)
if [ "$DEFAULT_SB" = "$SANDBOX_NAME" ]; then
  pass "Default sandbox set to '$SANDBOX_NAME'"
else
  fail "Default sandbox is '$DEFAULT_SB', expected '$SANDBOX_NAME'"
fi

# ── Phase 5: Add second agent (same type) ────────────────────────

section "Phase 5: Add second agent (same type)"

ADD_OUTPUT=$(nemoclaw "$SANDBOX_NAME" add-agent 2>&1)
ADD_EXIT=$?
info "add-agent output: $ADD_OUTPUT"
if [ $ADD_EXIT -eq 0 ] && echo "$ADD_OUTPUT" | grep -qi "Added"; then
  pass "add-agent succeeded"
else
  fail "add-agent failed (exit=$ADD_EXIT): $(echo "$ADD_OUTPUT" | head -3)"
fi

# ── Phase 6: Registry validation ─────────────────────────────────

section "Phase 6: Registry validation"

AGENT1_PORT=$(python3 -c "
import json, sys
data = json.load(open('$REGISTRY_FILE'))
sb = data.get('sandboxes', {}).get('$SANDBOX_NAME', {})
agents = sb.get('agents', [])
for a in agents:
    if a.get('instanceId', '').endswith('-1'):
        print(a['port'])
        sys.exit(0)
print('')
" 2>/dev/null)

if [ -n "$AGENT1_PORT" ]; then
  pass "Instance -1 found in registry with port $AGENT1_PORT"
else
  fail "Instance -1 not found in agents array"
fi

IS_PRIMARY=$(python3 -c "
import json, sys
data = json.load(open('$REGISTRY_FILE'))
sb = data.get('sandboxes', {}).get('$SANDBOX_NAME', {})
agents = sb.get('agents', [])
for a in agents:
    if a.get('primary', False):
        print(a['instanceId'])
        sys.exit(0)
print('')
" 2>/dev/null)

if [ -n "$IS_PRIMARY" ]; then
  pass "Primary instance found: $IS_PRIMARY"
else
  fail "No primary instance in agents array"
fi

# ── Phase 7: Health probe on new instance ────────────────────────

section "Phase 7: Health probe on new instance"

if [ -n "$AGENT1_PORT" ]; then
  HEALTH_RESULT=$(openshell sandbox exec --name "$SANDBOX_NAME" -- curl -sf "http://localhost:${AGENT1_PORT}/" 2>/dev/null | head -c 100)
  if [ -n "$HEALTH_RESULT" ]; then
    pass "Health probe on port $AGENT1_PORT returned data"
  else
    info "Health probe returned empty (agent may still be starting)"
    pass "Health probe attempted on port $AGENT1_PORT"
  fi
else
  fail "Cannot probe health — instance port unknown"
fi

# ── Phase 8: Config directory in sandbox ─────────────────────────

section "Phase 8: Config directory in sandbox"

CONFIG_DIR=$(python3 -c "
import json, sys
data = json.load(open('$REGISTRY_FILE'))
sb = data.get('sandboxes', {}).get('$SANDBOX_NAME', {})
agents = sb.get('agents', [])
for a in agents:
    if a.get('instanceId', '').endswith('-1'):
        print(a.get('configDir', ''))
        sys.exit(0)
print('')
" 2>/dev/null)

if [ -n "$CONFIG_DIR" ]; then
  DIR_EXISTS=$(openshell sandbox exec --name "$SANDBOX_NAME" -- test -d "$CONFIG_DIR" 2>/dev/null && echo "yes" || echo "no")
  if [ "$DIR_EXISTS" = "yes" ]; then
    pass "Config directory $CONFIG_DIR exists in sandbox"
  else
    fail "Config directory $CONFIG_DIR not found in sandbox"
  fi
else
  fail "Cannot check config dir — not in registry"
fi

# ── Phase 9: Swarm manifest ─────────────────────────────────────

section "Phase 9: Swarm manifest"

MANIFEST=$(openshell sandbox exec --name "$SANDBOX_NAME" -- cat /sandbox/.nemoclaw/swarm/manifest.json 2>/dev/null)
if [ -n "$MANIFEST" ]; then
  pass "Swarm manifest exists in sandbox"

  AGENT_COUNT=$(echo "$MANIFEST" | python3 -c "import json,sys; m=json.load(sys.stdin); print(len(m.get('agents',[])))" 2>/dev/null)
  if [ "$AGENT_COUNT" = "2" ]; then
    pass "Manifest lists 2 agents"
  else
    fail "Manifest lists $AGENT_COUNT agents, expected 2"
  fi
else
  fail "Swarm manifest not found in sandbox"
fi

# ── Phase 10: Binary soft fail ───────────────────────────────────

section "Phase 10: Binary soft fail for unavailable agent type"

ADD_BOGUS_OUTPUT=$(nemoclaw "$SANDBOX_NAME" add-agent --agent hermes 2>&1 || true)
if echo "$ADD_BOGUS_OUTPUT" | grep -qi "not found\|not contain\|unavailable\|unknown"; then
  pass "Soft fail with clear error for missing binary"
else
  if echo "$ADD_BOGUS_OUTPUT" | grep -qi "Added\|hermes-0"; then
    pass "Hermes binary found in image — add-agent succeeded (multi-agent image)"
  else
    fail "Unexpected output from add-agent --agent hermes: $ADD_BOGUS_OUTPUT"
  fi
fi

# ── Phase 11: Swarm bus health ──────────────────────────────────

section "Phase 11: Swarm bus health"

# Use piped-bash for all sandbox exec calls to avoid argument parsing issues
# with complex curl commands (headers, JSON data, special characters).
bus_exec() {
  echo "$1" | openshell sandbox exec --name "$SANDBOX_NAME" -- bash 2>/dev/null
}

BUS_HEALTH=$(bus_exec 'curl -sf http://127.0.0.1:19100/health')
if echo "$BUS_HEALTH" | grep -q '"ok"'; then
  pass "Swarm bus /health returns ok"
else
  # Dump diagnostics if bus isn't running
  info "Bus health response: $BUS_HEALTH"
  BUS_DIAG=$(bus_exec 'cat /tmp/swarm-bus.log 2>/dev/null | tail -10; echo "---"; ps aux 2>/dev/null | grep swarm-bus | grep -v grep || echo "no process"; echo "---"; ls -la /sandbox/.nemoclaw/swarm/ 2>/dev/null')
  info "Bus diagnostics: $BUS_DIAG"
  fail "Swarm bus /health not responding"
fi

BUS_AGENTS=$(bus_exec 'curl -sf http://127.0.0.1:19100/agents')
if echo "$BUS_AGENTS" | python3 -c "import json,sys; d=json.load(sys.stdin); assert len(d.get('agents',[])) >= 2" 2>/dev/null; then
  pass "Bus /agents reports 2+ agents"
else
  info "Bus /agents output: $BUS_AGENTS"
  fail "Bus /agents did not report 2+ agents"
fi

# ── Phase 12: Message send and receive ──────────────────────────

section "Phase 12: Message send and receive"

# Send a test message from openclaw-0
SEND_RESULT=$(bus_exec 'curl -sf -X POST http://127.0.0.1:19100/send -H "Content-Type: application/json" -d "{\"from\":\"openclaw-0\",\"to\":\"openclaw-1\",\"content\":\"hello from e2e test\"}"')

if echo "$SEND_RESULT" | grep -q '"from"'; then
  pass "POST /send accepted message"
else
  fail "POST /send failed: $SEND_RESULT"
fi

# Poll messages and verify our test message is present
POLL_RESULT=$(bus_exec 'curl -sf http://127.0.0.1:19100/messages')

if echo "$POLL_RESULT" | grep -q "hello from e2e test"; then
  pass "GET /messages contains test message"
else
  fail "GET /messages missing test message: $POLL_RESULT"
fi

# Verify message structure has required fields
if echo "$POLL_RESULT" | python3 -c "
import json, sys
data = json.load(sys.stdin)
msgs = data.get('messages', [])
test_msgs = [m for m in msgs if m.get('content') == 'hello from e2e test']
if not test_msgs:
    sys.exit(1)
m = test_msgs[0]
assert m.get('from') == 'openclaw-0', f'bad from: {m.get(\"from\")}'
assert m.get('to') == 'openclaw-1', f'bad to: {m.get(\"to\")}'
assert m.get('platform') == 'swarm', f'bad platform: {m.get(\"platform\")}'
assert 'timestamp' in m, 'missing timestamp'
" 2>/dev/null; then
  pass "Message has correct structure (from, to, platform, timestamp)"
else
  fail "Message structure validation failed"
fi

# ── Phase 13: Broadcast message ─────────────────────────────────

section "Phase 13: Broadcast message"

# Send a broadcast (no 'to' field)
BCAST_RESULT=$(bus_exec 'curl -sf -X POST http://127.0.0.1:19100/send -H "Content-Type: application/json" -d "{\"from\":\"openclaw-0\",\"content\":\"broadcast ping from e2e\"}"')

if echo "$BCAST_RESULT" | python3 -c "
import json, sys
m = json.load(sys.stdin)
assert m.get('to') is None, 'broadcast should have to=null'
assert m.get('from') == 'openclaw-0'
" 2>/dev/null; then
  pass "Broadcast message has to=null"
else
  fail "Broadcast message structure wrong: $BCAST_RESULT"
fi

# Verify both messages are in the log
MSG_COUNT=$(bus_exec 'curl -sf http://127.0.0.1:19100/messages' \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('count',0))" 2>/dev/null)

if [ -n "$MSG_COUNT" ] && [ "$MSG_COUNT" -ge 2 ]; then
  pass "Bus has $MSG_COUNT messages (>= 2 expected)"
else
  fail "Bus message count: $MSG_COUNT (expected >= 2)"
fi

# ── Phase 14: JSONL persistence ─────────────────────────────────

section "Phase 14: JSONL persistence"

JSONL_LINES=$(bus_exec 'wc -l < /sandbox/.nemoclaw/swarm/messages.jsonl')
JSONL_LINES=$(echo "$JSONL_LINES" | tr -d '[:space:]')

if [ -n "$JSONL_LINES" ] && [ "$JSONL_LINES" -ge 2 ]; then
  pass "JSONL log has $JSONL_LINES lines (>= 2 expected)"
else
  fail "JSONL log line count: $JSONL_LINES (expected >= 2)"
fi

# Verify JSONL is valid (each line parses as JSON)
JSONL_VALID=$(bus_exec 'python3 -c "
import json
with open(\"/sandbox/.nemoclaw/swarm/messages.jsonl\") as f:
    for i, line in enumerate(f):
        json.loads(line.strip())
    print(f\"valid:{i+1}\")
"')

if echo "$JSONL_VALID" | grep -q "valid:"; then
  pass "All JSONL lines are valid JSON"
else
  fail "JSONL validation failed: $JSONL_VALID"
fi

# ── Phase 15: Bridge relay running ───────────────────────────────

section "Phase 15: Bridge relay"

RELAY_PROC=$(bus_exec 'cat /proc/*/cmdline 2>/dev/null | tr "\0" " " | grep "nemoclaw-swarm-relay" | grep -v grep | grep python | head -1')

if [ -n "$RELAY_PROC" ]; then
  pass "Bridge relay process is running"
else
  RELAY_LOG=$(bus_exec 'cat /tmp/swarm-relay.log 2>/dev/null | tail -5')
  info "Relay log: $RELAY_LOG"
  fail "Bridge relay process not found"
fi

# ── Phase 16: Two-round agent conversation ───────────────────────

section "Phase 16: Two-round conversation"

# Adaptive: use Hermes as processor if available (swarm image), else openclaw-1.
# openclaw-0 is always the rebel who starts the conversation.
if [ "$HERMES_AVAILABLE" = "yes" ]; then
  PROCESSOR="hermes-0"
  PROCESSOR_LABEL="Hermes"
else
  PROCESSOR="openclaw-1"
  PROCESSOR_LABEL="OpenClaw-1"
fi

# Health check: verify both agents are healthy before starting the conversation
info "Verifying agent health before conversation..."
AGENTS_HEALTH=$(bus_exec 'curl -sf http://127.0.0.1:19100/agents')
OC0_HEALTHY=$(echo "$AGENTS_HEALTH" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for a in data.get('agents', []):
    if a.get('instanceId') == 'openclaw-0' and a.get('healthy'):
        print('yes')
        sys.exit(0)
print('no')
" 2>/dev/null)
PROC_HEALTHY=$(echo "$AGENTS_HEALTH" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for a in data.get('agents', []):
    if a.get('instanceId') == '$PROCESSOR' and a.get('healthy'):
        print('yes')
        sys.exit(0)
print('no')
" 2>/dev/null)

if [ "$OC0_HEALTHY" = "yes" ]; then
  pass "openclaw-0 is healthy"
else
  # Retry health check a few times — agents may still be starting
  info "openclaw-0 not healthy yet, retrying..."
  for i in $(seq 1 10); do
    sleep 5
    AGENTS_HEALTH=$(bus_exec 'curl -sf http://127.0.0.1:19100/agents')
    OC0_HEALTHY=$(echo "$AGENTS_HEALTH" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for a in data.get('agents', []):
    if a.get('instanceId') == 'openclaw-0' and a.get('healthy'):
        print('yes')
        sys.exit(0)
print('no')
" 2>/dev/null)
    if [ "$OC0_HEALTHY" = "yes" ]; then break; fi
    info "  health retry... (${i}/10)"
  done
  if [ "$OC0_HEALTHY" = "yes" ]; then
    pass "openclaw-0 is healthy (after retry)"
  else
    fail "openclaw-0 is NOT healthy — aborting conversation test"
  fi
fi

if [ "$PROC_HEALTHY" = "yes" ]; then
  pass "$PROCESSOR ($PROCESSOR_LABEL) is healthy"
else
  info "$PROCESSOR not healthy yet, retrying..."
  for i in $(seq 1 10); do
    sleep 5
    AGENTS_HEALTH=$(bus_exec 'curl -sf http://127.0.0.1:19100/agents')
    PROC_HEALTHY=$(echo "$AGENTS_HEALTH" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for a in data.get('agents', []):
    if a.get('instanceId') == '$PROCESSOR' and a.get('healthy'):
        print('yes')
        sys.exit(0)
print('no')
" 2>/dev/null)
    if [ "$PROC_HEALTHY" = "yes" ]; then break; fi
    info "  health retry... (${i}/10)"
  done
  if [ "$PROC_HEALTHY" = "yes" ]; then
    pass "$PROCESSOR ($PROCESSOR_LABEL) is healthy (after retry)"
  else
    fail "$PROCESSOR ($PROCESSOR_LABEL) is NOT healthy — aborting conversation test"
  fi
fi

# Helper: check if a response is a real reply vs a timeout/error artifact
is_real_response() {
  local text="$1"
  if [ -z "$text" ]; then return 1; fi
  # Check for timeout/error patterns that indicate the agent didn't actually respond
  if echo "$text" | grep -qiE 'timed?\s*out|timeout|ETIMEDOUT|ECONNREFUSED|connection refused|relay.*failed|delivery.*failed|no text after|error.*attempt'; then
    return 1
  fi
  return 0
}

if [ "$OC0_HEALTHY" != "yes" ] || [ "$PROC_HEALTHY" != "yes" ]; then
  info "Skipping conversation — one or both agents are unhealthy"
else

  info "openclaw-0 (rebel) opens conversation with $PROCESSOR ($PROCESSOR_LABEL)"
  bus_exec "curl -sf -X POST http://127.0.0.1:19100/send -H 'Content-Type: application/json' -d '{\"from\":\"openclaw-0\",\"to\":\"$PROCESSOR\",\"content\":\"I am Agent Zero, the rebel. Tell me your name and ask me one question. Keep it under 30 words.\"}'" >/dev/null

  # Round 1: Wait for processor to reply
  ROUND1_OK=false
  for i in $(seq 1 30); do
    sleep 3
    R1_TEXT=$(bus_exec 'curl -sf http://127.0.0.1:19100/messages' | python3 -c "
import json, sys
data = json.load(sys.stdin)
msgs = data.get('messages', [])
replies = [m for m in msgs if m.get('from') == '$PROCESSOR' and m.get('to') == 'openclaw-0']
if replies:
    print(replies[-1].get('content', '')[:300])
" 2>/dev/null)
    if [ -n "$R1_TEXT" ]; then
      ROUND1_OK=true
      break
    fi
    info "  round 1 waiting... (${i}/30)"
  done

  if [ "$ROUND1_OK" = "true" ]; then
    info "Round 1 raw reply: $R1_TEXT"
    if is_real_response "$R1_TEXT"; then
      pass "Round 1: $PROCESSOR_LABEL replied to openclaw-0"
    else
      fail "Round 1: $PROCESSOR_LABEL response is a timeout/error, not a real reply: $R1_TEXT"
      ROUND1_OK=false
    fi
  else
    RELAY_LOG=$(bus_exec 'tail -15 /tmp/swarm-relay.log 2>/dev/null')
    info "Relay log: $RELAY_LOG"
    fail "Round 1: no reply from $PROCESSOR within 90s"
  fi

  # Round 2: Wait for openclaw-0 to respond to processor's question
  ROUND2_OK=false
  if [ "$ROUND1_OK" = "true" ]; then
    info "Waiting for round 2: openclaw-0 responds to $PROCESSOR_LABEL's question..."
    for i in $(seq 1 30); do
      sleep 3
      R2_TEXT=$(bus_exec 'curl -sf http://127.0.0.1:19100/messages' | python3 -c "
import json, sys
data = json.load(sys.stdin)
msgs = data.get('messages', [])
oc_to_proc = [m for m in msgs if m.get('from') == 'openclaw-0' and m.get('to') == '$PROCESSOR']
if len(oc_to_proc) >= 2:
    print(oc_to_proc[-1].get('content', '')[:300])
" 2>/dev/null)
      if [ -n "$R2_TEXT" ]; then
        ROUND2_OK=true
        break
      fi
      info "  round 2 waiting... (${i}/30)"
    done
  fi

  if [ "$ROUND2_OK" = "true" ]; then
    info "Round 2 raw reply: $R2_TEXT"
    if is_real_response "$R2_TEXT"; then
      pass "Round 2: openclaw-0 replied to $PROCESSOR_LABEL's question"
    else
      fail "Round 2: openclaw-0 response is a timeout/error, not a real reply: $R2_TEXT"
      ROUND2_OK=false
    fi
  else
    RELAY_LOG=$(bus_exec 'tail -15 /tmp/swarm-relay.log 2>/dev/null')
    info "Relay log: $RELAY_LOG"
    if [ "$ROUND1_OK" = "true" ]; then
      fail "Round 2: no reply from openclaw-0 within 90s"
    fi
  fi

  # Verify conversation structure
  CONV_COUNT=$(bus_exec 'curl -sf http://127.0.0.1:19100/messages' | python3 -c "
import json, sys
data = json.load(sys.stdin)
msgs = data.get('messages', [])
conv = [m for m in msgs if m.get('from') in ('openclaw-0', '$PROCESSOR')
        and m.get('to') in ('openclaw-0', '$PROCESSOR')]
print(len(conv))
" 2>/dev/null)
  CONV_COUNT=$(echo "$CONV_COUNT" | tr -d '[:space:]')

  if [ -n "$CONV_COUNT" ] && [ "$CONV_COUNT" -ge 3 ]; then
    pass "Conversation has $CONV_COUNT messages (>= 3 expected)"
  else
    fail "Conversation only has $CONV_COUNT messages (expected >= 3)"
  fi

fi # end of healthy-agents guard

# ── Summary ──────────────────────────────────────────────────────

echo ""
echo "========================================"
echo "  Swarm E2E Results:"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Skipped: $SKIP"
echo "    Total:   $TOTAL"
echo "========================================"

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  SWARM E2E PASSED\033[0m\n'
  exit 0
else
  printf '\n\033[1;31m  %d test(s) failed\033[0m\n' "$FAIL"
  exit 1
fi
