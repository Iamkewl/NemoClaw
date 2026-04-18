// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface InferenceSelectionResult {
  model: string;
  provider: string;
  endpointUrl: string | null;
  credentialEnv: string | null;
  preferredInferenceApi: string | null;
  nimContainer: string | null;
}

export interface InferenceLoopState {
  sandboxName: string | null;
  model: string | null;
  provider: string | null;
  endpointUrl: string | null;
  credentialEnv: string | null;
  preferredInferenceApi: string | null;
  nimContainer: string | null;
}

export interface InferenceLoopResult extends InferenceLoopState {}

export interface InferenceLoopDeps<TGpu = unknown> {
  gpu: TGpu;
  resume: boolean;
  hasCompletedProviderSelection: boolean;
  hasCompletedInference: boolean;
  setupNim: (gpu: TGpu) => Promise<InferenceSelectionResult>;
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
  setOpenshellBinary: (binary: string) => void;
  clearSensitiveEnv: (credentialEnv: string | null) => void;
  updateSandboxNimContainer: (sandboxName: string | null, nimContainer: string) => void;
  onSkip: (stepName: "provider_selection" | "inference", detail: string) => void;
  onStartStep: (
    stepName: "provider_selection" | "inference",
    updates?: { sandboxName?: string | null; provider?: string | null; model?: string | null },
  ) => void;
  onCompleteStep: (
    stepName: "provider_selection" | "inference",
    updates?: {
      sandboxName?: string | null;
      provider?: string | null;
      model?: string | null;
      endpointUrl?: string | null;
      credentialEnv?: string | null;
      preferredInferenceApi?: string | null;
      nimContainer?: string | null;
    },
  ) => void;
}

function hasResolvedSelection(
  state: InferenceLoopState,
): state is InferenceLoopState & { provider: string; model: string } {
  return typeof state.provider === "string" && typeof state.model === "string";
}

export async function runInferenceSelectionLoop<TGpu = unknown>(
  initialState: InferenceLoopState,
  deps: InferenceLoopDeps<TGpu>,
): Promise<InferenceLoopResult> {
  const state: InferenceLoopState = { ...initialState };
  let forceProviderSelection = false;

  while (true) {
    const resumeProviderSelection =
      !forceProviderSelection &&
      deps.resume &&
      deps.hasCompletedProviderSelection &&
      hasResolvedSelection(state);

    if (resumeProviderSelection) {
      deps.onSkip("provider_selection", `${state.provider} / ${state.model}`);
      deps.hydrateCredentialEnv(state.credentialEnv);
    } else {
      deps.onStartStep("provider_selection", { sandboxName: state.sandboxName });
      const selection = await deps.setupNim(deps.gpu);
      state.model = selection.model;
      state.provider = selection.provider;
      state.endpointUrl = selection.endpointUrl;
      state.credentialEnv = selection.credentialEnv;
      state.preferredInferenceApi = selection.preferredInferenceApi;
      state.nimContainer = selection.nimContainer;
      deps.onCompleteStep("provider_selection", {
        sandboxName: state.sandboxName,
        provider: state.provider,
        model: state.model,
        endpointUrl: state.endpointUrl,
        credentialEnv: state.credentialEnv,
        preferredInferenceApi: state.preferredInferenceApi,
        nimContainer: state.nimContainer,
      });
    }

    if (!hasResolvedSelection(state)) {
      throw new Error("Provider selection did not produce a provider/model pair.");
    }

    deps.setOpenshellBinary(deps.getOpenshellBinary());

    const resumeInference =
      !forceProviderSelection &&
      deps.resume &&
      deps.hasCompletedInference &&
      deps.isInferenceRouteReady(state.provider, state.model);

    if (resumeInference) {
      deps.onSkip("inference", `${state.provider} / ${state.model}`);
      if (state.nimContainer) {
        deps.updateSandboxNimContainer(state.sandboxName, state.nimContainer);
      }
      deps.onCompleteStep("inference", {
        sandboxName: state.sandboxName,
        provider: state.provider,
        model: state.model,
        nimContainer: state.nimContainer,
      });
      break;
    }

    deps.onStartStep("inference", {
      sandboxName: state.sandboxName,
      provider: state.provider,
      model: state.model,
    });
    const inferenceResult = await deps.setupInference(
      state.sandboxName,
      state.model,
      state.provider,
      state.endpointUrl,
      state.credentialEnv,
    );
    deps.clearSensitiveEnv(state.credentialEnv);
    if (inferenceResult?.retry === "selection") {
      forceProviderSelection = true;
      continue;
    }
    if (state.nimContainer) {
      deps.updateSandboxNimContainer(state.sandboxName, state.nimContainer);
    }
    deps.onCompleteStep("inference", {
      sandboxName: state.sandboxName,
      provider: state.provider,
      model: state.model,
      nimContainer: state.nimContainer,
    });
    break;
  }

  return state;
}
