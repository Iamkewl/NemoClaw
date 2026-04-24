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

# Returns 0 when `br_netfilter` is loaded AND both bridge-nf-call-iptables
# and bridge-nf-call-ip6tables sysctls are already set to 1. Used so we
# can skip host-state changes on Jetson images that ship with this
# configured out of the box.
bridge_netfilter_ready() {
  [[ -f /proc/sys/net/bridge/bridge-nf-call-iptables ]] \
    && [[ -f /proc/sys/net/bridge/bridge-nf-call-ip6tables ]] \
    && [[ "$(cat /proc/sys/net/bridge/bridge-nf-call-iptables 2>/dev/null)" == "1" ]] \
    && [[ "$(cat /proc/sys/net/bridge/bridge-nf-call-ip6tables 2>/dev/null)" == "1" ]]
}

# Load br_netfilter and flip the bridge-nf-call-{ip,ip6}tables sysctls,
# then persist all three across reboots. Required for k3s (running inside
# the OpenShell gateway container) to NAT pod → ClusterIP traffic;
# without this the kube-proxy iptables rules are written but never
# matched for bridged pod traffic, so sandbox pods cannot reach CoreDNS.
# ip6tables is flipped alongside iptables to keep IPv4 and IPv6 cluster
# services consistent and match the manual workaround validated on #2418.
apply_br_netfilter_setup() {
  "${SUDO[@]}" modprobe br_netfilter
  "${SUDO[@]}" sysctl -w net.bridge.bridge-nf-call-iptables=1 >/dev/null
  "${SUDO[@]}" sysctl -w net.bridge.bridge-nf-call-ip6tables=1 >/dev/null

  # Persist across reboots
  echo "br_netfilter" | "${SUDO[@]}" tee /etc/modules-load.d/nemoclaw.conf >/dev/null
  {
    echo "net.bridge.bridge-nf-call-iptables=1"
    echo "net.bridge.bridge-nf-call-ip6tables=1"
  } | "${SUDO[@]}" tee /etc/sysctl.d/99-nemoclaw.conf >/dev/null
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
      apply_br_netfilter_setup
      # Read the values back from /proc (not just "we set it to 1") so the
      # log is actual evidence that the apply path landed — useful when a
      # user is validating the fix on their own Jetson and needs to confirm
      # from log output alone that the runtime state is correct.
      local v4 v6
      v4="$(cat /proc/sys/net/bridge/bridge-nf-call-iptables 2>/dev/null || echo '?')"
      v6="$(cat /proc/sys/net/bridge/bridge-nf-call-ip6tables 2>/dev/null || echo '?')"
      info "br_netfilter runtime: bridge-nf-call-iptables=$v4, bridge-nf-call-ip6tables=$v6 — sandbox → ClusterIP routing (CoreDNS, services) is unblocked; no docker or k3s restart needed" >&2
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
