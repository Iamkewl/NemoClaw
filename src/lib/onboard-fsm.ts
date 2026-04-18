// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WebSearchConfig } from "./web-search";

export const ONBOARD_VISIBLE_STEPS = [
  "preflight",
  "gateway",
  "provider_selection",
  "inference",
  "messaging",
  "sandbox",
  "runtime_setup",
  "policies",
] as const;

export const ONBOARD_RUNTIME_STEP_ALIASES = ["openclaw", "agent_setup"] as const;

export const ONBOARD_SESSION_STEPS = [
  ...ONBOARD_VISIBLE_STEPS,
  ...ONBOARD_RUNTIME_STEP_ALIASES,
] as const;

export type OnboardVisibleStep = (typeof ONBOARD_VISIBLE_STEPS)[number];
export type OnboardRuntimeStepAlias = (typeof ONBOARD_RUNTIME_STEP_ALIASES)[number];
export type OnboardStepName = (typeof ONBOARD_SESSION_STEPS)[number];

export type OnboardMode = "interactive" | "non-interactive";
export type OnboardRunStatus = "in_progress" | "complete" | "failed";
export type OnboardStepStatus = "pending" | "in_progress" | "complete" | "failed" | "skipped";

export interface OnboardStepMeta {
  number: number;
  title: string;
}

export const ONBOARD_STEP_META = {
  preflight: { number: 1, title: "Preflight checks" },
  gateway: { number: 2, title: "Starting OpenShell gateway" },
  provider_selection: { number: 3, title: "Configuring inference (NIM)" },
  inference: { number: 4, title: "Setting up inference provider" },
  messaging: { number: 5, title: "Messaging channels" },
  sandbox: { number: 6, title: "Creating sandbox" },
  runtime_setup: { number: 7, title: "Setting up runtime inside sandbox" },
  policies: { number: 8, title: "Policy presets" },
} as const satisfies Record<OnboardVisibleStep, OnboardStepMeta>;

export const ONBOARD_STEP_ALIAS_TO_VISIBLE = {
  openclaw: "runtime_setup",
  agent_setup: "runtime_setup",
} as const satisfies Record<OnboardRuntimeStepAlias, OnboardVisibleStep>;

