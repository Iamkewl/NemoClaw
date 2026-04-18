// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { InMemoryOnboardDriver } from "./onboard-driver";

describe("InMemoryOnboardDriver", () => {
  it("round-trips resumable checkpoints through persisted sessions", () => {
    const driver = InMemoryOnboardDriver.fresh({
      mode: "non-interactive",
      requestedSandboxName: "alpha",
    });

    driver.enterWorkflow();
    expect(driver.state.phase).toBe("preflight");
    expect(driver.reloadForResume().state.phase).toBe("preflight");

    driver.finishPreflight();
    expect(driver.state.phase).toBe("gateway");
    expect(driver.reloadForResume().state.phase).toBe("gateway");

    driver.finishGateway();
    expect(driver.state.phase).toBe("provider_selection");
    expect(driver.reloadForResume().state.phase).toBe("provider_selection");

    driver.finishProviderSelection({
      provider: "openai-api",
      model: "gpt-5.4",
      endpointUrl: "https://api.openai.com/v1",
      credentialEnv: "OPENAI_API_KEY",
      preferredInferenceApi: "responses",
    });
    expect(driver.state.phase).toBe("inference");
    expect(driver.reloadForResume().state.phase).toBe("inference");

    driver.finishInference();
    expect(driver.state.phase).toBe("messaging");
    expect(driver.reloadForResume().state.phase).toBe("messaging");

    driver.finishMessaging(["telegram", "slack"]);
    expect(driver.state.phase).toBe("sandbox");
    expect(driver.reloadForResume().state.phase).toBe("sandbox");

    driver.finishSandbox("alpha", { fetchEnabled: true });
    expect(driver.state.phase).toBe("runtime_setup");
    expect(driver.reloadForResume().state.phase).toBe("runtime_setup");

    driver.finishRuntimeSetup();
    expect(driver.state.phase).toBe("policies");
    expect(driver.reloadForResume().state.phase).toBe("policies");

    driver.finishPolicies(["npm", "telegram"]);
    expect(driver.state.phase).toBe("complete");

    const resumed = driver.reloadForResume();
    expect(resumed.state.phase).toBe("complete");
    expect(resumed.state.ctx.sandboxName).toBe("alpha");
    expect(resumed.state.ctx.messagingChannels).toEqual(["telegram", "slack"]);
    expect(resumed.state.ctx.policyPresets).toEqual(["npm", "telegram"]);
  });

  it("resumes runtime_setup failures from the canonical phase even when the persisted step is openclaw", () => {
    const driver = InMemoryOnboardDriver.fresh({ requestedSandboxName: "alpha" });
    driver
      .enterWorkflow()
      .finishPreflight()
      .finishGateway()
      .finishProviderSelection({ provider: "openai-api", model: "gpt-5.4" })
      .finishInference()
      .finishMessaging([])
      .finishSandbox("alpha")
      .fail("OpenClaw bootstrap failed", "runtime_boot_failed");

    const resumed = driver.reloadForResume();
    expect(resumed.state.phase).toBe("failed");
    if (resumed.state.phase !== "failed") {
      throw new Error("expected failed state");
    }
    expect(resumed.state.failedFrom).toBe("runtime_setup");
    expect(resumed.state.error.code).toBe("persisted_runtime_setup_failure");
    expect(resumed.session.steps.runtime_setup.status).toBe("failed");
    expect(resumed.session.steps.openclaw.status).toBe("failed");
  });

  it("keeps agent runtime sessions on the agent_setup path while exposing canonical runtime_setup", () => {
    const driver = InMemoryOnboardDriver.fresh({
      requestedSandboxName: "alpha",
      runtimeTarget: { kind: "agent", agentName: "hermes" },
    });
    driver
      .enterWorkflow()
      .finishPreflight()
      .finishGateway()
      .finishProviderSelection({ provider: "nvidia-nim", model: "meta/llama-3.3-70b-instruct" })
      .finishInference()
      .finishMessaging(["slack"])
      .finishSandbox("alpha")
      .finishRuntimeSetup();

    const resumed = driver.reloadForResume();
    expect(resumed.state.phase).toBe("policies");
    expect(resumed.session.steps.agent_setup.status).toBe("complete");
    expect(resumed.session.steps.runtime_setup.status).toBe("complete");
    expect(resumed.state.ctx.runtimeTarget).toEqual({ kind: "agent", agentName: "hermes" });
  });
});
