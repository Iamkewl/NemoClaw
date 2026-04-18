// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createInitialOnboardContext,
  transitionOnboardState,
  type OnboardFlowState,
  type OnboardRuntimeTarget,
} from "./onboard-fsm";
import { deriveOnboardFlowState } from "./onboard-flow-state";
import {
  applySessionComplete,
  applyStepComplete,
  applyStepFailed,
  createSession,
  normalizeSession,
  type Session,
} from "./onboard-session";
import type { WebSearchConfig } from "./web-search";

export interface InMemoryOnboardDriverOptions {
  mode?: Session["mode"];
  runtimeTarget?: OnboardRuntimeTarget;
  fromDockerfile?: string | null;
  requestedSandboxName?: string | null;
}

function sessionOverridesFromOptions(options: InMemoryOnboardDriverOptions): Partial<Session> {
  return {
    mode: options.mode,
    agent: options.runtimeTarget?.kind === "agent" ? options.runtimeTarget.agentName : null,
    metadata: {
      gatewayName: "nemoclaw",
      fromDockerfile: options.fromDockerfile ?? null,
    },
    sandboxName: options.requestedSandboxName ?? null,
  };
}

type ValidFailurePhase =
  | "preflight"
  | "gateway"
  | "provider_selection"
  | "inference"
  | "messaging"
  | "sandbox"
  | "runtime_setup"
  | "policies";

const VALID_FAILURE_PHASES = new Set<ValidFailurePhase>([
  "preflight",
  "gateway",
  "provider_selection",
  "inference",
  "messaging",
  "sandbox",
  "runtime_setup",
  "policies",
]);

