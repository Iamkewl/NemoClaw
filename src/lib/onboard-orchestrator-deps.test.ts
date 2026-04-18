// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const bootstrapDistPath = require.resolve("../../dist/lib/onboard-bootstrap");
const contextDistPath = require.resolve("../../dist/lib/onboard-run-context");
const depsDistPath = require.resolve("../../dist/lib/onboard-orchestrator-deps");
const originalEnv = { ...process.env };
let tmpDir: string;

const clearDistModuleCache = () => {
  delete require.cache[bootstrapDistPath];
  delete require.cache[contextDistPath];
  delete require.cache[depsDistPath];
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-orchestrator-deps-"));
  clearDistModuleCache();
  process.env.HOME = tmpDir;
  process.env.NVIDIA_API_KEY = "test-key";
});

afterEach(() => {
  clearDistModuleCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe("createOnboardingOrchestratorDeps", () => {
  it("builds orchestrator deps that wire legacy helpers into the extracted flows", async () => {
    const { initializeOnboardRun } = require("../../dist/lib/onboard-bootstrap");
    const { createOnboardRunContext } = require("../../dist/lib/onboard-run-context");
    const { createOnboardingOrchestratorDeps } = require("../../dist/lib/onboard-orchestrator-deps");

    const initializedRun = initializeOnboardRun({
      resume: false,
      mode: "interactive",
      requestedFromDockerfile: null,
      requestedAgent: "hermes",
    });
    expect(initializedRun.ok).toBe(true);
    if (!initializedRun.ok) {
      throw new Error("expected onboarding initialization to succeed");
    }

    const runContext = createOnboardRunContext(initializedRun.value);
    const runCaptureOpenshell = vi.fn(() => "ok");
    const runOpenshell = vi.fn(() => ({ status: 0 }));
    const updateSandbox = vi.fn();
    const handleAgentSetup = vi.fn(async () => {});
    const setupPoliciesWithSelection = vi.fn(async (_sandboxName, options) => {
      options.onSelection(["npm"]);
      return ["npm"];
    });

    const deps = createOnboardingOrchestratorDeps(runContext, {
      resume: true,
      dangerouslySkipPermissions: false,
      requestedAgent: "hermes",
      gatewayName: "nemoclaw",
      dashboardPort: 18789,
      resolveAgent: () => ({ name: "hermes" }),
      note: () => {},
      log: () => {},
      skippedStepMessage: () => {},
      step: () => {},
      preflight: async () => null,
      detectGpu: () => null,
      runCaptureOpenshell,
      getGatewayReuseState: () => "missing",
      verifyGatewayContainerRunning: () => "running",
      runOpenshell,
      destroyGateway: () => {},
      clearRegistryAll: () => {},
      startGateway: async () => {},
      setupNim: async () => ({
        model: "gpt-5.4",
        provider: "openai-api",
        endpointUrl: "https://api.openai.com/v1",
        credentialEnv: "OPENAI_API_KEY",
        preferredInferenceApi: "responses",
        nimContainer: null,
      }),
      setupInference: async () => {},
      isInferenceRouteReady: () => false,
      hydrateCredentialEnv: () => {},
      getOpenshellBinary: () => "/usr/bin/openshell",
      updateSandbox,
      setupMessagingChannels: async () => ["telegram"],
      configureWebSearch: async () => null,
      ensureValidatedBraveSearchCredential: async () => null,
      getSandboxReuseState: () => "missing",
      removeSandbox: () => {},
      repairRecordedSandbox: () => {},
      createSandbox: async () => "alpha",
      handleAgentSetup,
      openshellShellCommand: () => "openshell shell cmd",
      buildSandboxConfigSyncScript: () => "echo config",
      writeSandboxConfigSyncFile: () => "/tmp/config.sh",
      cleanupTempDir: () => {},
      isOpenclawReady: () => false,
      setupOpenclaw: async () => {},
      waitForSandboxReady: () => true,
      applyPermissivePolicy: () => {},
      arePolicyPresetsApplied: () => false,
      setupPoliciesWithSelection,
    });

    expect(deps.resume).toBe(true);
    expect(deps.requestedAgent).toBe("hermes");
    expect(deps.host.run.name).toBe("runHostPreparationFlow");
    expect(deps.inference.run.name).toBe("runInferenceSelectionLoop");
    expect(deps.sandbox.run.name).toBe("runSandboxProvisioningFlow");
    expect(deps.runtime.run.name).toBe("runRuntimeSetupFlow");
    expect(deps.policy.run.name).toBe("runPolicySetupFlow");

    deps.host.getNamedGatewayInfo();
    deps.host.getActiveGatewayInfo();
    deps.host.stopDashboardForward();
    deps.inference.setOpenshellBinary("/tmp/openshell");
    deps.inference.clearSensitiveEnv("NVIDIA_API_KEY");
    deps.sandbox.persistRegistryModelProvider("alpha", { model: "gpt-5.4", provider: "openai-api" });
    await deps.runtime.handleAgentSetup("alpha", "gpt-5.4", "openai-api", { name: "hermes" }, true, { id: 1 });
    await deps.policy.setupPoliciesWithSelection("alpha", {
      selectedPresets: ["npm"],
      enabledChannels: [],
      webSearchConfig: null,
      provider: "openai-api",
      onSelection: () => {},
    });

    expect(runCaptureOpenshell).toHaveBeenNthCalledWith(1, ["gateway", "info", "-g", "nemoclaw"], {
      ignoreError: true,
    });
    expect(runCaptureOpenshell).toHaveBeenNthCalledWith(2, ["gateway", "info"], {
      ignoreError: true,
    });
    expect(runOpenshell).toHaveBeenCalledWith(["forward", "stop", "18789"], { ignoreError: true });
    expect(process.env.NEMOCLAW_OPENSHELL_BIN).toBe("/tmp/openshell");
    expect(process.env.NVIDIA_API_KEY).toBeUndefined();
    expect(updateSandbox).toHaveBeenCalledWith("alpha", { model: "gpt-5.4", provider: "openai-api" });
    expect(handleAgentSetup).toHaveBeenCalled();
    expect(setupPoliciesWithSelection).toHaveBeenCalled();
  });
});
