// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

// Import from compiled dist/ so coverage is attributed correctly.
import {
  deriveOnboardFlowState,
  getEffectiveMessagingStepState,
  getResumeExecutablePhase,
  hasCompletedOnboardStep,
  hasReachedOnboardPhase,
} from "../../dist/lib/onboard-flow-state";
import { createSession } from "../../dist/lib/onboard-session";

describe("onboard-flow-state", () => {
  it("maps resumable checkpoints to the next canonical phase", () => {
    const checkpoints = [
      {
        name: "fresh session",
        setup: () => createSession(),
        expectedPhase: "preflight",
      },
      {
        name: "after preflight",
        setup: () => {
          const session = createSession();
          session.steps.preflight.status = "complete";
          return session;
        },
        expectedPhase: "gateway",
      },
      {
        name: "after gateway",
        setup: () => {
          const session = createSession();
          session.steps.preflight.status = "complete";
          session.steps.gateway.status = "complete";
          return session;
        },
        expectedPhase: "provider_selection",
      },
      {
        name: "after provider selection",
        setup: () => {
          const session = createSession({ provider: "openai-api", model: "gpt-5.4" });
          session.steps.preflight.status = "complete";
          session.steps.gateway.status = "complete";
          session.steps.provider_selection.status = "complete";
          return session;
        },
        expectedPhase: "inference",
      },
      {
        name: "after inference",
        setup: () => {
          const session = createSession({ provider: "openai-api", model: "gpt-5.4" });
          session.steps.preflight.status = "complete";
          session.steps.gateway.status = "complete";
          session.steps.provider_selection.status = "complete";
          session.steps.inference.status = "complete";
          return session;
        },
        expectedPhase: "messaging",
      },
      {
        name: "after messaging",
        setup: () => {
          const session = createSession({
            provider: "openai-api",
            model: "gpt-5.4",
            messagingChannels: ["telegram"],
          });
          session.steps.preflight.status = "complete";
          session.steps.gateway.status = "complete";
          session.steps.provider_selection.status = "complete";
          session.steps.inference.status = "complete";
          session.steps.messaging.status = "complete";
          return session;
        },
        expectedPhase: "sandbox",
      },
      {
        name: "after sandbox",
        setup: () => {
          const session = createSession({
            provider: "openai-api",
            model: "gpt-5.4",
            sandboxName: "alpha",
          });
          session.steps.preflight.status = "complete";
          session.steps.gateway.status = "complete";
          session.steps.provider_selection.status = "complete";
          session.steps.inference.status = "complete";
          session.steps.messaging.status = "complete";
          session.steps.sandbox.status = "complete";
          return session;
        },
        expectedPhase: "runtime_setup",
      },
      {
        name: "after runtime setup",
        setup: () => {
          const session = createSession({
            provider: "openai-api",
            model: "gpt-5.4",
            sandboxName: "alpha",
          });
          session.steps.preflight.status = "complete";
          session.steps.gateway.status = "complete";
          session.steps.provider_selection.status = "complete";
          session.steps.inference.status = "complete";
          session.steps.messaging.status = "complete";
          session.steps.sandbox.status = "complete";
          session.steps.runtime_setup.status = "complete";
          return session;
        },
        expectedPhase: "policies",
      },
    ] as const;

    for (const checkpoint of checkpoints) {
      const state = deriveOnboardFlowState(checkpoint.setup());
      expect(state.phase, checkpoint.name).toBe(checkpoint.expectedPhase);
    }
  });

  it("derives boot when no session exists", () => {
    const state = deriveOnboardFlowState(null, { requestedSandboxName: "alpha" });
    expect(state.phase).toBe("boot");
    expect(state.ctx.requestedSandboxName).toBe("alpha");
  });

  it("derives the next resumable phase from completed checkpoints", () => {
    const session = createSession({
      provider: "openai-api",
      model: "gpt-5.4",
      sandboxName: "alpha",
      messagingChannels: ["telegram"],
    });
    session.steps.preflight.status = "complete";
    session.steps.gateway.status = "complete";
    session.steps.provider_selection.status = "complete";
    session.steps.inference.status = "complete";
    session.steps.messaging.status = "complete";

    const state = deriveOnboardFlowState(session);
    expect(state.phase).toBe("sandbox");
    expect(state.ctx.provider).toBe("openai-api");
    expect(state.ctx.model).toBe("gpt-5.4");
    expect(state.ctx.messagingChannels).toEqual(["telegram"]);
  });

  it("treats sandbox-complete legacy sessions as having completed messaging", () => {
    const session = createSession({
      provider: "openai-api",
      model: "gpt-5.4",
      sandboxName: "alpha",
      messagingChannels: ["telegram"],
    });
    session.steps.preflight.status = "complete";
    session.steps.gateway.status = "complete";
    session.steps.provider_selection.status = "complete";
    session.steps.inference.status = "complete";
    session.steps.sandbox.status = "complete";

    const messaging = getEffectiveMessagingStepState(session);
    const state = deriveOnboardFlowState(session);

    expect(messaging.status).toBe("complete");
    expect(state.phase).toBe("runtime_setup");
    expect(state.ctx.sandboxName).toBe("alpha");
  });

  it("canonicalizes runtime-step failures to runtime_setup", () => {
    const session = createSession({
      status: "failed",
      resumable: true,
      sandboxName: "alpha",
      provider: "openai-api",
      model: "gpt-5.4",
      failure: {
        step: "openclaw",
        message: "gateway boot failed",
        recordedAt: "2026-04-17T00:00:00.000Z",
      },
    });
    session.steps.openclaw.status = "failed";

    const state = deriveOnboardFlowState(session);
    expect(state.phase).toBe("failed");
    if (state.phase !== "failed") {
      throw new Error("expected failed phase");
    }
    expect(state.failedFrom).toBe("runtime_setup");
    expect(state.error.code).toBe("persisted_runtime_setup_failure");
    expect(state.error.recoverable).toBe(true);
  });

  it("reports canonical phase progress and completed steps for resumable failures", () => {
    const session = createSession({
      status: "failed",
      resumable: true,
      provider: "openai-api",
      model: "gpt-5.4",
      sandboxName: "alpha",
      failure: {
        step: "sandbox",
        message: "sandbox creation failed",
        recordedAt: "2026-04-17T00:00:00.000Z",
      },
    });
    session.steps.preflight.status = "complete";
    session.steps.gateway.status = "complete";
    session.steps.provider_selection.status = "complete";
    session.steps.inference.status = "complete";
    session.steps.messaging.status = "complete";
    session.steps.sandbox.status = "failed";

    const state = deriveOnboardFlowState(session);
    expect(getResumeExecutablePhase(state)).toBe("sandbox");
    expect(hasReachedOnboardPhase(state, "messaging")).toBe(true);
    expect(hasReachedOnboardPhase(state, "runtime_setup")).toBe(false);
    expect(hasCompletedOnboardStep(state, "messaging")).toBe(true);
    expect(hasCompletedOnboardStep(state, "sandbox")).toBe(false);
  });

  it("treats legacy session.agent='openclaw' as the default runtime target", () => {
    const session = createSession({
      agent: "openclaw",
      sandboxName: "alpha",
      provider: "openai-api",
      model: "gpt-5.4",
      status: "complete",
      resumable: false,
    });
    session.steps.policies.status = "complete";

    const state = deriveOnboardFlowState(session);
    expect(state.phase).toBe("complete");
    expect(state.ctx.runtimeTarget).toEqual({ kind: "openclaw" });
  });

  it("keeps agent runtime targets and completed policy state", () => {
    const session = createSession({
      status: "complete",
      resumable: false,
      agent: "hermes",
      sandboxName: "alpha",
      provider: "nvidia-nim",
      model: "meta/llama-3.3-70b-instruct",
      messagingChannels: ["slack"],
      policyPresets: ["npm", "slack"],
    });
    session.steps.policies.status = "complete";

    const state = deriveOnboardFlowState(session);
    expect(state.phase).toBe("complete");
    expect(state.ctx.runtimeTarget).toEqual({ kind: "agent", agentName: "hermes" });
    expect(state.ctx.messagingChannels).toEqual(["slack"]);
    expect(state.ctx.policyPresets).toEqual(["npm", "slack"]);
  });
});
