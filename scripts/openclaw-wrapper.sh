#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

REAL_OPENCLAW="${REAL_OPENCLAW:-/usr/local/bin/openclaw-real}"

case "${1:-}" in
  configure)
    echo "Error: 'openclaw configure' cannot modify config inside the sandbox." >&2
    echo "The sandbox config is read-only (Landlock enforced) for security." >&2
    echo "" >&2
    echo "To change your configuration, exit the sandbox and run:" >&2
    echo "  nemoclaw onboard --resume" >&2
    echo "" >&2
    echo "This rebuilds the sandbox with your updated settings." >&2
    exit 1
    ;;
  agents)
    case "${2:-}" in
      add)
        echo "Error: 'openclaw agents add' cannot modify agent config inside a NemoClaw-managed sandbox." >&2
        echo "The sandbox config is read-only (Landlock enforced) for security." >&2
        echo "" >&2
        echo "Creating additional OpenClaw agents inside the sandbox is not currently supported." >&2
        echo "Exit the sandbox and use a host-side NemoClaw workflow instead." >&2
        exit 1
        ;;
    esac
    ;;
  agent)
    # Warn when --local is used — it bypasses gateway protections including
    # secret scanning, network policy, and inference auth. Ref: #1632
    for _arg in "$@"; do
      if [ "$_arg" = "--local" ]; then
        echo "[SECURITY] Warning: 'openclaw agent --local' bypasses the NemoClaw gateway." >&2
        echo "[SECURITY] Secret scanning, network policy, and inference auth are NOT enforced in local mode." >&2
        break
      fi
    done
    ;;
esac

exec "$REAL_OPENCLAW" "$@"
