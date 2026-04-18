// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createInitialOnboardContext,
  createInitialOnboardState,
  type OnboardBaseContext,
  type OnboardFlowState,
  type OnboardStepState,
  type OnboardVisibleStep,
} from "./onboard-fsm";
import type { Session } from "./onboard-session";

function buildContext(
  session: Session,
  options: { resume?: boolean; requestedSandboxName?: string | null } = {},
): OnboardBaseContext {
  return createInitialOnboardContext({
    mode: session.mode,
    resume: options.resume ?? true,
    runtimeTarget:
      session.agent && session.agent !== "openclaw"
        ? { kind: "agent", agentName: session.agent }
        : { kind: "openclaw" },
    fromDockerfile: session.metadata.fromDockerfile,
    requestedSandboxName: options.requestedSandboxName ?? session.sandboxName,
    sandboxName: session.sandboxName,
    provider: session.provider,
    model: session.model,
    endpointUrl: session.endpointUrl,
    credentialEnv: session.credentialEnv,
    preferredInferenceApi: session.preferredInferenceApi,
    nimContainer: session.nimContainer,
    webSearchConfig: session.webSearchConfig,
    messagingChannels: session.messagingChannels ?? [],
    policyPresets: session.policyPresets ?? [],
  });
}

const PHASE_ORDER = [
  "boot",
  "preflight",
  "gateway",
  "provider_selection",
  "inference",
  "messaging",
  "sandbox",
  "runtime_setup",
  "policies",
  "complete",
] as const satisfies readonly OnboardFlowState["phase"][];

const STEP_TO_NEXT_PHASE = {
  preflight: "gateway",
  gateway: "provider_selection",
  provider_selection: "inference",
  inference: "messaging",
  messaging: "sandbox",
  sandbox: "runtime_setup",
  runtime_setup: "policies",
  policies: "complete",
} as const satisfies Record<OnboardVisibleStep, (typeof PHASE_ORDER)[number]>;

function cloneStepState(step: OnboardStepState): OnboardStepState {
  return {
    status: step.status,
    startedAt: step.startedAt,
    completedAt: step.completedAt,
    error: step.error,
  };
}

export function getEffectiveMessagingStepState(session: Session): OnboardStepState {
  const recorded = session.steps.messaging;
  if (recorded.status !== "pending") {
    return cloneStepState(recorded);
  }

  const sandboxState = session.steps.sandbox;
  if (
    sandboxState.status === "in_progress" ||
    sandboxState.status === "complete" ||
    sandboxState.status === "failed" ||
    Array.isArray(session.messagingChannels)
  ) {
    return {
      status: "complete",
      startedAt: sandboxState.startedAt,
      completedAt: sandboxState.startedAt,
      error: null,
    };
  }

  return cloneStepState(recorded);
}

function getFailureOrigin(session: Session):
  | Exclude<OnboardFlowState["phase"], "boot" | "complete" | "failed">
  | null {
  const step = session.failure?.step ?? session.lastStepStarted;
  if (step === "openclaw" || step === "agent_setup" || step === "runtime_setup") {
    return "runtime_setup";
  }
  if (
    step === "preflight" ||
    step === "gateway" ||
    step === "provider_selection" ||
    step === "inference" ||
    step === "messaging" ||
    step === "sandbox" ||
    step === "policies"
  ) {
    return step;
  }
  return null;
}

export function getResumeExecutablePhase(state: OnboardFlowState): (typeof PHASE_ORDER)[number] {
  return state.phase === "failed" ? state.failedFrom : state.phase;
}

export function hasReachedOnboardPhase(
  state: OnboardFlowState,
  phase: (typeof PHASE_ORDER)[number],
): boolean {
  return (
    PHASE_ORDER.indexOf(getResumeExecutablePhase(state)) >= PHASE_ORDER.indexOf(phase)
  );
}

export function hasCompletedOnboardStep(
  state: OnboardFlowState,
  step: OnboardVisibleStep,
): boolean {
  return hasReachedOnboardPhase(state, STEP_TO_NEXT_PHASE[step]);
}

export function deriveOnboardFlowState(
  session: Session | null,
  options: { resume?: boolean; requestedSandboxName?: string | null } = {},
): OnboardFlowState {
  if (!session) {
    return createInitialOnboardState({
      resume: options.resume ?? false,
      requestedSandboxName: options.requestedSandboxName ?? null,
    });
  }

  const ctx = buildContext(session, options);
  const messagingState = getEffectiveMessagingStepState(session);

  if (session.status === "complete" || session.steps.policies.status === "complete") {
    return { phase: "complete", ctx: { ...ctx, sandboxName: session.sandboxName ?? "", provider: session.provider ?? "", model: session.model ?? "", policyPresets: session.policyPresets ?? [] } };
  }

  if (session.status === "failed") {
    const failedFrom = getFailureOrigin(session) ?? "preflight";
    return {
      phase: "failed",
      ctx,
      failedFrom,
      error: {
        code: `persisted_${failedFrom}_failure`,
        message: session.failure?.message ?? "Onboarding failed.",
        recoverable: session.resumable,
      },
    };
  }

  if (session.steps.runtime_setup.status === "complete") {
    return {
      phase: "policies",
      ctx: {
        ...ctx,
        sandboxName: session.sandboxName ?? "",
        provider: session.provider ?? "",
        model: session.model ?? "",
      },
    };
  }

  if (session.steps.sandbox.status === "complete") {
    return {
      phase: "runtime_setup",
      ctx: {
        ...ctx,
        sandboxName: session.sandboxName ?? "",
        provider: session.provider ?? "",
        model: session.model ?? "",
      },
    };
  }

  if (messagingState.status === "complete") {
    return {
      phase: "sandbox",
      ctx: {
        ...ctx,
        provider: session.provider ?? "",
        model: session.model ?? "",
      },
    };
  }

  if (session.steps.inference.status === "complete") {
    return {
      phase: "messaging",
      ctx: {
        ...ctx,
        provider: session.provider ?? "",
        model: session.model ?? "",
      },
    };
  }

  if (session.steps.provider_selection.status === "complete") {
    return {
      phase: "inference",
      ctx: {
        ...ctx,
        provider: session.provider ?? "",
        model: session.model ?? "",
      },
    };
  }

  if (session.steps.gateway.status === "complete") {
    return { phase: "provider_selection", ctx };
  }

  if (session.steps.preflight.status === "complete") {
    return { phase: "gateway", ctx };
  }

  return { phase: "preflight", ctx };
}
