#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

SUDO=()
((EUID != 0)) && SUDO=(sudo)

info() {
  printf "[INFO]  %s\n" "$*"
}

error() {
  printf "[ERROR] %s\n" "$*" >&2
  exit 1
}

# Returns 0 only when both the live kernel state AND our persistent
# drop-ins are in place:
#   - runtime: bridge-nf-call-iptables sysctl reads back as 1 (and the
#     same for bridge-nf-call-ip6tables IFF this kernel exposes it)
#   - persistence: /etc/modules-load.d/nemoclaw.conf contains `br_netfilter`
#     and /etc/sysctl.d/99-nemoclaw.conf contains the sysctl=1 line(s)
#     matching what the kernel actually supports
# The IPv6 checks are gated on /proc/sys/net/bridge/bridge-nf-call-ip6tables
# existing because kernels built without CONFIG_IPV6 do not expose that
# sysctl; asserting it unconditionally would make this function (and the
# apply step) fail on such hosts.
# Skipping on runtime-only state is wrong: if someone transiently ran
# `modprobe br_netfilter` + `sysctl -w ...=1` without persisting, the
# fix would evaporate after the next reboot. Requiring persistence too
# makes the skip branch safe and lets `apply_br_netfilter_setup_r39`
# (which is idempotent) re-write the drop-ins whenever they're missing
# or stale (e.g. an older v4-only version of this script left behind).
bridge_netfilter_ready() {
  # Runtime — v4 is mandatory (br_netfilter loaded + sysctl on)
  [[ -f /proc/sys/net/bridge/bridge-nf-call-iptables ]] || return 1
  [[ "$(cat /proc/sys/net/bridge/bridge-nf-call-iptables 2>/dev/null)" == "1" ]] || return 1

  # Persistence — modules-load drop-in
  [[ -f /etc/modules-load.d/nemoclaw.conf ]] || return 1
  grep -qx 'br_netfilter' /etc/modules-load.d/nemoclaw.conf 2>/dev/null || return 1

  # Persistence — sysctl drop-in, v4 line mandatory
  [[ -f /etc/sysctl.d/99-nemoclaw.conf ]] || return 1
  grep -qx 'net.bridge.bridge-nf-call-iptables=1' /etc/sysctl.d/99-nemoclaw.conf 2>/dev/null || return 1

  # If this kernel exposes bridge-nf-call-ip6tables, require both runtime
  # and persistence for it too. On kernels without IPv6 bridge netfilter
  # the /proc node does not exist — we treat v4-only as fully-ready
  # there, matching what apply_br_netfilter_setup_r39 actually wrote.
  if [[ -f /proc/sys/net/bridge/bridge-nf-call-ip6tables ]]; then
    [[ "$(cat /proc/sys/net/bridge/bridge-nf-call-ip6tables 2>/dev/null)" == "1" ]] || return 1
    grep -qx 'net.bridge.bridge-nf-call-ip6tables=1' /etc/sysctl.d/99-nemoclaw.conf 2>/dev/null || return 1
  fi

  return 0
}

# Load br_netfilter and flip bridge-nf-call-iptables, then persist both
# across reboots. Used by the R36/R38 paths — byte-identical to the
# original inline block that lived in configure_jetson_host before the
# #2418 refactor. Do NOT add IPv6 here: the R36/R38 paths predate the
# #2418 work and changing their behavior would be out of scope.
apply_br_netfilter_setup() {
  "${SUDO[@]}" modprobe br_netfilter
  "${SUDO[@]}" sysctl -w net.bridge.bridge-nf-call-iptables=1 >/dev/null

  # Persist across reboots
  echo "br_netfilter" | "${SUDO[@]}" tee /etc/modules-load.d/nemoclaw.conf >/dev/null
  echo "net.bridge.bridge-nf-call-iptables=1" | "${SUDO[@]}" tee /etc/sysctl.d/99-nemoclaw.conf >/dev/null
}

