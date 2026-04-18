// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
// Import from compiled dist/ so coverage is attributed correctly.
import { runOnboardingEntry } from "../../dist/lib/onboard-entry";

describe("runOnboardingEntry", () => {
  it("drives the shell, initialization, orchestration, and dashboard rendering", async () => {
    const releaseOnboardLock = vi.fn();
    const printDashboard = vi.fn();
    const applyShellState = vi.fn();
    const createOnboardRunContext = vi.fn((initializedRun) => ({
      driver: { session: { lastStepStarted: null } },
      fromDockerfile: initializedRun.fromDockerfile,
      session: initializedRun.session,
      updateSession: vi.fn(),
      startStep: vi.fn(),
      completeStep: vi.fn(),
      skipStep: vi.fn(),
      failStep: vi.fn(),
      completeSession: vi.fn(),
    }));
    const buildOrchestratorDeps = vi.fn(() => ({ kind: "deps" }));
    const runOnboardingOrchestratorMock = vi.fn(async () => ({
      sandboxName: "alpha",
      model: "gpt-5.4",
      provider: "openai-api",
      nimContainer: null,
      agent: null,
      policyResult: { kind: "complete", policyPresets: ["npm"] },
    }));
    const onceProcessExit = vi.fn();

    await runOnboardingEntry(
      {
        resume: true,
        agent: "hermes",
        acceptThirdPartySoftware: true,
      },
      {
        env: {},
        resolveShellState: () => ({
          nonInteractive: true,
          recreateSandbox: false,
          resume: true,
          dangerouslySkipPermissions: true,
          requestedFromDockerfile: "/tmp/Custom.Dockerfile",
        }),
        applyShellState,
        getDangerouslySkipPermissionsWarningLines: () => ["warn-1", "warn-2"],
        ensureUsageNoticeConsent: async () => true,
        validateRequestedProviderHint: vi.fn(),
        acquireOnboardLock: vi.fn(() => ({ acquired: true, lockFile: "/tmp/onboard.lock", stale: false })),
        buildOnboardLockCommand: vi.fn(() => "nemoclaw onboard --resume --non-interactive"),
        getOnboardLockConflictLines: vi.fn(() => []),
        releaseOnboardLock,
        clearGatewayEnv: vi.fn(),
        initializeOnboardRun: vi.fn(() => ({
          ok: true as const,
          value: {
            driver: { session: { lastStepStarted: null } },
            session: { mode: "non-interactive" },
            fromDockerfile: "/tmp/Custom.Dockerfile",
          },
        })) as never,
        getResumeConflicts: vi.fn(() => []),
        createOnboardRunContext: createOnboardRunContext as never,
        getOnboardBannerLines: () => ["", "  NemoClaw Onboarding", "  (resume mode)", "  ==================="],
        buildOrchestratorDeps: buildOrchestratorDeps as never,
        runOnboardingOrchestrator: runOnboardingOrchestratorMock as never,
        printDashboard,
        note: vi.fn(),
        log: vi.fn(),
        error: vi.fn(),
        exit: ((code: number) => {
          throw new Error(`exit:${code}`);
        }) as never,
        onceProcessExit,
      },
    );

    expect(applyShellState).toHaveBeenCalledWith({
      nonInteractive: true,
      recreateSandbox: false,
      resume: true,
      dangerouslySkipPermissions: true,
      requestedFromDockerfile: "/tmp/Custom.Dockerfile",
    });
    expect(createOnboardRunContext).toHaveBeenCalledTimes(1);
    expect(buildOrchestratorDeps).toHaveBeenCalledTimes(1);
    expect(runOnboardingOrchestratorMock).toHaveBeenCalledTimes(1);
    expect(printDashboard).toHaveBeenCalledWith("alpha", "gpt-5.4", "openai-api", null, null);
    expect(releaseOnboardLock).toHaveBeenCalledTimes(1);
    expect(onceProcessExit).toHaveBeenCalledTimes(2);
  });

  it("prints lock conflict guidance and exits before initialization", async () => {
    const error = vi.fn();
    await expect(
      runOnboardingEntry(
        {
          resume: false,
          agent: null,
          acceptThirdPartySoftware: false,
        },
        {
          env: {},
          resolveShellState: () => ({
            nonInteractive: false,
            recreateSandbox: false,
            resume: false,
            dangerouslySkipPermissions: false,
            requestedFromDockerfile: null,
          }),
          applyShellState: vi.fn(),
          getDangerouslySkipPermissionsWarningLines: () => [],
          ensureUsageNoticeConsent: async () => true,
          validateRequestedProviderHint: vi.fn(),
          acquireOnboardLock: vi.fn(() => ({ acquired: false, lockFile: "/tmp/onboard.lock", stale: false })),
          buildOnboardLockCommand: vi.fn(() => "nemoclaw onboard"),
          getOnboardLockConflictLines: vi.fn(() => ["line-1", "line-2"]),
          releaseOnboardLock: vi.fn(),
          clearGatewayEnv: vi.fn(),
          initializeOnboardRun: vi.fn(() => {
            throw new Error("should not initialize when lock is held");
          }) as never,
          createOnboardRunContext: vi.fn() as never,
          getOnboardBannerLines: () => [],
          buildOrchestratorDeps: vi.fn() as never,
          runOnboardingOrchestrator: vi.fn() as never,
          printDashboard: vi.fn(),
          note: vi.fn(),
          log: vi.fn(),
          error,
          exit: ((code: number) => {
            throw new Error(`exit:${code}`);
          }) as never,
          onceProcessExit: vi.fn(),
        },
      ),
    ).rejects.toThrow("exit:1");

    expect(error).toHaveBeenNthCalledWith(1, "line-1");
    expect(error).toHaveBeenNthCalledWith(2, "line-2");
  });
});
