// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { LockResult } from "./onboard-session";

export interface OnboardShellInput {
  nonInteractive?: boolean;
  recreateSandbox?: boolean;
  resume?: boolean;
  dangerouslySkipPermissions?: boolean;
  fromDockerfile?: string | null;
}

export interface OnboardShellState {
  nonInteractive: boolean;
  recreateSandbox: boolean;
  resume: boolean;
  dangerouslySkipPermissions: boolean;
  requestedFromDockerfile: string | null;
}

export function resolveOnboardShellState(
  opts: OnboardShellInput = {},
  env: NodeJS.ProcessEnv = process.env,
): OnboardShellState {
  const nonInteractive =
    opts.nonInteractive === true || env.NEMOCLAW_NON_INTERACTIVE === "1";
  return {
    nonInteractive,
    recreateSandbox:
      opts.recreateSandbox === true || env.NEMOCLAW_RECREATE_SANDBOX === "1",
    resume: opts.resume === true,
    dangerouslySkipPermissions:
      opts.dangerouslySkipPermissions === true ||
      env.NEMOCLAW_DANGEROUSLY_SKIP_PERMISSIONS === "1",
    requestedFromDockerfile:
      opts.fromDockerfile || (nonInteractive ? env.NEMOCLAW_FROM_DOCKERFILE || null : null),
  };
}

export function buildOnboardLockCommand(state: Pick<OnboardShellState, "resume" | "nonInteractive" | "requestedFromDockerfile">): string {
  const fromArg = state.requestedFromDockerfile
    ? ` --from ${JSON.stringify(state.requestedFromDockerfile)}`
    : "";
  return `nemoclaw onboard${state.resume ? " --resume" : ""}${state.nonInteractive ? " --non-interactive" : ""}${fromArg}`;
}

export function getOnboardBannerLines(
  state: Pick<OnboardShellState, "nonInteractive" | "resume">,
): string[] {
  return [
    "",
    "  NemoClaw Onboarding",
    ...(state.nonInteractive ? ["  (non-interactive mode)"] : []),
    ...(state.resume ? ["  (resume mode)"] : []),
    "  ===================",
  ];
}

export function getDangerouslySkipPermissionsWarningLines(): string[] {
  return [
    "",
    "  ⚠  --dangerously-skip-permissions: sandbox security restrictions disabled.",
    "     Network:    all known endpoints open (no method/path filtering)",
    "     Filesystem: sandbox home directory is writable",
    "     Use for development/testing only.",
    "",
  ];
}

export function getOnboardLockConflictLines(lockResult: LockResult): string[] {
  const lines = ["  Another NemoClaw onboarding run is already in progress."];
  if (lockResult.holderPid) {
    lines.push(`  Lock holder PID: ${lockResult.holderPid}`);
  }
  if (lockResult.holderStartedAt) {
    lines.push(`  Started: ${lockResult.holderStartedAt}`);
  }
  lines.push(
    "  Wait for it to finish, or remove the stale lock if the previous run crashed:",
    `    rm -f \"${lockResult.lockFile}\"`,
  );
  return lines;
}
