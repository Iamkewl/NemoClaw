// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

export interface RemediationActionLike {
  title: string;
  reason: string;
  commands?: string[];
}

export interface ContainerRuntimeDeps {
  runCapture: (command: string, options?: { ignoreError?: boolean }) => string;
  inferContainerRuntime: (dockerInfo: string) => string;
}

export function getContainerRuntime(deps: ContainerRuntimeDeps): string {
  const info = deps.runCapture("docker info 2>/dev/null", { ignoreError: true });
  return deps.inferContainerRuntime(info);
}

export function printRemediationActions(
  actions: RemediationActionLike[] | null | undefined,
  errorWriter: (message?: string) => void = console.error,
): void {
  if (!Array.isArray(actions) || actions.length === 0) {
    return;
  }

  errorWriter("");
  errorWriter("  Suggested fix:");
  errorWriter("");
  for (const action of actions) {
    errorWriter(`  - ${action.title}: ${action.reason}`);
    for (const command of action.commands || []) {
      errorWriter(`    ${command}`);
    }
  }
}

export function getFutureShellPathHint(
  binDir: string,
  pathValue = process.env.PATH || "",
): string | null {
  if (String(pathValue).split(path.delimiter).includes(binDir)) {
    return null;
  }
  return `export PATH="${binDir}:$PATH"`;
}

export function getPortConflictServiceHints(
  platform = process.platform,
  launchAgentPlist = "",
): string[] {
  if (platform === "darwin") {
    return [
      "       # or, if it's a launchctl service (macOS):",
      "       launchctl list | grep -i claw   # columns: PID | ExitStatus | Label",
      `       launchctl unload ${launchAgentPlist}`,
      "       # or: launchctl bootout gui/$(id -u)/ai.openclaw.gateway",
    ];
  }
  return [
    "       # or, if it's a systemd service:",
    "       systemctl --user stop openclaw-gateway.service",
  ];
}
