#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Diagnose egress proxy binary resolution failures (issue #1471).
#
# Collects namespace, /proc, and proxy diagnostic info from both the pod
# and the sandbox to identify why the proxy reports "binary=-".
#
# Usage: ./scripts/diagnose-proxy-binary-resolution.sh [gateway-name] <sandbox-name>
#
# See: https://github.com/NVIDIA/NemoClaw/issues/1471

set -euo pipefail

GATEWAY_NAME="${1:-}"
SANDBOX_NAME="${2:-}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=./lib/runtime.sh
. "$SCRIPT_DIR/lib/runtime.sh"

if [ -z "$SANDBOX_NAME" ]; then
  echo "Usage: $0 [gateway-name] <sandbox-name>"
  exit 1
fi

section() {
  printf '\n\033[1;36m─── %s ───\033[0m\n' "$1"
}
info() { printf '  %s\n' "$1"; }
warn() { printf '\033[1;33m  [WARN] %s\033[0m\n' "$1"; }
ok() { printf '\033[1;32m  [OK] %s\033[0m\n' "$1"; }
err() { printf '\033[1;31m  [ERR] %s\033[0m\n' "$1"; }

# ── Find gateway container ─────────────────────────────────────────
if [ -z "${DOCKER_HOST:-}" ]; then
  if docker_host="$(detect_docker_host)"; then
    export DOCKER_HOST="$docker_host"
  fi
fi

CLUSTERS="$(docker ps --filter "name=openshell-cluster" --format '{{.Names}}' 2>/dev/null || true)"
CLUSTER="$(select_openshell_cluster_container "$GATEWAY_NAME" "$CLUSTERS" || true)"

if [ -z "$CLUSTER" ]; then
  echo "ERROR: Could not find openshell cluster container."
  exit 1
fi

kctl() { docker exec "$CLUSTER" kubectl "$@"; }

POD="$(kctl get pods -n openshell -o name 2>/dev/null \
  | grep -F -- "$SANDBOX_NAME" | head -1 | sed 's|pod/||' || true)"

if [ -z "$POD" ]; then
  echo "ERROR: Could not find pod for sandbox '$SANDBOX_NAME'."
  exit 1
fi

SANDBOX_NS="$(kctl exec -n openshell "$POD" -- sh -c \
  "ls /run/netns/ 2>/dev/null | grep sandbox | head -1" 2>/dev/null || true)"

echo "============================================="
echo "  Issue #1471 Diagnostic Report"
echo "  Sandbox: $SANDBOX_NAME"
echo "  Pod: $POD"
echo "  Cluster: $CLUSTER"
echo "  Sandbox netns: ${SANDBOX_NS:-not found}"
echo "============================================="

# ── 1. Pod-side namespace info ──────────────────────────────────────
section "1. Pod-side (proxy) namespace"

info "Network namespace:"
kctl exec -n openshell "$POD" -- readlink /proc/self/ns/net 2>/dev/null || info "unavailable"

info "PID namespace:"
kctl exec -n openshell "$POD" -- readlink /proc/self/ns/pid 2>/dev/null || info "unavailable"

info "Pod-side ESTABLISHED connections (TCP):"
kctl exec -n openshell "$POD" -- sh -c \
  "cat /proc/net/tcp 2>/dev/null | awk 'NR==1 || \$4==\"01\"' | head -10" 2>/dev/null || info "unavailable"

# ── 2. Sandbox-side namespace info ──────────────────────────────────
section "2. Sandbox-side namespace"

if [ -n "$SANDBOX_NS" ]; then
  sb_exec() {
    kctl exec -n openshell "$POD" -- ip netns exec "$SANDBOX_NS" "$@"
  }

  info "Network namespace:"
  sb_exec readlink /proc/self/ns/net 2>/dev/null || info "unavailable"

  info "PID namespace:"
  sb_exec readlink /proc/self/ns/pid 2>/dev/null || info "unavailable"

  info "Sandbox-side ESTABLISHED connections (TCP):"
  sb_exec sh -c "cat /proc/net/tcp 2>/dev/null | awk 'NR==1 || \$4==\"01\"' | head -10" 2>/dev/null || info "unavailable"

  info "Sandbox IP addresses:"
  sb_exec ip addr show 2>/dev/null | grep "inet " || info "unavailable"
else
  warn "Sandbox network namespace not found — cannot inspect sandbox side"
fi

# ── 3. Proxy process info ───────────────────────────────────────────
section "3. Proxy process identification"

info "Processes listening on :3128 (proxy port):"
kctl exec -n openshell "$POD" -- sh -c \
  "ss -tlnp 2>/dev/null | grep 3128 || netstat -tlnp 2>/dev/null | grep 3128 || echo 'no listener found'" 2>/dev/null

info "Proxy process details:"
kctl exec -n openshell "$POD" -- sh -c \
  "ps aux 2>/dev/null | grep -E 'proxy|egress|openshell' | grep -v grep | head -5 || echo 'no proxy process found'" 2>/dev/null

