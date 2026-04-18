// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
// Import from compiled dist/ so coverage is attributed correctly.
import {
  buildOnboardLockCommand,
  getDangerouslySkipPermissionsWarningLines,
  getOnboardBannerLines,
  getOnboardLockConflictLines,
  resolveOnboardShellState,
} from "../../dist/lib/onboard-shell";

describe("onboard-shell", () => {
  it("resolves shell state from opts and env", () => {
    expect(
      resolveOnboardShellState(
        { resume: true, fromDockerfile: null },
        {
          NEMOCLAW_NON_INTERACTIVE: "1",
          NEMOCLAW_RECREATE_SANDBOX: "1",
          NEMOCLAW_DANGEROUSLY_SKIP_PERMISSIONS: "1",
          NEMOCLAW_FROM_DOCKERFILE: "/tmp/Custom.Dockerfile",
        },
      ),
    ).toEqual({
      nonInteractive: true,
      recreateSandbox: true,
      resume: true,
      dangerouslySkipPermissions: true,
      requestedFromDockerfile: "/tmp/Custom.Dockerfile",
    });
  });

  it("formats the lock command line consistently", () => {
    expect(
      buildOnboardLockCommand({
        resume: true,
        nonInteractive: true,
        requestedFromDockerfile: "/tmp/Custom.Dockerfile",
      }),
    ).toBe('nemoclaw onboard --resume --non-interactive --from "/tmp/Custom.Dockerfile"');
  });

  it("renders banner and warning lines for the shell", () => {
    expect(getOnboardBannerLines({ nonInteractive: true, resume: true })).toEqual([
      "",
      "  NemoClaw Onboarding",
      "  (non-interactive mode)",
      "  (resume mode)",
      "  ===================",
    ]);
    expect(getDangerouslySkipPermissionsWarningLines()).toEqual([
      "",
      "  ⚠  --dangerously-skip-permissions: sandbox security restrictions disabled.",
      "     Network:    all known endpoints open (no method/path filtering)",
      "     Filesystem: sandbox home directory is writable",
      "     Use for development/testing only.",
      "",
    ]);
  });

  it("formats lock conflict guidance including holder metadata when present", () => {
    expect(
      getOnboardLockConflictLines({
        acquired: false,
        lockFile: "/tmp/onboard.lock",
        stale: false,
        holderPid: 4242,
        holderStartedAt: "2026-04-17T00:00:00.000Z",
      }),
    ).toEqual([
      "  Another NemoClaw onboarding run is already in progress.",
      "  Lock holder PID: 4242",
      "  Started: 2026-04-17T00:00:00.000Z",
      "  Wait for it to finish, or remove the stale lock if the previous run crashed:",
      '    rm -f "/tmp/onboard.lock"',
    ]);
  });
});
