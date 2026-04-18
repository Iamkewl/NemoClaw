// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { GatewayReuseState } from "./gateway-state";
import { runHostPreparationFlow } from "./onboard-host-flow";
import { runInferenceSelectionLoop } from "./onboard-inference-loop";
import { runPolicySetupFlow } from "./onboard-policy-flow";
import type { OnboardOrchestratorDeps } from "./onboard-orchestrator";
import type { OnboardRunContext } from "./onboard-run-context";
import { runRuntimeSetupFlow } from "./onboard-runtime-flow";
import { runSandboxProvisioningFlow } from "./onboard-sandbox-flow";
import type { Session } from "./onboard-session";
import type { WebSearchConfig } from "./web-search";

export interface CreateOnboardingOrchestratorDepsInput<
  TGpu = unknown,
  TAgent extends { name: string } = { name: string },
> {
  resume: boolean;
  dangerouslySkipPermissions: boolean;
  requestedAgent: string | null;
  gatewayName: string;
  dashboardPort: number;
  resolveAgent: (options: { agentFlag?: string | null; session?: Session | null }) => TAgent | null;
  note: (message: string) => void;
  log: (message: string) => void;
  skippedStepMessage: (
    stepName: string,
    detail: string | null,
    reason?: "resume" | "reuse",
  ) => void;
  step: (current: number, total: number, message: string) => void;
  preflight: () => Promise<TGpu>;
  detectGpu: () => TGpu;
  runCaptureOpenshell: (args: string[], opts?: { ignoreError?: boolean }) => string;
  getGatewayReuseState: (
    statusOutput: string,
    gwInfoOutput: string,
    activeGatewayInfoOutput: string,
  ) => GatewayReuseState;
  verifyGatewayContainerRunning: () => "running" | "missing" | "unknown";
  runOpenshell: (
    args: string[],
    opts?: { ignoreError?: boolean },
  ) => { status: number; stdout?: string; stderr?: string };
  destroyGateway: () => void;
  clearRegistryAll: () => void;
  startGateway: (gpu: TGpu) => Promise<void>;
  setupNim: (gpu: TGpu) => Promise<{
    model: string;
    provider: string;
    endpointUrl: string | null;
    credentialEnv: string | null;
    preferredInferenceApi: string | null;
    nimContainer: string | null;
  }>;
  setupInference: (
    sandboxName: string | null,
    model: string,
    provider: string,
    endpointUrl: string | null,
    credentialEnv: string | null,
  ) => Promise<{ retry?: "selection" } | void>;
  isInferenceRouteReady: (provider: string, model: string) => boolean;
  hydrateCredentialEnv: (credentialEnv: string | null) => void;
  getOpenshellBinary: () => string;
  updateSandbox: (sandboxName: string | null, patch: Record<string, unknown>) => void;
  setupMessagingChannels: () => Promise<string[]>;
  configureWebSearch: (_existing: null) => Promise<WebSearchConfig | null>;
  ensureValidatedBraveSearchCredential: () => Promise<string | null>;
  getSandboxReuseState: (sandboxName: string | null) => string;
  removeSandbox: (sandboxName: string) => void;
  repairRecordedSandbox: (sandboxName: string) => void;
  createSandbox: (
    gpu: TGpu,
    model: string,
    provider: string,
    preferredInferenceApi: string | null,
    sandboxName: string | null,
    webSearchConfig: WebSearchConfig | null,
    messagingChannels: string[],
    fromDockerfile: string | null,
    agent: TAgent | null,
    dangerouslySkipPermissions: boolean,
  ) => Promise<string>;
  handleAgentSetup: (
    sandboxName: string,
    model: string,
    provider: string,
    agent: TAgent,
    resume: boolean,
    session: unknown,
    ctx: {
      step: (current: number, total: number, message: string) => void;
      runCaptureOpenshell: (args: string[], opts?: { ignoreError?: boolean }) => string;
      openshellShellCommand: (args: string[], options?: { openshellBinary?: string }) => string;
      buildSandboxConfigSyncScript: (config: Record<string, unknown>) => string;
      writeSandboxConfigSyncFile: (script: string) => string;
      cleanupTempDir: (file: string, prefix: string) => void;
      startRecordedStep: (stepName: string, updates: Record<string, unknown>) => void;
      skippedStepMessage: (stepName: string, sandboxName: string) => void;
    },
  ) => Promise<void>;
  openshellShellCommand: (args: string[], options?: { openshellBinary?: string }) => string;
  buildSandboxConfigSyncScript: (config: Record<string, unknown>) => string;
  writeSandboxConfigSyncFile: (script: string) => string;
  cleanupTempDir: (file: string, prefix: string) => void;
  isOpenclawReady: (sandboxName: string) => boolean;
  setupOpenclaw: (sandboxName: string, model: string, provider: string) => Promise<void>;
  waitForSandboxReady: (sandboxName: string) => boolean;
  applyPermissivePolicy: (sandboxName: string) => void;
  arePolicyPresetsApplied: (sandboxName: string, selectedPresets: string[]) => boolean;
  setupPoliciesWithSelection: (
    sandboxName: string,
    options: {
      selectedPresets: string[] | null;
      enabledChannels: string[];
      webSearchConfig: WebSearchConfig | null;
      provider: string;
      onSelection: (policyPresets: string[]) => void;
    },
  ) => Promise<string[]>;
}