# ── 4. Cross-namespace /proc/net/tcp comparison ────────────────────
section "4. Cross-namespace /proc/net/tcp comparison"

info "This is the core of issue #1471:"
info "The proxy reads /proc/<proxy_pid>/net/tcp to find the calling binary."
info "If the sandbox is in a different network namespace, the proxy cannot"
info "see the sandbox's TCP connections → binary=- → deny all."
echo ""

POD_NS_ID="$(kctl exec -n openshell "$POD" -- readlink /proc/self/ns/net 2>/dev/null || true)"
SB_NS_ID=""
if [ -n "$SANDBOX_NS" ]; then
  SB_NS_ID="$(kctl exec -n openshell "$POD" -- ip netns exec "$SANDBOX_NS" readlink /proc/self/ns/net 2>/dev/null || true)"
fi

info "Pod network namespace:     ${POD_NS_ID:-unknown}"
info "Sandbox network namespace: ${SB_NS_ID:-unknown}"

if [ -n "$POD_NS_ID" ] && [ -n "$SB_NS_ID" ]; then
  if [ "$POD_NS_ID" = "$SB_NS_ID" ]; then
    ok "Same network namespace — proxy CAN see sandbox TCP connections"
    ok "Issue #1471 should NOT occur in this configuration"
  else
    err "DIFFERENT network namespaces — proxy CANNOT see sandbox TCP connections"
    err "This is the root cause of issue #1471"
    echo ""
    info "Fix required: OpenShell proxy must scan the sandbox namespace's"
    info "/proc/net/tcp (via nsenter or /proc/<sandbox_pid>/net/tcp) instead"
    info "of its own /proc/<proxy_pid>/net/tcp."
  fi
else
  warn "Could not compare namespaces — manual inspection needed"
fi

# ── 5. Live CONNECT test ───────────────────────────────────────────
section "5. Live CONNECT test (curl → proxy → api.github.com)"

info "Attempting curl through proxy from sandbox..."
if [ -n "$SANDBOX_NS" ]; then
  set +e
  CURL_RESULT=$(kctl exec -n openshell "$POD" -- ip netns exec "$SANDBOX_NS" \
    sh -c 'curl -sS -o /dev/null -w "http=%{http_code}" --max-time 15 \
    -x http://10.200.0.1:3128 https://api.github.com/ 2>&1' 2>&1)
  CURL_RC=$?
  set -e

  info "curl exit=$CURL_RC result=$CURL_RESULT"

  if echo "$CURL_RESULT" | grep -q "http=200\|http=30"; then
    ok "CONNECT succeeded — binary resolution is working"
  elif echo "$CURL_RESULT" | grep -qi "tunneling\|CONNECT.*403\|CONNECT.*407"; then
    err "CONNECT denied by proxy — binary resolution likely failed (binary=-)"
  else
    warn "Inconclusive result — check proxy logs for details"
  fi
else
  warn "Skipping live test — sandbox namespace not available"
fi

# ── 6. Proxy logs (recent deny entries) ─────────────────────────────
section "6. Recent proxy deny log entries"

info "Looking for 'binary=-' entries in proxy/gateway logs..."
kctl exec -n openshell "$POD" -- sh -c \
  "find /var/log /tmp -name '*.log' -newer /proc/1/comm -exec grep -l 'binary=-' {} \\; 2>/dev/null \
   | head -3 | while read -r f; do echo \"=== \$f ===\"; tail -20 \"\$f\" | grep 'binary=-' | tail -5; done" 2>/dev/null \
  || info "No proxy logs with binary=- found (or logs not accessible)"

# ── Summary ─────────────────────────────────────────────────────────
section "Summary"
echo ""
if [ -n "$POD_NS_ID" ] && [ -n "$SB_NS_ID" ] && [ "$POD_NS_ID" != "$SB_NS_ID" ]; then
  echo "  DIAGNOSIS: Issue #1471 IS present in this environment."
  echo ""
  echo "  The proxy and sandbox are in different network namespaces:"
  echo "    Pod:     $POD_NS_ID"
  echo "    Sandbox: $SB_NS_ID"
  echo ""
  echo "  The OpenShell egress proxy scans /proc/<proxy_pid>/net/tcp to identify"
  echo "  calling binaries, but the sandbox's TCP connections are invisible from"
  echo "  the proxy's namespace. All CONNECT requests report binary=- and are denied."
  echo ""
  echo "  WORKAROUND: Use an external bridge on the host (outside the sandbox)"
  echo "  to handle API calls that require CONNECT tunnels."
  echo ""
  echo "  FIX: OpenShell proxy must be updated to scan the sandbox namespace's"
  echo "  /proc/net/tcp (e.g., via /proc/<sandbox_init_pid>/net/tcp or nsenter)."
else
  echo "  DIAGNOSIS: Issue #1471 may not apply to this environment."
  echo "  Check proxy logs for other deny reasons."
fi
