// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InferenceLoopDeps, InferenceLoopState } from "./onboard-inference-loop";
import type { Session } from "./onboard-session";

const require = createRequire(import.meta.url);
const bootstrapDistPath = require.resolve("../../dist/lib/onboard-bootstrap");
const contextDistPath = require.resolve("../../dist/lib/onboard-run-context");
const orchestratorDistPath = require.resolve("../../dist/lib/onboard-orchestrator");
const sessionDistPath = require.resolve("../../dist/lib/onboard-session");
const flowStateDistPath = require.resolve("../../dist/lib/onboard-flow-state");
const driverDistPath = require.resolve("../../dist/lib/onboard-persistent-driver");
const originalHome = process.env.HOME;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-orchestrator-"));
  process.env.HOME = tmpDir;
  delete require.cache[bootstrapDistPath];
  delete require.cache[contextDistPath];
  delete require.cache[orchestratorDistPath];
  delete require.cache[sessionDistPath];
  delete require.cache[flowStateDistPath];
  delete require.cache[driverDistPath];
});

afterEach(() => {
  delete require.cache[bootstrapDistPath];
  delete require.cache[contextDistPath];
  delete require.cache[orchestratorDistPath];
  delete require.cache[sessionDistPath];
  delete require.cache[flowStateDistPath];
  delete require.cache[driverDistPath];
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

describe("runOnboardingOrchestrator", () => {
  it("coordinates the extracted helper flows and completes the session", async () => {
    const { initializeOnboardRun } = require("../../dist/lib/onboard-bootstrap");
    const { createOnboardRunContext } = require("../../dist/lib/onboard-run-context");
    const { runOnboardingOrchestrator } = require("../../dist/lib/onboard-orchestrator");

    const initializedRun = initializeOnboardRun({
      resume: false,
      mode: "non-interactive",
      requestedFromDockerfile: "./Dockerfile.custom",
      requestedAgent: null,
    });
    expect(initializedRun.ok).toBe(true);
    if (!initializedRun.ok) {
      throw new Error("expected onboarding initialization to succeed");
    }

    const runContext = createOnboardRunContext(initializedRun.value);
    const hostRun = vi.fn(async () => ({ gpu: { kind: "spark" }, gatewayReuseState: "missing" }));
    const inferenceRun = vi.fn(async () => ({
      sandboxName: null,
      model: "gpt-5.4",
      provider: "openai-api",
      endpointUrl: "https://api.openai.com/v1",
      credentialEnv: "OPENAI_API_KEY",
      preferredInferenceApi: "responses",
      nimContainer: null,
    }));
    const sandboxRun = vi.fn(async () => ({
      gpu: { kind: "spark" },
      sandboxName: "alpha",
      model: "gpt-5.4",
      provider: "openai-api",
      preferredInferenceApi: "responses",
      webSearchConfig: { fetchEnabled: true },
      selectedMessagingChannels: ["telegram"],
      nimContainer: null,
      fromDockerfile: path.resolve("./Dockerfile.custom"),
      agent: null,
      dangerouslySkipPermissions: false,
    }));
    const runtimeRun = vi.fn(async () => {});
    const policyRun = vi.fn(async () => ({ kind: "complete", policyPresets: ["npm"] }));

    const result = await runOnboardingOrchestrator(runContext, {
      resume: false,
      dangerouslySkipPermissions: false,
      requestedAgent: null,
      resolveAgent: () => null,
      note: () => {},
      log: () => {},
      skippedStepMessage: () => {},
      showPolicyHeader: () => {},
      host: {
        run: hostRun,
        preflight: async () => ({ kind: "spark" }),
        detectGpu: () => ({ kind: "cached" }),
        getGatewayStatus: () => "status",
        getNamedGatewayInfo: () => "named-info",
        getActiveGatewayInfo: () => "active-info",
        getGatewayReuseState: () => "missing",
        verifyGatewayContainerRunning: () => "running",
        stopDashboardForward: () => {},
        destroyGateway: () => {},
        clearRegistryAll: () => {},
        startGateway: async () => {},
      },
      inference: {
        run: inferenceRun,
        gpu: null,
        setupNim: async () => {
          throw new Error("unused in orchestrator test");
        },
        setupInference: async () => {},
        isInferenceRouteReady: () => false,
        hydrateCredentialEnv: () => {},
        getOpenshellBinary: () => "/usr/bin/openshell",
        setOpenshellBinary: () => {},
        clearSensitiveEnv: () => {},
        updateSandboxNimContainer: () => {},
      },
      sandbox: {
        run: sandboxRun,
        sessionMessagingChannels: null,
        sessionWebSearchConfig: null,
        hasCompletedMessaging: false,
        hasCompletedSandbox: false,
        setupMessagingChannels: async () => ["telegram"],
        configureWebSearch: async () => ({ fetchEnabled: true }),
        ensureValidatedBraveSearchCredential: async () => null,
        getSandboxReuseState: () => "missing",
        removeSandbox: () => {},
        repairRecordedSandbox: () => {},
        createSandbox: async () => "alpha",
        persistRegistryModelProvider: () => {},
      },
      runtime: {
        run: runtimeRun,
        hasCompletedRuntimeSetup: false,
        handleAgentSetup: async () => {},
        isOpenclawReady: () => false,
        setupOpenclaw: async () => {},
      },
      policy: {
        run: policyRun,
        waitForSandboxReady: () => true,
        applyPermissivePolicy: () => {},
        arePolicyPresetsApplied: () => false,
        setupPoliciesWithSelection: async () => ["npm"],
      },
    });

    expect(result).toEqual({
      sandboxName: "alpha",
      model: "gpt-5.4",
      provider: "openai-api",
      nimContainer: null,
      agent: null,
      policyResult: { kind: "complete", policyPresets: ["npm"] },
    });
    expect(runContext.session.status).toBe("complete");
    expect(runContext.session.policyPresets).toEqual(["npm"]);
    expect(hostRun).toHaveBeenCalledTimes(1);
    expect(inferenceRun).toHaveBeenCalledTimes(1);
    expect(sandboxRun).toHaveBeenCalledTimes(1);
    expect(runtimeRun).toHaveBeenCalledTimes(1);
    expect(policyRun).toHaveBeenCalledTimes(1);
  });

  it("preserves explicit null session updates from extracted flow callbacks", async () => {
    const { initializeOnboardRun } = require("../../dist/lib/onboard-bootstrap");
    const { createOnboardRunContext } = require("../../dist/lib/onboard-run-context");
    const { runOnboardingOrchestrator } = require("../../dist/lib/onboard-orchestrator");

    const initializedRun = initializeOnboardRun({
      resume: false,
      mode: "interactive",
      requestedFromDockerfile: null,
      requestedAgent: null,
    });
    expect(initializedRun.ok).toBe(true);
    if (!initializedRun.ok) {
      throw new Error("expected onboarding initialization to succeed");
    }

    const runContext = createOnboardRunContext(initializedRun.value);
    runContext.updateSession((session: Session) => {
      session.endpointUrl = "https://old.example.com/v1";
      session.credentialEnv = "COMPATIBLE_API_KEY";
      session.preferredInferenceApi = "responses";
      session.nimContainer = "nim-stale";
      return session;
    });

    await runOnboardingOrchestrator(runContext, {
      resume: false,
      dangerouslySkipPermissions: false,
      requestedAgent: null,
      resolveAgent: () => null,
      note: () => {},
      log: () => {},
      skippedStepMessage: () => {},
      showPolicyHeader: () => {},
      host: {
        run: async () => ({ gpu: null, gatewayReuseState: "missing" }),
        preflight: async () => null,
        detectGpu: () => null,
        getGatewayStatus: () => "status",
        getNamedGatewayInfo: () => "named-info",
        getActiveGatewayInfo: () => "active-info",
        getGatewayReuseState: () => "missing",
        verifyGatewayContainerRunning: () => "running",
        stopDashboardForward: () => {},
        destroyGateway: () => {},
        clearRegistryAll: () => {},
        startGateway: async () => {},
      },
      inference: {
        run: async (
          state: InferenceLoopState,
          deps: Pick<InferenceLoopDeps, "onCompleteStep">,
        ) => {
          deps.onCompleteStep("provider_selection", {
            provider: "openai-api",
            model: "gpt-5.4",
            endpointUrl: null,
            credentialEnv: null,
            preferredInferenceApi: null,
            nimContainer: null,
          });
          return {
            ...state,
            model: "gpt-5.4",
            provider: "openai-api",
            endpointUrl: null,
            credentialEnv: null,
            preferredInferenceApi: null,
            nimContainer: null,
          };
        },
        gpu: null,
        setupNim: async () => {
          throw new Error("unused in orchestrator test");
        },
        setupInference: async () => {},
        isInferenceRouteReady: () => false,
        hydrateCredentialEnv: () => {},
        getOpenshellBinary: () => "/usr/bin/openshell",
        setOpenshellBinary: () => {},
        clearSensitiveEnv: () => {},
        updateSandboxNimContainer: () => {},
      },
      sandbox: {
        run: async () => ({
          gpu: null,
          sandboxName: "alpha",
          model: "gpt-5.4",
          provider: "openai-api",
          preferredInferenceApi: null,
          webSearchConfig: null,
          selectedMessagingChannels: [],
          nimContainer: null,
          fromDockerfile: null,
          agent: null,
          dangerouslySkipPermissions: false,
        }),
        sessionMessagingChannels: null,
        sessionWebSearchConfig: null,
        hasCompletedMessaging: false,
        hasCompletedSandbox: false,
        setupMessagingChannels: async () => [],
        configureWebSearch: async () => null,
        ensureValidatedBraveSearchCredential: async () => null,
        getSandboxReuseState: () => "missing",
        removeSandbox: () => {},
        repairRecordedSandbox: () => {},
        createSandbox: async () => "alpha",
        persistRegistryModelProvider: () => {},
      },
      runtime: {
        run: async () => {},
        hasCompletedRuntimeSetup: false,
        handleAgentSetup: async () => {},
        isOpenclawReady: () => false,
        setupOpenclaw: async () => {},
      },
      policy: {
        run: async () => ({ kind: "complete", policyPresets: [] }),
        waitForSandboxReady: () => true,
        applyPermissivePolicy: () => {},
        arePolicyPresetsApplied: () => false,
        setupPoliciesWithSelection: async () => [],
      },
    });

    expect(runContext.session.endpointUrl).toBeNull();
    expect(runContext.session.credentialEnv).toBeNull();
    expect(runContext.session.preferredInferenceApi).toBeNull();
    expect(runContext.session.nimContainer).toBeNull();
  });

  it("leaves the session in progress when policy setup returns sandbox_not_ready", async () => {
    const { initializeOnboardRun } = require("../../dist/lib/onboard-bootstrap");
    const { createOnboardRunContext } = require("../../dist/lib/onboard-run-context");
    const { runOnboardingOrchestrator } = require("../../dist/lib/onboard-orchestrator");

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
    const runtimeRun = vi.fn(async (state) => {
      expect(state.agent).toEqual({ name: "hermes" });
    });

    const result = await runOnboardingOrchestrator(runContext, {
      resume: false,
      dangerouslySkipPermissions: true,
      requestedAgent: "hermes",
      resolveAgent: () => ({ name: "hermes" }),
      note: () => {},
      log: () => {},
      skippedStepMessage: () => {},
      showPolicyHeader: () => {},
      host: {
        run: async () => ({ gpu: null, gatewayReuseState: "missing" }),
        preflight: async () => null,
        detectGpu: () => null,
        getGatewayStatus: () => "status",
        getNamedGatewayInfo: () => "named-info",
        getActiveGatewayInfo: () => "active-info",
        getGatewayReuseState: () => "missing",
        verifyGatewayContainerRunning: () => "running",
        stopDashboardForward: () => {},
        destroyGateway: () => {},
        clearRegistryAll: () => {},
        startGateway: async () => {},
      },
      inference: {
        run: async () => ({
          sandboxName: null,
          model: "meta/llama-3.3-70b-instruct",
          provider: "nvidia-prod",
          endpointUrl: "https://integrate.api.nvidia.com/v1",
          credentialEnv: "NVIDIA_API_KEY",
          preferredInferenceApi: "openai-completions",
          nimContainer: null,
        }),
        gpu: null,
        setupNim: async () => {
          throw new Error("unused in orchestrator test");
        },
        setupInference: async () => {},
        isInferenceRouteReady: () => false,
        hydrateCredentialEnv: () => {},
        getOpenshellBinary: () => "/usr/bin/openshell",
        setOpenshellBinary: () => {},
        clearSensitiveEnv: () => {},
        updateSandboxNimContainer: () => {},
      },
      sandbox: {
        run: async () => ({
          gpu: null,
          sandboxName: "alpha",
          model: "meta/llama-3.3-70b-instruct",
          provider: "nvidia-prod",
          preferredInferenceApi: "openai-completions",
          webSearchConfig: null,
          selectedMessagingChannels: [],
          nimContainer: null,
          fromDockerfile: null,
          agent: { name: "hermes" },
          dangerouslySkipPermissions: true,
        }),
        sessionMessagingChannels: null,
        sessionWebSearchConfig: null,
        hasCompletedMessaging: false,
        hasCompletedSandbox: false,
        setupMessagingChannels: async () => [],
        configureWebSearch: async () => null,
        ensureValidatedBraveSearchCredential: async () => null,
        getSandboxReuseState: () => "missing",
        removeSandbox: () => {},
        repairRecordedSandbox: () => {},
        createSandbox: async () => "alpha",
        persistRegistryModelProvider: () => {},
      },
      runtime: {
        run: runtimeRun,
        hasCompletedRuntimeSetup: false,
        handleAgentSetup: async () => {},
        isOpenclawReady: () => false,
        setupOpenclaw: async () => {},
      },
      policy: {
        run: async () => ({
          kind: "sandbox_not_ready",
          message: "  ✗ Sandbox 'alpha' not ready after creation. Giving up.",
        }),
        waitForSandboxReady: () => false,
        applyPermissivePolicy: () => {},
        arePolicyPresetsApplied: () => false,
        setupPoliciesWithSelection: async () => [],
      },
    });

    expect(result.agent).toEqual({ name: "hermes" });
    expect(result.policyResult).toEqual({
      kind: "sandbox_not_ready",
      message: "  ✗ Sandbox 'alpha' not ready after creation. Giving up.",
    });
    expect(runContext.session.status).toBe("in_progress");
    expect(runContext.session.agent).toBe("hermes");
    expect(runtimeRun).toHaveBeenCalledTimes(1);
  });
});
