// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, expectTypeOf, it } from "vitest";

// Import from compiled dist/ so coverage is attributed correctly.
import {
  createEmptyStepLedger,
  createInitialOnboardState,
  isOnboardStepName,
  ONBOARD_STEP_ALIAS_TO_VISIBLE,
  ONBOARD_STEP_META,
  transitionOnboardState,
} from "../../dist/lib/onboard-fsm";

describe("onboard-fsm", () => {
  it("defines numbered visible step metadata for all user-facing steps", () => {
    expect(ONBOARD_STEP_META.preflight.number).toBe(1);
    expect(ONBOARD_STEP_META.messaging.number).toBe(5);
    expect(ONBOARD_STEP_META.runtime_setup.number).toBe(7);
    expect(ONBOARD_STEP_META.policies.number).toBe(8);
  });

  it("builds a step ledger that includes canonical and legacy runtime step names", () => {
    const ledger = createEmptyStepLedger();

    expect(Object.keys(ledger)).toEqual([
      "preflight",
      "gateway",
      "provider_selection",
      "inference",
      "messaging",
      "sandbox",
      "runtime_setup",
      "policies",
      "openclaw",
      "agent_setup",
    ]);
    expect(ledger.messaging.status).toBe("pending");
    expect(ledger.runtime_setup.status).toBe("pending");
    expect(ledger.openclaw.status).toBe("pending");
    expect(ledger.agent_setup.status).toBe("pending");
  });

  it("maps legacy runtime steps to the canonical visible step", () => {
    expect(ONBOARD_STEP_ALIAS_TO_VISIBLE.openclaw).toBe("runtime_setup");
    expect(ONBOARD_STEP_ALIAS_TO_VISIBLE.agent_setup).toBe("runtime_setup");
  });

  it("recognizes valid step names including the new messaging/runtime_setup pair", () => {
    expect(isOnboardStepName("messaging")).toBe(true);
    expect(isOnboardStepName("runtime_setup")).toBe(true);
    expect(isOnboardStepName("openclaw")).toBe(true);
    expect(isOnboardStepName("agent_setup")).toBe(true);
    expect(isOnboardStepName("not-a-step")).toBe(false);
  });

  it("transitions through the happy path with progressively richer context", () => {
    const boot = createInitialOnboardState({ resume: true, requestedSandboxName: "demo-box" });
    const preflight = transitionOnboardState(boot, { type: "SESSION_READY" });
    const gateway = transitionOnboardState(preflight, { type: "PREFLIGHT_PASSED" });
    const selection = transitionOnboardState(gateway, { type: "SESSION_READY" });
    const inference = transitionOnboardState(selection, {
      type: "PROVIDER_SELECTED",
      selection: {
        provider: "nvidia-nim",
        model: "meta/llama-3.3-70b-instruct",
        endpointUrl: "https://integrate.api.nvidia.com/v1",
        credentialEnv: "NVIDIA_API_KEY",
        preferredInferenceApi: "openai-completions",
        nimContainer: null,
      },
    });
    const messaging = transitionOnboardState(inference, { type: "INFERENCE_CONFIGURED" });
    const sandbox = transitionOnboardState(messaging, {
      type: "MESSAGING_CONFIGURED",
      messagingChannels: ["telegram", "slack"],
    });
    const runtime = transitionOnboardState(sandbox, {
      type: "SANDBOX_READY",
      sandboxName: "demo-box",
      webSearchConfig: { fetchEnabled: true },
    });
    const policies = transitionOnboardState(runtime, { type: "RUNTIME_CONFIGURED" });
    const complete = transitionOnboardState(policies, {
      type: "POLICIES_APPLIED",
      policyPresets: ["npm", "pypi", "telegram"],
    });

    expect(complete.phase).toBe("complete");
    expect(complete.ctx.resume).toBe(true);
    expect(complete.ctx.provider).toBe("nvidia-nim");
    expect(complete.ctx.model).toBe("meta/llama-3.3-70b-instruct");
    expect(complete.ctx.messagingChannels).toEqual(["telegram", "slack"]);
    expect(complete.ctx.sandboxName).toBe("demo-box");
    expect(complete.ctx.webSearchConfig).toEqual({ fetchEnabled: true });
    expect(complete.ctx.policyPresets).toEqual(["npm", "pypi", "telegram"]);
  });

  it("throws a clear error when a runtime transition is unsupported", () => {
    const state = createInitialOnboardState();
    expect(() =>
      transitionOnboardState(
        state as never,
        { type: "PREFLIGHT_PASSED" } as never,
      ),
    ).toThrow(/Invalid onboarding transition: boot -> PREFLIGHT_PASSED/);
  });

  it("captures the failed phase and supports typed reset", () => {
    const boot = createInitialOnboardState({ mode: "non-interactive" });
    const preflight = transitionOnboardState(boot, { type: "SESSION_READY" });
    const failed = transitionOnboardState(preflight, {
      type: "FAIL",
      error: {
        code: "docker_unreachable",
        message: "Docker is installed but not reachable.",
        recoverable: true,
      },
    });

    expect(failed.phase).toBe("failed");
    expect(failed.failedFrom).toBe("preflight");
    expect(failed.error.recoverable).toBe(true);

    const reset = transitionOnboardState(failed, {
      type: "RESET",
      ctx: failed.ctx,
    });
    expect(reset.phase).toBe("boot");
    expect(reset.ctx.mode).toBe("non-interactive");
  });

  it("exposes context narrowing that tsc can prove", () => {
    const boot = createInitialOnboardState();
    const preflight = transitionOnboardState(boot, { type: "SESSION_READY" });
    const gateway = transitionOnboardState(preflight, { type: "PREFLIGHT_PASSED" });
    const selection = transitionOnboardState(gateway, { type: "SESSION_READY" });
    const inference = transitionOnboardState(selection, {
      type: "PROVIDER_SELECTED",
      selection: {
        provider: "openai-api",
        model: "gpt-5.4",
        endpointUrl: "https://api.openai.com/v1",
        credentialEnv: "OPENAI_API_KEY",
        preferredInferenceApi: "responses",
        nimContainer: null,
      },
    });

    expectTypeOf(inference.phase).toEqualTypeOf<"inference">();
    expectTypeOf(inference.ctx.provider).toEqualTypeOf<string>();
    expectTypeOf(inference.ctx.model).toEqualTypeOf<string>();
    expectTypeOf(inference.ctx.sandboxName).toEqualTypeOf<string | null>();
  });
});