# R39-specific variant: flips bridge-nf-call-iptables and, when the
# kernel exposes it, bridge-nf-call-ip6tables, then persists whatever
# was actually applied. Kept separate from apply_br_netfilter_setup so
# the R36/R38 behavior stays byte-identical to pre-#2418; the dual-stack
# sysctl write is the configuration the reporter validated end-to-end
# on their Jetson Orin R39 (#2418).
# The IPv6 sysctl write is gated on /proc/sys/net/bridge/bridge-nf-call-ip6tables
# existing because kernels built without CONFIG_IPV6 do not expose that
# sysctl; `sysctl -w` on a missing key would fail under `set -e`. On
# such hosts the persistence drop-in only carries the IPv4 line, and
# bridge_netfilter_ready() mirrors this (only requires the IPv6 line
# when the /proc node is present).
# Idempotent: safe to call whenever bridge_netfilter_ready returns false,
# including the "runtime is live but drop-ins missing" case (e.g. someone
# ran modprobe + sysctl manually without persisting).
apply_br_netfilter_setup_r39() {
  "${SUDO[@]}" modprobe br_netfilter
  "${SUDO[@]}" sysctl -w net.bridge.bridge-nf-call-iptables=1 >/dev/null

  local has_ipv6=0
  if [[ -f /proc/sys/net/bridge/bridge-nf-call-ip6tables ]]; then
    "${SUDO[@]}" sysctl -w net.bridge.bridge-nf-call-ip6tables=1 >/dev/null
    has_ipv6=1
  fi

  # Persist across reboots
  echo "br_netfilter" | "${SUDO[@]}" tee /etc/modules-load.d/nemoclaw.conf >/dev/null
  if ((has_ipv6)); then
    {
      echo "net.bridge.bridge-nf-call-iptables=1"
      echo "net.bridge.bridge-nf-call-ip6tables=1"
    } | "${SUDO[@]}" tee /etc/sysctl.d/99-nemoclaw.conf >/dev/null
  else
    echo "net.bridge.bridge-nf-call-iptables=1" \
      | "${SUDO[@]}" tee /etc/sysctl.d/99-nemoclaw.conf >/dev/null
  fi
}

get_jetpack_version() {
  local release_line release revision l4t_version

  release_line="$(head -n1 /etc/nv_tegra_release 2>/dev/null || true)"
  [[ -n "$release_line" ]] || return 0

  release="$(printf '%s\n' "$release_line" | sed -n 's/^# R\([0-9][0-9]*\) (release).*/\1/p')"
  revision="$(printf '%s\n' "$release_line" | sed -n 's/^.*REVISION: \([0-9][0-9]*\)\..*$/\1/p')"
  l4t_version="${release}.${revision}"

  if [[ -z "$release" ]]; then
    info "Jetson detected but could not parse L4T release — skipping host setup" >&2
    return 0
  fi

  if ((release >= 39)); then
    # JP7 R39 does not need iptables / daemon.json changes, but k3s inside
    # the OpenShell gateway container still needs br_netfilter +
    # bridge-nf-call-{ip,ip6}tables=1 for ClusterIP service routing. Some
    # R39 kernel images ship with it already in place, so check first and
    # only apply when missing — avoids planting NemoClaw-owned drop-ins in
    # /etc/modules-load.d and /etc/sysctl.d on systems that don't need
    # them. See #2418.
    if bridge_netfilter_ready; then
      info "Jetson detected (L4T $l4t_version) — br_netfilter already configured; no host setup needed" >&2
    else
      info "Jetson detected (L4T $l4t_version) — loading br_netfilter (required by k3s inside the OpenShell gateway; see #2418)" >&2
      if ((EUID != 0)); then
        "${SUDO[@]}" true >/dev/null \
          || error "Sudo is required to load br_netfilter and write /etc/modules-load.d and /etc/sysctl.d drop-ins."
      fi
      apply_br_netfilter_setup_r39
      # Read the values back from /proc (not just "we set it to 1") so the
      # log is actual evidence that the apply path landed — useful when a
      # user is validating the fix on their own Jetson and needs to confirm
      # from log output alone that the runtime state is correct. The IPv6
      # leg is only included when the kernel exposes the sysctl, matching
      # what apply_br_netfilter_setup_r39 actually wrote.
      local v4 v6_summary
      v4="$(cat /proc/sys/net/bridge/bridge-nf-call-iptables 2>/dev/null || echo '?')"
      if [[ -f /proc/sys/net/bridge/bridge-nf-call-ip6tables ]]; then
        v6_summary=", bridge-nf-call-ip6tables=$(cat /proc/sys/net/bridge/bridge-nf-call-ip6tables 2>/dev/null || echo '?')"
      else
        v6_summary=" (ip6tables not exposed by this kernel; IPv4-only persistence)"
      fi
      info "br_netfilter runtime: bridge-nf-call-iptables=$v4$v6_summary — sandbox → ClusterIP routing (CoreDNS, services) is unblocked; no docker or k3s restart needed" >&2
      info "Reboot persistence: /etc/modules-load.d/nemoclaw.conf, /etc/sysctl.d/99-nemoclaw.conf" >&2
    fi
    return 0
  fi

  case "$l4t_version" in
    36.*)
      printf "%s" "jp6"
      ;;
    38.*)
      printf "%s" "jp7-r38"
      ;;
    *)
      info "Jetson detected (L4T $l4t_version) but version is not recognized — skipping host setup" >&2
      ;;
  esac
}

