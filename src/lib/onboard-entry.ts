// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  InitializeOnboardRunOptions,
  InitializeOnboardRunResult,
  InitializedOnboardRun,
} from "./onboard-bootstrap";
import type { OnboardOrchestratorDeps, OnboardOrchestratorResult } from "./onboard-orchestrator";
import type { OnboardRunContext } from "./onboard-run-context";
import type { OnboardShellInput, OnboardShellState } from "./onboard-shell";
import type { LockResult, Session } from "./onboard-session";

export interface RunOnboardingEntryDeps<
  TGpu = unknown,
  TAgent extends { name: string } = { name: string },
> {
  env: NodeJS.ProcessEnv;
  resolveShellState: (opts: OnboardShellInput, env: NodeJS.ProcessEnv) => OnboardShellState;
  applyShellState: (state: OnboardShellState) => void;
  getDangerouslySkipPermissionsWarningLines: () => string[];
  ensureUsageNoticeConsent: (options: {
    nonInteractive: boolean;
    acceptedByFlag: boolean;
    writeLine: (message?: string) => void;
  }) => Promise<boolean>;
  validateRequestedProviderHint: () => void;
  acquireOnboardLock: (command: string) => LockResult;
  buildOnboardLockCommand: (
    state: Pick<OnboardShellState, "resume" | "nonInteractive" | "requestedFromDockerfile">,
  ) => string;
  getOnboardLockConflictLines: (lockResult: LockResult) => string[];
  releaseOnboardLock: () => void;
  clearGatewayEnv: () => void;
  initializeOnboardRun: (
    options: InitializeOnboardRunOptions,
  ) => InitializeOnboardRunResult;
  getResumeConflicts?: (
    session: Session,
    shellState: OnboardShellState,
    requestedAgent: string | null,
  ) => NonNullable<InitializeOnboardRunOptions["getResumeConflicts"]> extends (
    ...args: never[]
  ) => infer T
    ? T
    : never;
  createOnboardRunContext: (initializedRun: InitializedOnboardRun) => OnboardRunContext;
  getOnboardBannerLines: (
    state: Pick<OnboardShellState, "nonInteractive" | "resume">,
  ) => string[];
  buildOrchestratorDeps: (
    runContext: OnboardRunContext,
    shellState: OnboardShellState,
    requestedAgent: string | null,
  ) => OnboardOrchestratorDeps<TGpu, TAgent>;
  runOnboardingOrchestrator: (
    runContext: OnboardRunContext,
    deps: OnboardOrchestratorDeps<TGpu, TAgent>,
  ) => Promise<OnboardOrchestratorResult<TAgent>>;
  printDashboard: (
    sandboxName: string,
    model: string,
    provider: string,
    nimContainer?: string | null,
    agent?: TAgent | null,
  ) => void;
  note: (message: string) => void;
  log: (message?: string) => void;
  error: (message?: string) => void;
  exit: (code: number) => never;
  onceProcessExit: (handler: (code: number) => void) => void;
}

export async function runOnboardingEntry<
  TGpu = unknown,
  TAgent extends { name: string } = { name: string },
>(
  opts: OnboardShellInput & {
    acceptThirdPartySoftware?: boolean;
    agent?: string | null;
  },
  deps: RunOnboardingEntryDeps<TGpu, TAgent>,
): Promise<void> {
  const shellState = deps.resolveShellState(opts, deps.env);
  deps.applyShellState(shellState);

  const { dangerouslySkipPermissions, requestedFromDockerfile, resume } = shellState;
  if (dangerouslySkipPermissions) {
    for (const line of deps.getDangerouslySkipPermissionsWarningLines()) {
      deps.error(line);
    }
  }

  deps.clearGatewayEnv();
  const noticeAccepted = await deps.ensureUsageNoticeConsent({
    nonInteractive: shellState.nonInteractive,
    acceptedByFlag: opts.acceptThirdPartySoftware === true,
    writeLine: deps.error,
  });
  if (!noticeAccepted) {
    deps.exit(1);
  }

  // Validate NEMOCLAW_PROVIDER early so invalid values fail before preflight.
  deps.validateRequestedProviderHint();

  const lockResult = deps.acquireOnboardLock(
    deps.buildOnboardLockCommand({
      resume,
      nonInteractive: shellState.nonInteractive,
      requestedFromDockerfile,
    }),
  );
  if (!lockResult.acquired) {
    for (const line of deps.getOnboardLockConflictLines(lockResult)) {
      deps.error(line);
    }
    deps.exit(1);
  }

  let lockReleased = false;
  const releaseOnboardLock = () => {
    if (lockReleased) return;
    lockReleased = true;
    deps.releaseOnboardLock();
  };
  deps.onceProcessExit(releaseOnboardLock);

  try {
    const initializedRun = deps.initializeOnboardRun({
      resume,
      mode: shellState.nonInteractive ? "non-interactive" : "interactive",
      requestedFromDockerfile,
      requestedAgent: opts.agent || null,
      getResumeConflicts: deps.getResumeConflicts
        ? (session) => deps.getResumeConflicts!(session, shellState, opts.agent || null)
        : undefined,
    });
    if (!initializedRun.ok) {
      for (const line of initializedRun.lines) {
        deps.error(line);
      }
      deps.exit(1);
    }

    const runContext = deps.createOnboardRunContext(initializedRun.value);
    let completed = false;
    deps.onceProcessExit((code) => {
      if (!completed && code !== 0) {
        const failedStep = runContext.driver.session?.lastStepStarted;
        if (failedStep) {
          runContext.failStep(failedStep, "Onboarding exited before the step completed.");
        }
      }
    });

    for (const line of deps.getOnboardBannerLines({
      nonInteractive: shellState.nonInteractive,
      resume,
    })) {
      if (line.length === 0) {
        deps.log("");
      } else if (line.startsWith("  (")) {
        deps.note(line);
      } else {
        deps.log(line);
      }
    }

    const orchestrationResult = await deps.runOnboardingOrchestrator(
      runContext,
      deps.buildOrchestratorDeps(runContext, shellState, opts.agent || null),
    );
    if (orchestrationResult.policyResult.kind === "sandbox_not_ready") {
      deps.error(`\n${orchestrationResult.policyResult.message}`);
      deps.exit(1);
    }

    completed = true;
    deps.printDashboard(
      orchestrationResult.sandboxName,
      orchestrationResult.model,
      orchestrationResult.provider,
      orchestrationResult.nimContainer,
      orchestrationResult.agent,
    );
  } finally {
    releaseOnboardLock();
  }
}
