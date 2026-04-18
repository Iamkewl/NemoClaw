// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
// Import from compiled dist/ so coverage is attributed correctly.
import {
  getEffectiveProviderName,
  getNonInteractiveModel,
  getNonInteractiveProvider,
  getRequestedModelHint,
  getRequestedProviderHint,
  getRequestedSandboxNameHint,
  getResumeConfigConflicts,
  getResumeSandboxConflict,
} from "../../dist/lib/onboard-requests";

describe("onboard-requests", () => {
  it("resolves requested sandbox hints and resume sandbox conflicts", () => {
    const env = { NEMOCLAW_SANDBOX_NAME: "My-Assistant" } as NodeJS.ProcessEnv;
    expect(getRequestedSandboxNameHint(env)).toBe("my-assistant");
    expect(getResumeSandboxConflict({ sandboxName: "my-assistant" }, env)).toBeNull();
    expect(getResumeSandboxConflict({ sandboxName: "other-sandbox" }, env)).toEqual({
      requestedSandboxName: "my-assistant",
      recordedSandboxName: "other-sandbox",
    });
  });

  it("resolves and validates non-interactive provider/model inputs", () => {
    const env = {
      NEMOCLAW_PROVIDER: "cloud",
      NEMOCLAW_MODEL: "nvidia/test-model",
    } as NodeJS.ProcessEnv;
    expect(getNonInteractiveProvider({ env })).toBe("build");
    expect(getRequestedProviderHint(true, { env })).toBe("build");
    expect(getRequestedProviderHint(false, { env })).toBeNull();
    expect(
      getNonInteractiveModel("build", {
        env,
        isSafeModelId: (value) => value === "nvidia/test-model",
      }),
    ).toBe("nvidia/test-model");
    expect(
      getRequestedModelHint(true, {
        env,
        isSafeModelId: (value) => value === "nvidia/test-model",
      }),
    ).toBe("nvidia/test-model");
    expect(getRequestedModelHint(false, { env })).toBeNull();
  });

  it("reports invalid non-interactive provider and model inputs before onboarding begins", () => {
    const error = vi.fn();
    const exit = vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    }) as never;

    expect(() =>
      getNonInteractiveProvider({
        env: { NEMOCLAW_PROVIDER: "bogus" } as NodeJS.ProcessEnv,
        error,
        exit,
      }),
    ).toThrow("exit:1");
    expect(error).toHaveBeenCalledWith("  Unsupported NEMOCLAW_PROVIDER: bogus");

    const modelError = vi.fn();
    const modelExit = vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    }) as never;
    expect(() =>
      getNonInteractiveModel("build", {
        env: { NEMOCLAW_MODEL: "bad model" } as NodeJS.ProcessEnv,
        error: modelError,
        exit: modelExit,
        isSafeModelId: () => false,
      }),
    ).toThrow("exit:1");
    expect(modelError).toHaveBeenCalledWith(
      "  Invalid NEMOCLAW_MODEL for provider 'build': bad model",
    );
  });

  it("maps requested providers to effective provider names and resume conflicts", () => {
    const remoteProviderConfig = {
      build: { providerName: "nvidia-prod" },
      openai: { providerName: "openai-api" },
    };
    expect(getEffectiveProviderName("build", remoteProviderConfig)).toBe("nvidia-prod");
    expect(getEffectiveProviderName("nim-local", remoteProviderConfig)).toBe("nvidia-nim");
    expect(getEffectiveProviderName("ollama", remoteProviderConfig)).toBe("ollama-local");
    expect(getEffectiveProviderName("vllm", remoteProviderConfig)).toBe("vllm-local");
    expect(getEffectiveProviderName("custom-provider", remoteProviderConfig)).toBe(
      "custom-provider",
    );

    const env = {
      NEMOCLAW_SANDBOX_NAME: "my-assistant",
      NEMOCLAW_PROVIDER: "cloud",
      NEMOCLAW_MODEL: "nvidia/other-model",
    } as NodeJS.ProcessEnv;
    expect(
      getResumeConfigConflicts(
        {
          sandboxName: "my-assistant",
          provider: "nvidia-nim",
          model: "nvidia/nemotron-3-super-120b-a12b",
          metadata: { fromDockerfile: null },
        } as never,
        {
          nonInteractive: true,
          env,
          remoteProviderConfig,
          isSafeModelId: () => true,
        },
      ),
    ).toEqual([
      {
        field: "provider",
        requested: "nvidia-prod",
        recorded: "nvidia-nim",
      },
      {
        field: "model",
        requested: "nvidia/other-model",
        recorded: "nvidia/nemotron-3-super-120b-a12b",
      },
    ]);
  });
});