export function createOnboardingOrchestratorDeps<
  TGpu = unknown,
  TAgent extends { name: string } = { name: string },
>(
  runContext: OnboardRunContext,
  input: CreateOnboardingOrchestratorDepsInput<TGpu, TAgent>,
): OnboardOrchestratorDeps<TGpu, TAgent> {
  return {
    resume: input.resume,
    dangerouslySkipPermissions: input.dangerouslySkipPermissions,
    requestedAgent: input.requestedAgent,
    resolveAgent: input.resolveAgent,
    note: input.note,
    log: input.log,
    skippedStepMessage: input.skippedStepMessage,
    showPolicyHeader: () => {
      input.step(8, 8, "Policy presets");
    },
    host: {
      run: runHostPreparationFlow,
      preflight: input.preflight,
      detectGpu: input.detectGpu,
      getGatewayStatus: () => input.runCaptureOpenshell(["status"], { ignoreError: true }),
      getNamedGatewayInfo: () =>
        input.runCaptureOpenshell(["gateway", "info", "-g", input.gatewayName], {
          ignoreError: true,
        }),
      getActiveGatewayInfo: () => input.runCaptureOpenshell(["gateway", "info"], { ignoreError: true }),
      getGatewayReuseState: input.getGatewayReuseState,
      verifyGatewayContainerRunning: input.verifyGatewayContainerRunning,
      stopDashboardForward: () => {
        input.runOpenshell(["forward", "stop", String(input.dashboardPort)], { ignoreError: true });
      },
      destroyGateway: input.destroyGateway,
      clearRegistryAll: input.clearRegistryAll,
      startGateway: input.startGateway,
    },
    inference: {
      run: runInferenceSelectionLoop,
      setupNim: input.setupNim,
      setupInference: input.setupInference,
      isInferenceRouteReady: input.isInferenceRouteReady,
      hydrateCredentialEnv: input.hydrateCredentialEnv,
      getOpenshellBinary: input.getOpenshellBinary,
      setOpenshellBinary: (binary) => {
        process.env.NEMOCLAW_OPENSHELL_BIN = binary;
      },
      clearSensitiveEnv: (credentialEnv) => {
        if (credentialEnv) {
          delete process.env[credentialEnv];
        }
      },
      updateSandboxNimContainer: (nextSandboxName, nextNimContainer) => {
        input.updateSandbox(nextSandboxName, { nimContainer: nextNimContainer });
      },
    },
    sandbox: {
      run: runSandboxProvisioningFlow,
      setupMessagingChannels: input.setupMessagingChannels,
      configureWebSearch: input.configureWebSearch,
      ensureValidatedBraveSearchCredential: input.ensureValidatedBraveSearchCredential,
      getSandboxReuseState: input.getSandboxReuseState,
      removeSandbox: input.removeSandbox,
      repairRecordedSandbox: input.repairRecordedSandbox,
      createSandbox: input.createSandbox,
      persistRegistryModelProvider: (name, patch) => {
        // Persist model and provider after the sandbox entry exists in the registry.
        // updateSandbox() silently no-ops when the entry is missing, so this must
        // run after createSandbox() / registerSandbox() — not before. Fixes #1881.
        input.updateSandbox(name, patch);
      },
    },
    runtime: {
      run: runRuntimeSetupFlow,
      handleAgentSetup: async (
        nextSandboxName,
        nextModel,
        nextProvider,
        nextAgent,
        nextResume,
        nextSession,
      ) => {
        if (nextAgent === null) {
          throw new Error("Agent runtime setup requested without an agent.");
        }
        await input.handleAgentSetup(
          nextSandboxName,
          nextModel,
          nextProvider,
          nextAgent,
          nextResume,
          nextSession,
          {
            step: input.step,
            runCaptureOpenshell: input.runCaptureOpenshell,
            openshellShellCommand: input.openshellShellCommand,
            buildSandboxConfigSyncScript: input.buildSandboxConfigSyncScript,
            writeSandboxConfigSyncFile: input.writeSandboxConfigSyncFile,
            cleanupTempDir: input.cleanupTempDir,
            startRecordedStep: (stepName, updates) => {
              runContext.startStep(stepName as never, updates as never);
            },
            skippedStepMessage: input.skippedStepMessage,
          },
        );
      },
      isOpenclawReady: input.isOpenclawReady,
      setupOpenclaw: input.setupOpenclaw,
    },
    policy: {
      run: runPolicySetupFlow,
      waitForSandboxReady: input.waitForSandboxReady,
      applyPermissivePolicy: input.applyPermissivePolicy,
      arePolicyPresetsApplied: input.arePolicyPresetsApplied,
      setupPoliciesWithSelection: input.setupPoliciesWithSelection,
    },
  };
}