configure_jetson_host() {
  local jetpack_version="$1"

  if ((EUID != 0)); then
    info "Jetson host configuration requires sudo. You may be prompted for your password."
    "${SUDO[@]}" true >/dev/null || error "Sudo is required to apply Jetson host configuration."
  fi

  case "$jetpack_version" in
    jp6)
      "${SUDO[@]}" update-alternatives --set iptables /usr/sbin/iptables-legacy
      # Patch /etc/docker/daemon.json using Python to avoid generating invalid JSON.
      # The previous sed approach stripped the trailing comma from
      # "default-runtime": "nvidia", which produced malformed JSON when
      # "runtimes" was the next key. See: https://github.com/NVIDIA/NemoClaw/issues/1875
      "${SUDO[@]}" python3 --version >/dev/null 2>&1 \
        || error "python3 is required to patch /etc/docker/daemon.json but was not found on PATH"
      "${SUDO[@]}" python3 - /etc/docker/daemon.json <<'PYEOF'
import json, os, re, sys, tempfile
path = sys.argv[1]
try:
    with open(path) as f:
        cfg = json.load(f)
except FileNotFoundError:
    cfg = {}
except json.JSONDecodeError:
    # Attempt to repair the known missing-comma pattern introduced by the
    # previous sed-based approach before re-parsing. If repair fails, abort
    # rather than silently overwriting the file with an empty object.
    with open(path) as f:
        raw = f.read()
    # Insert missing comma after "default-runtime": "nvidia" when followed
    # by whitespace + a quoted key (next JSON member without comma separator).
    repaired = re.sub(
        r'("default-runtime"\s*:\s*"nvidia")([\s\n]+")',
        r'\1,\2',
        raw,
    )
    try:
        cfg = json.loads(repaired)
    except json.JSONDecodeError as e:
        sys.exit(f'daemon.json is malformed and could not be repaired automatically: {e}')
if not isinstance(cfg, dict):
    sys.exit('daemon.json must contain a top-level JSON object')
cfg.pop('iptables', None)
cfg.pop('bridge', None)
# Write atomically: dump to a temp file in the same directory, then replace.
# Copy permissions from the original file (or use 0644 if missing) so the
# replaced file is world-readable, matching the typical daemon.json mode.
dirname = os.path.dirname(os.path.abspath(path))
try:
    orig_mode = os.stat(path).st_mode & 0o777
except FileNotFoundError:
    orig_mode = 0o644
fd, tmp = tempfile.mkstemp(dir=dirname)
try:
    os.chmod(tmp, orig_mode)
    with os.fdopen(fd, 'w') as f:
        json.dump(cfg, f, indent=4)
        f.write('\n')
    os.replace(tmp, path)
    os.chmod(path, orig_mode)
except Exception:
    os.unlink(tmp)
    raise
PYEOF
      ;;
    jp7-r38)
      # JP7 R38 does not need iptables or Docker daemon.json changes.
      ;;
    *)
      error "Unsupported Jetson version: $jetpack_version"
      ;;
  esac

  apply_br_netfilter_setup

  if [[ "$jetpack_version" == "jp6" ]]; then
    "${SUDO[@]}" systemctl restart docker
  fi
}

main() {
  local jetpack_version
  jetpack_version="$(get_jetpack_version)"
  [[ -n "$jetpack_version" ]] || exit 0

  info "Jetson detected ($jetpack_version) — applying required host configuration"
  configure_jetson_host "$jetpack_version"
}

main "$@"
