// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
// Import from compiled dist/ so coverage is attributed correctly.
import { runInferenceSelectionLoop } from "../../dist/lib/onboard-inference-loop";

describe("runInferenceSelectionLoop", () => {
  it("runs provider selection and inference setup on a fresh flow", async () => {
    const events: string[] = [];
    const setupNim = vi.fn(async () => ({
      provider: "openai-api",
      model: "gpt-5.4",
      endpointUrl: "https://api.openai.com/v1",
      credentialEnv: "OPENAI_API_KEY",
      preferredInferenceApi: "responses",
      nimContainer: null,
    }));
    const setupInference = vi.fn(async () => {});

    const result = await runInferenceSelectionLoop(
      {
        sandboxName: "alpha",
        model: null,
        provider: null,
        endpointUrl: null,
        credentialEnv: null,
        preferredInferenceApi: null,
        nimContainer: null,
      },
      {
        gpu: null,
        resume: false,
        hasCompletedProviderSelection: false,
        hasCompletedInference: false,
        setupNim,
        setupInference,
        isInferenceRouteReady: () => false,
        hydrateCredentialEnv: () => events.push("hydrate"),
        getOpenshellBinary: () => "/usr/bin/openshell",
        setOpenshellBinary: (binary) => events.push(`set-binary:${binary}`),
        clearSensitiveEnv: (credentialEnv) => events.push(`clear-env:${credentialEnv}`),
        updateSandboxNimContainer: () => events.push("update-nim"),
        onSkip: (step, detail) => events.push(`skip:${step}:${detail}`),
        onStartStep: (step) => events.push(`start:${step}`),
        onCompleteStep: (step) => events.push(`complete:${step}`),
      },
    );

    expect(result.provider).toBe("openai-api");
    expect(result.model).toBe("gpt-5.4");
    expect(setupNim).toHaveBeenCalledTimes(1);
    expect(setupInference).toHaveBeenCalledWith(
      "alpha",
      "gpt-5.4",
      "openai-api",
      "https://api.openai.com/v1",
      "OPENAI_API_KEY",
    );
    expect(events).toEqual([
      "start:provider_selection",
      "complete:provider_selection",
      "set-binary:/usr/bin/openshell",
      "start:inference",
      "clear-env:OPENAI_API_KEY",
      "complete:inference",
    ]);
  });

  it("reuses completed selection/inference state on resume", async () => {
    const events: string[] = [];

    const result = await runInferenceSelectionLoop(
      {
        sandboxName: "alpha",
        model: "meta/llama-3.3-70b-instruct",
        provider: "nvidia-prod",
        endpointUrl: "https://integrate.api.nvidia.com/v1",
        credentialEnv: "NVIDIA_API_KEY",
        preferredInferenceApi: "openai-completions",
        nimContainer: "nim-123",
      },
      {
        gpu: null,
        resume: true,
        hasCompletedProviderSelection: true,
        hasCompletedInference: true,
        setupNim: async () => {
          throw new Error("should not rerun selection");
        },
        setupInference: async () => {
          throw new Error("should not rerun inference");
        },
        isInferenceRouteReady: () => true,
        hydrateCredentialEnv: (credentialEnv) => events.push(`hydrate:${credentialEnv}`),
        getOpenshellBinary: () => "/usr/bin/openshell",
        setOpenshellBinary: (binary) => events.push(`set-binary:${binary}`),
        clearSensitiveEnv: (credentialEnv) => events.push(`clear-env:${credentialEnv}`),
        updateSandboxNimContainer: (sandboxName, nimContainer) =>
          events.push(`update-nim:${sandboxName}:${nimContainer}`),
        onSkip: (step, detail) => events.push(`skip:${step}:${detail}`),
        onStartStep: (step) => events.push(`start:${step}`),
        onCompleteStep: (step) => events.push(`complete:${step}`),
      },
    );

    expect(result.nimContainer).toBe("nim-123");
    expect(events).toEqual([
      "skip:provider_selection:nvidia-prod / meta/llama-3.3-70b-instruct",
      "hydrate:NVIDIA_API_KEY",
      "set-binary:/usr/bin/openshell",
      "skip:inference:nvidia-prod / meta/llama-3.3-70b-instruct",
      "update-nim:alpha:nim-123",
      "complete:inference",
    ]);
  });

  it("retries provider selection when inference requests a reselection", async () => {
    const selections = [
      {
        provider: "openai-api",
        model: "gpt-5.4",
        endpointUrl: "https://api.openai.com/v1",
        credentialEnv: "OPENAI_API_KEY",
        preferredInferenceApi: "responses",
        nimContainer: null,
      },
      {
        provider: "nvidia-prod",
        model: "meta/llama-3.3-70b-instruct",
        endpointUrl: "https://integrate.api.nvidia.com/v1",
        credentialEnv: "NVIDIA_API_KEY",
        preferredInferenceApi: "openai-completions",
        nimContainer: null,
      },
    ];
    const setupNim = vi.fn(async () => selections.shift()!);
    const setupInference = vi
      .fn()
      .mockResolvedValueOnce({ retry: "selection" })
      .mockResolvedValueOnce(undefined);

    const result = await runInferenceSelectionLoop(
      {
        sandboxName: "alpha",
        model: null,
        provider: null,
        endpointUrl: null,
        credentialEnv: null,
        preferredInferenceApi: null,
        nimContainer: null,
      },
      {
        gpu: null,
        resume: true,
        hasCompletedProviderSelection: true,
        hasCompletedInference: false,
        setupNim,
        setupInference,
        isInferenceRouteReady: () => false,
        hydrateCredentialEnv: () => {},
        getOpenshellBinary: () => "/usr/bin/openshell",
        setOpenshellBinary: () => {},
        clearSensitiveEnv: () => {},
        updateSandboxNimContainer: () => {},
        onSkip: () => {},
        onStartStep: () => {},
        onCompleteStep: () => {},
      },
    );

    expect(setupNim).toHaveBeenCalledTimes(2);
    expect(setupInference).toHaveBeenCalledTimes(2);
    expect(result.provider).toBe("nvidia-prod");
    expect(result.model).toBe("meta/llama-3.3-70b-instruct");
  });
});