function isValidFailurePhase(phase: string): phase is ValidFailurePhase {
  return VALID_FAILURE_PHASES.has(phase as ValidFailurePhase);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

export class InMemoryOnboardDriver {
  #session: Session;
  #state: OnboardFlowState;
  #requestedSandboxName: string | null;

  private constructor(session: Session, state: OnboardFlowState, requestedSandboxName: string | null) {
    this.#session = session;
    this.#state = state;
    this.#requestedSandboxName = requestedSandboxName;
  }

  static fresh(options: InMemoryOnboardDriverOptions = {}): InMemoryOnboardDriver {
    const session = createSession(sessionOverridesFromOptions(options));
    const state = deriveOnboardFlowState(session, {
      resume: false,
      requestedSandboxName: options.requestedSandboxName ?? null,
    });
    return new InMemoryOnboardDriver(session, state, options.requestedSandboxName ?? null);
  }

  static resume(session: Session, options: Pick<InMemoryOnboardDriverOptions, "requestedSandboxName"> = {}): InMemoryOnboardDriver {
    const state = deriveOnboardFlowState(session, {
      resume: true,
      requestedSandboxName: options.requestedSandboxName ?? session.sandboxName,
    });
    return new InMemoryOnboardDriver(
      session,
      state,
      options.requestedSandboxName ?? session.sandboxName,
    );
  }

  get session(): Session {
    const cloned = normalizeSession(JSON.parse(JSON.stringify(this.#session)));
    if (!cloned) {
      throw new Error("Failed to clone onboarding session");
    }
    return cloned;
  }

  get state(): OnboardFlowState {
    return deepFreeze(structuredClone(this.#state));
  }

  enterWorkflow(): this {
    if (this.#state.phase !== "boot") {
      return this;
    }
    this.#state = transitionOnboardState(this.#state, { type: "SESSION_READY" });
    return this;
  }

  finishPreflight(): this {
    applyStepComplete(this.#session, "preflight");
    if (this.#state.phase === "preflight") {
      this.#state = transitionOnboardState(this.#state, { type: "PREFLIGHT_PASSED" });
    } else {
      this.#state = deriveOnboardFlowState(this.#session, {
        resume: true,
        requestedSandboxName: this.#requestedSandboxName,
      });
    }
    return this;
  }

  finishGateway(): this {
    applyStepComplete(this.#session, "gateway");
    if (this.#state.phase === "gateway") {
      this.#state = transitionOnboardState(this.#state, { type: "SESSION_READY" });
    } else {
      this.#state = deriveOnboardFlowState(this.#session, {
        resume: true,
        requestedSandboxName: this.#requestedSandboxName,
      });
    }
    return this;
  }

  finishProviderSelection(selection: {
    provider: string;
    model: string;
    endpointUrl?: string | null;
    credentialEnv?: string | null;
    preferredInferenceApi?: string | null;
    nimContainer?: string | null;
  }): this {
    applyStepComplete(this.#session, "provider_selection", {
      provider: selection.provider,
      model: selection.model,
      endpointUrl: selection.endpointUrl ?? undefined,
      credentialEnv: selection.credentialEnv ?? undefined,
      preferredInferenceApi: selection.preferredInferenceApi ?? undefined,
      nimContainer: selection.nimContainer ?? undefined,
    });
    if (this.#state.phase === "provider_selection") {
      this.#state = transitionOnboardState(this.#state, {
        type: "PROVIDER_SELECTED",
        selection: {
          provider: selection.provider,
          model: selection.model,
          endpointUrl: selection.endpointUrl ?? null,
          credentialEnv: selection.credentialEnv ?? null,
          preferredInferenceApi: selection.preferredInferenceApi ?? null,
          nimContainer: selection.nimContainer ?? null,
        },
      });
    } else {
      this.#state = deriveOnboardFlowState(this.#session, {
        resume: true,
        requestedSandboxName: this.#requestedSandboxName,
      });
    }
    return this;
  }

  finishInference(): this {
    applyStepComplete(this.#session, "inference", {
      sandboxName: this.#session.sandboxName ?? undefined,
      provider: this.#session.provider ?? undefined,
      model: this.#session.model ?? undefined,
      nimContainer: this.#session.nimContainer ?? undefined,
    });
    if (this.#state.phase === "inference") {
      this.#state = transitionOnboardState(this.#state, { type: "INFERENCE_CONFIGURED" });
    } else {
      this.#state = deriveOnboardFlowState(this.#session, {
        resume: true,
        requestedSandboxName: this.#requestedSandboxName,
      });
    }
    return this;
  }

  finishMessaging(messagingChannels: string[]): this {
    const channels = [...messagingChannels];
    applyStepComplete(this.#session, "messaging", {
      sandboxName: this.#session.sandboxName ?? undefined,
      provider: this.#session.provider ?? undefined,
      model: this.#session.model ?? undefined,
      messagingChannels: channels,
    });
    if (this.#state.phase === "messaging") {
      this.#state = transitionOnboardState(this.#state, {
        type: "MESSAGING_CONFIGURED",
        messagingChannels: channels,
      });
    } else {
      this.#state = deriveOnboardFlowState(this.#session, {
        resume: true,
        requestedSandboxName: this.#requestedSandboxName,
      });
    }
    return this;
  }

  finishSandbox(sandboxName: string, webSearchConfig: WebSearchConfig | null = null): this {
    applyStepComplete(this.#session, "sandbox", {
      sandboxName,
      provider: this.#session.provider ?? undefined,
      model: this.#session.model ?? undefined,
      nimContainer: this.#session.nimContainer ?? undefined,
      webSearchConfig,
    });
    if (this.#state.phase === "sandbox") {
      this.#state = transitionOnboardState(this.#state, {
        type: "SANDBOX_READY",
        sandboxName,
        webSearchConfig,
      });
    } else {
      this.#state = deriveOnboardFlowState(this.#session, {
        resume: true,
        requestedSandboxName: this.#requestedSandboxName,
      });
    }
    return this;
  }

  finishRuntimeSetup(): this {
    const runtimeStep = this.#session.agent ? "agent_setup" : "openclaw";
    applyStepComplete(this.#session, runtimeStep, {
      sandboxName: this.#session.sandboxName ?? undefined,
      provider: this.#session.provider ?? undefined,
      model: this.#session.model ?? undefined,
    });
    if (this.#state.phase === "runtime_setup") {
      this.#state = transitionOnboardState(this.#state, { type: "RUNTIME_CONFIGURED" });
    } else {
      this.#state = deriveOnboardFlowState(this.#session, {
        resume: true,
        requestedSandboxName: this.#requestedSandboxName,
      });
    }
    return this;
  }

  finishPolicies(policyPresets: string[]): this {
    const presets = [...policyPresets];
    applyStepComplete(this.#session, "policies", {
      sandboxName: this.#session.sandboxName ?? undefined,
      provider: this.#session.provider ?? undefined,
      model: this.#session.model ?? undefined,
      policyPresets: presets,
    });
    applySessionComplete(this.#session, {
      sandboxName: this.#session.sandboxName ?? undefined,
      provider: this.#session.provider ?? undefined,
      model: this.#session.model ?? undefined,
      policyPresets: presets,
    });
    if (this.#state.phase === "policies") {
      this.#state = transitionOnboardState(this.#state, {
        type: "POLICIES_APPLIED",
        policyPresets: presets,
      });
    } else {
      this.#state = deriveOnboardFlowState(this.#session, {
        resume: true,
        requestedSandboxName: this.#requestedSandboxName,
      });
    }
    return this;
  }

  fail(message: string, code = "driver_failure"): this {
    const failurePhase = this.#state.phase === "boot" ? "preflight" : this.#state.phase;
    if (isValidFailurePhase(failurePhase)) {
      const failureStep =
        failurePhase === "runtime_setup"
          ? this.#session.agent
            ? "agent_setup"
            : "openclaw"
          : failurePhase;
      applyStepFailed(this.#session, failureStep, message);
      this.#state = deriveOnboardFlowState(this.#session, {
        resume: true,
        requestedSandboxName: this.#requestedSandboxName,
      });
      if (this.#state.phase === "failed") {
        this.#state = {
          ...this.#state,
          error: {
            code,
            message: this.#session.failure?.message ?? message,
            recoverable: this.#session.resumable,
          },
        };
      }
    }
    return this;
  }

  reloadForResume(): InMemoryOnboardDriver {
    return InMemoryOnboardDriver.resume(this.session, {
      requestedSandboxName: this.#requestedSandboxName,
    });
  }

  reset(): this {
    const session = createSession({
      ...sessionOverridesFromOptions({
        mode: this.#session.mode,
        runtimeTarget: this.#session.agent
          ? { kind: "agent", agentName: this.#session.agent }
          : { kind: "openclaw" },
        fromDockerfile: this.#session.metadata.fromDockerfile,
        requestedSandboxName: this.#requestedSandboxName,
      }),
      status: "in_progress",
      resumable: true,
    });
    this.#session = session;
    this.#state = createInitialOnboardStateFromSession(session, this.#requestedSandboxName);
    return this;
  }
}

function createInitialOnboardStateFromSession(
  session: Session,
  requestedSandboxName: string | null,
): OnboardFlowState {
  return {
    phase: "boot",
    ctx: createInitialOnboardContext({
      mode: session.mode,
      resume: false,
      runtimeTarget: session.agent
        ? { kind: "agent", agentName: session.agent }
        : { kind: "openclaw" },
      fromDockerfile: session.metadata.fromDockerfile,
      requestedSandboxName,
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
    }),
  };
}