export interface OnboardStepState {
  status: OnboardStepStatus;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

export type OnboardStepLedger = {
  [K in OnboardStepName]: OnboardStepState;
};

export interface OnboardRuntimeTargetOpenClaw {
  kind: "openclaw";
}

export interface OnboardRuntimeTargetAgent {
  kind: "agent";
  agentName: string;
}

export type OnboardRuntimeTarget = OnboardRuntimeTargetOpenClaw | OnboardRuntimeTargetAgent;

export interface OnboardBaseContext {
  mode: OnboardMode;
  resume: boolean;
  runtimeTarget: OnboardRuntimeTarget;
  fromDockerfile: string | null;
  requestedSandboxName: string | null;
  sandboxName: string | null;
  provider: string | null;
  model: string | null;
  endpointUrl: string | null;
  credentialEnv: string | null;
  preferredInferenceApi: string | null;
  nimContainer: string | null;
  webSearchConfig: WebSearchConfig | null;
  messagingChannels: readonly string[];
  policyPresets: readonly string[];
}

export interface OnboardSelectionContext extends OnboardBaseContext {
  provider: string;
  model: string;
}

export interface OnboardSandboxContext extends OnboardSelectionContext {
  sandboxName: string;
}

export interface OnboardPoliciesContext extends OnboardSandboxContext {
  policyPresets: readonly string[];
}

export type OnboardFlowState =
  | { phase: "boot"; ctx: OnboardBaseContext }
  | { phase: "preflight"; ctx: OnboardBaseContext }
  | { phase: "gateway"; ctx: OnboardBaseContext }
  | { phase: "provider_selection"; ctx: OnboardBaseContext }
  | { phase: "inference"; ctx: OnboardSelectionContext }
  | { phase: "messaging"; ctx: OnboardSelectionContext }
  | { phase: "sandbox"; ctx: OnboardSelectionContext }
  | { phase: "runtime_setup"; ctx: OnboardSandboxContext }
  | { phase: "policies"; ctx: OnboardSandboxContext }
  | { phase: "complete"; ctx: OnboardPoliciesContext }
  | {
      phase: "failed";
      ctx: OnboardBaseContext;
      failedFrom: Exclude<OnboardFlowState["phase"], "boot" | "failed" | "complete">;
      error: {
        code: string;
        message: string;
        recoverable: boolean;
      };
    };

export type OnboardFlowEvent =
  | { type: "SESSION_READY" }
  | { type: "PREFLIGHT_PASSED" }
  | {
      type: "PROVIDER_SELECTED";
      selection: {
        provider: string;
        model: string;
        endpointUrl: string | null;
        credentialEnv: string | null;
        preferredInferenceApi: string | null;
        nimContainer: string | null;
      };
    }
  | { type: "INFERENCE_CONFIGURED" }
  | { type: "MESSAGING_CONFIGURED"; messagingChannels: readonly string[] }
  | {
      type: "SANDBOX_READY";
      sandboxName: string;
      webSearchConfig: WebSearchConfig | null;
    }
  | { type: "RUNTIME_CONFIGURED" }
  | { type: "POLICIES_APPLIED"; policyPresets: readonly string[] }
  | {
      type: "FAIL";
      error: {
        code: string;
        message: string;
        recoverable: boolean;
      };
    }
  | { type: "RESET"; ctx: OnboardBaseContext };

const ONBOARD_NEXT_PHASE = {
  boot: { SESSION_READY: "preflight" },
  preflight: { PREFLIGHT_PASSED: "gateway", FAIL: "failed" },
  gateway: { SESSION_READY: "provider_selection", FAIL: "failed" },
  provider_selection: { PROVIDER_SELECTED: "inference", FAIL: "failed" },
  inference: { INFERENCE_CONFIGURED: "messaging", FAIL: "failed" },
  messaging: { MESSAGING_CONFIGURED: "sandbox", FAIL: "failed" },
  sandbox: { SANDBOX_READY: "runtime_setup", FAIL: "failed" },
  runtime_setup: { RUNTIME_CONFIGURED: "policies", FAIL: "failed" },
  policies: { POLICIES_APPLIED: "complete", FAIL: "failed" },
  complete: { RESET: "boot" },
  failed: { RESET: "boot" },
} as const;

type OnboardPhase = keyof typeof ONBOARD_NEXT_PHASE;
type OnboardStateByPhase = {
  [P in OnboardFlowState["phase"]]: Extract<OnboardFlowState, { phase: P }>;
};

type StateOf<P extends OnboardPhase> = OnboardStateByPhase[P];
type EventOf<T extends OnboardFlowEvent["type"]> = Extract<OnboardFlowEvent, { type: T }>;
type AllowedEvent<P extends OnboardPhase> = keyof (typeof ONBOARD_NEXT_PHASE)[P] & OnboardFlowEvent["type"];
type NextPhase<P extends OnboardPhase, E extends AllowedEvent<P>> =
  ((typeof ONBOARD_NEXT_PHASE)[P][E]) & OnboardPhase;

type OnboardTransitionTable = {
  [P in OnboardPhase]: {
    [E in AllowedEvent<P>]: (
      state: StateOf<P>,
      event: EventOf<E>,
    ) => StateOf<NextPhase<P, E>>;
  };
};


export function createEmptyStepLedger(): OnboardStepLedger {
  const emptyStep = (): OnboardStepState => ({
    status: "pending",
    startedAt: null,
    completedAt: null,
    error: null,
  });
  return {
    preflight: emptyStep(),
    gateway: emptyStep(),
    provider_selection: emptyStep(),
    inference: emptyStep(),
    messaging: emptyStep(),
    sandbox: emptyStep(),
    runtime_setup: emptyStep(),
    policies: emptyStep(),
    openclaw: emptyStep(),
    agent_setup: emptyStep(),
  };
}

export function isOnboardStepName(value: unknown): value is OnboardStepName {
  return typeof value === "string" && (ONBOARD_SESSION_STEPS as readonly string[]).includes(value);
}

export function toVisibleStepName(stepName: OnboardStepName): OnboardVisibleStep {
  return stepName in ONBOARD_STEP_ALIAS_TO_VISIBLE
    ? ONBOARD_STEP_ALIAS_TO_VISIBLE[stepName as OnboardRuntimeStepAlias]
    : (stepName as OnboardVisibleStep);
}

export function createInitialOnboardContext(
  overrides: Partial<OnboardBaseContext> = {},
): OnboardBaseContext {
  return {
    mode: overrides.mode ?? "interactive",
    resume: overrides.resume ?? false,
    runtimeTarget: overrides.runtimeTarget ?? { kind: "openclaw" },
    fromDockerfile: overrides.fromDockerfile ?? null,
    requestedSandboxName: overrides.requestedSandboxName ?? null,
    sandboxName: overrides.sandboxName ?? null,
    provider: overrides.provider ?? null,
    model: overrides.model ?? null,
    endpointUrl: overrides.endpointUrl ?? null,
    credentialEnv: overrides.credentialEnv ?? null,
    preferredInferenceApi: overrides.preferredInferenceApi ?? null,
    nimContainer: overrides.nimContainer ?? null,
    webSearchConfig: overrides.webSearchConfig ?? null,
    messagingChannels: overrides.messagingChannels ?? [],
    policyPresets: overrides.policyPresets ?? [],
  };
}

export function createInitialOnboardState(
  ctx: Partial<OnboardBaseContext> = {},
): Extract<OnboardFlowState, { phase: "boot" }> {
  return {
    phase: "boot",
    ctx: createInitialOnboardContext(ctx),
  };
}

function failFrom<P extends Exclude<OnboardPhase, "boot" | "complete" | "failed">>(phase: P) {
  return (state: StateOf<P>, event: EventOf<"FAIL">): StateOf<"failed"> => ({
    phase: "failed",
    ctx: state.ctx,
    failedFrom: phase,
    error: event.error,
  });
}

const ONBOARD_TRANSITIONS = {
  boot: {
    SESSION_READY: (state) => ({ phase: "preflight", ctx: state.ctx }),
  },
  preflight: {
    PREFLIGHT_PASSED: (state) => ({ phase: "gateway", ctx: state.ctx }),
    FAIL: failFrom("preflight"),
  },
  gateway: {
    SESSION_READY: (state) => ({ phase: "provider_selection", ctx: state.ctx }),
    FAIL: failFrom("gateway"),
  },
  provider_selection: {
    PROVIDER_SELECTED: (state, event) => ({
      phase: "inference",
      ctx: {
        ...state.ctx,
        provider: event.selection.provider,
        model: event.selection.model,
        endpointUrl: event.selection.endpointUrl,
        credentialEnv: event.selection.credentialEnv,
        preferredInferenceApi: event.selection.preferredInferenceApi,
        nimContainer: event.selection.nimContainer,
      },
    }),
    FAIL: failFrom("provider_selection"),
  },
  inference: {
    INFERENCE_CONFIGURED: (state) => ({ phase: "messaging", ctx: state.ctx }),
    FAIL: failFrom("inference"),
  },
  messaging: {
    MESSAGING_CONFIGURED: (state, event) => ({
      phase: "sandbox",
      ctx: { ...state.ctx, messagingChannels: [...event.messagingChannels] },
    }),
    FAIL: failFrom("messaging"),
  },
  sandbox: {
    SANDBOX_READY: (state, event) => ({
      phase: "runtime_setup",
      ctx: {
        ...state.ctx,
        sandboxName: event.sandboxName,
        webSearchConfig: event.webSearchConfig,
      },
    }),
    FAIL: failFrom("sandbox"),
  },
  runtime_setup: {
    RUNTIME_CONFIGURED: (state) => ({ phase: "policies", ctx: state.ctx }),
    FAIL: failFrom("runtime_setup"),
  },
  policies: {
    POLICIES_APPLIED: (state, event) => ({
      phase: "complete",
      ctx: { ...state.ctx, policyPresets: [...event.policyPresets] },
    }),
    FAIL: failFrom("policies"),
  },
  complete: {
    RESET: (_state, event) => ({ phase: "boot", ctx: event.ctx }),
  },
  failed: {
    RESET: (_state, event) => ({ phase: "boot", ctx: event.ctx }),
  },
} satisfies OnboardTransitionTable;

export function transitionOnboardState(
  state: StateOf<"boot">,
  event: EventOf<"SESSION_READY">,
): StateOf<"preflight">;
export function transitionOnboardState(
  state: StateOf<"preflight">,
  event: EventOf<"PREFLIGHT_PASSED">,
): StateOf<"gateway">;
export function transitionOnboardState(
  state: StateOf<"preflight">,
  event: EventOf<"FAIL">,
): StateOf<"failed">;
export function transitionOnboardState(
  state: StateOf<"gateway">,
  event: EventOf<"SESSION_READY">,
): StateOf<"provider_selection">;
export function transitionOnboardState(
  state: StateOf<"gateway">,
  event: EventOf<"FAIL">,
): StateOf<"failed">;
export function transitionOnboardState(
  state: StateOf<"provider_selection">,
  event: EventOf<"PROVIDER_SELECTED">,
): StateOf<"inference">;
export function transitionOnboardState(
  state: StateOf<"provider_selection">,
  event: EventOf<"FAIL">,
): StateOf<"failed">;
export function transitionOnboardState(
  state: StateOf<"inference">,
  event: EventOf<"INFERENCE_CONFIGURED">,
): StateOf<"messaging">;
export function transitionOnboardState(
  state: StateOf<"inference">,
  event: EventOf<"FAIL">,
): StateOf<"failed">;
export function transitionOnboardState(
  state: StateOf<"messaging">,
  event: EventOf<"MESSAGING_CONFIGURED">,
): StateOf<"sandbox">;
export function transitionOnboardState(
  state: StateOf<"messaging">,
  event: EventOf<"FAIL">,
): StateOf<"failed">;
export function transitionOnboardState(
  state: StateOf<"sandbox">,
  event: EventOf<"SANDBOX_READY">,
): StateOf<"runtime_setup">;
export function transitionOnboardState(
  state: StateOf<"sandbox">,
  event: EventOf<"FAIL">,
): StateOf<"failed">;
export function transitionOnboardState(
  state: StateOf<"runtime_setup">,
  event: EventOf<"RUNTIME_CONFIGURED">,
): StateOf<"policies">;
export function transitionOnboardState(
  state: StateOf<"runtime_setup">,
  event: EventOf<"FAIL">,
): StateOf<"failed">;
export function transitionOnboardState(
  state: StateOf<"policies">,
  event: EventOf<"POLICIES_APPLIED">,
): StateOf<"complete">;
export function transitionOnboardState(
  state: StateOf<"policies">,
  event: EventOf<"FAIL">,
): StateOf<"failed">;
export function transitionOnboardState(
  state: StateOf<"complete">,
  event: EventOf<"RESET">,
): StateOf<"boot">;
export function transitionOnboardState(
  state: StateOf<"failed">,
  event: EventOf<"RESET">,
): StateOf<"boot">;
export function transitionOnboardState(
  state: OnboardFlowState,
  event: OnboardFlowEvent,
): OnboardFlowState {
  const phaseTransitions = ONBOARD_TRANSITIONS[state.phase] as Record<
    string,
    (current: OnboardFlowState, nextEvent: OnboardFlowEvent) => OnboardFlowState
  >;
  const handler = phaseTransitions[event.type];
  return handler(state, event);
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}
