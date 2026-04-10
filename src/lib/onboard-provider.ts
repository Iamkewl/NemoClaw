// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function createOnboardProviderHelpers(deps) {
  const {
    GATEWAY_NAME,
    LOCAL_INFERENCE_TIMEOUT_SECS,
    REMOTE_PROVIDER_CONFIG,
    classifyApplyFailure,
    compactText,
    getLocalProviderBaseUrl,
    getOllamaWarmupCommand,
    hydrateCredentialEnv,
    isNonInteractive,
    parseGatewayInference,
    promptValidationRecovery,
    registry,
    run,
    runCapture,
    runCaptureOpenshell,
    runOpenshell,
    step,
    validateLocalProvider,
    validateOllamaModel,
  } = deps;

  /**
   * Build the argument array for an `openshell provider create` or `update` command.
   * @param {"create"|"update"} action - Whether to create or update.
   * @param {string} name - Provider name.
   * @param {string} type - Provider type (e.g. "openai", "anthropic", "generic").
   * @param {string} credentialEnv - Credential environment variable name.
   * @param {string|null} baseUrl - Optional base URL for API-compatible endpoints.
   * @returns {string[]} Argument array for runOpenshell().
   */
  function buildProviderArgs(action, name, type, credentialEnv, baseUrl) {
    const args =
      action === "create"
        ? ["provider", "create", "--name", name, "--type", type, "--credential", credentialEnv]
        : ["provider", "update", name, "--credential", credentialEnv];
    if (baseUrl && type === "openai") {
      args.push("--config", `OPENAI_BASE_URL=${baseUrl}`);
    } else if (baseUrl && type === "anthropic") {
      args.push("--config", `ANTHROPIC_BASE_URL=${baseUrl}`);
    }
    return args;
  }

  function upsertProvider(name, type, credentialEnv, baseUrl, env = {}) {
    const createArgs = buildProviderArgs("create", name, type, credentialEnv, baseUrl);
    const runOpts = { ignoreError: true, env, stdio: ["ignore", "pipe", "pipe"] };
    const createResult = runOpenshell(createArgs, runOpts);
    if (createResult.status === 0) {
      return { ok: true };
    }

    const updateArgs = buildProviderArgs("update", name, type, credentialEnv, baseUrl);
    const updateResult = runOpenshell(updateArgs, runOpts);
    if (updateResult.status !== 0) {
      const output =
        compactText(`${createResult.stderr || ""} ${updateResult.stderr || ""}`) ||
        compactText(`${createResult.stdout || ""} ${updateResult.stdout || ""}`) ||
        `Failed to create or update provider '${name}'.`;
      return {
        ok: false,
        status: updateResult.status || createResult.status || 1,
        message: output,
      };
    }
    return { ok: true };
  }

  function upsertMessagingProviders(tokenDefs) {
    const providers = [];
    for (const { name, envKey, token } of tokenDefs) {
      if (!token) continue;
      const result = upsertProvider(name, "generic", envKey, null, { [envKey]: token });
      if (!result.ok) {
        console.error(`\n  ✗ Failed to create messaging provider '${name}': ${result.message}`);
        process.exit(1);
      }
      providers.push(name);
    }
    return providers;
  }

  function providerExistsInGateway(name) {
    const result = runOpenshell(["provider", "get", name], {
      ignoreError: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return result.status === 0;
  }

  function verifyInferenceRoute(_provider, _model) {
    const output = runCaptureOpenshell(["inference", "get"], { ignoreError: true });
    if (!output || /Gateway inference:\s*[\r\n]+\s*Not configured/i.test(output)) {
      console.error("  OpenShell inference route was not configured.");
      process.exit(1);
    }
  }

  function isInferenceRouteReady(provider, model) {
    const live = parseGatewayInference(
      runCaptureOpenshell(["inference", "get"], { ignoreError: true }),
    );
    return Boolean(live && live.provider === provider && live.model === model);
  }

  // eslint-disable-next-line complexity
  async function setupInference(
    sandboxName,
    model,
    provider,
    endpointUrl = null,
    credentialEnv = null,
  ) {
    step(4, 8, "Setting up inference provider");
    runOpenshell(["gateway", "select", GATEWAY_NAME], { ignoreError: true });

    if (
      provider === "nvidia-prod" ||
      provider === "nvidia-nim" ||
      provider === "openai-api" ||
      provider === "anthropic-prod" ||
      provider === "compatible-anthropic-endpoint" ||
      provider === "gemini-api" ||
      provider === "compatible-endpoint"
    ) {
      const config =
        provider === "nvidia-nim"
          ? REMOTE_PROVIDER_CONFIG.build
          : Object.values(REMOTE_PROVIDER_CONFIG).find((entry) => entry.providerName === provider);
      while (true) {
        const resolvedCredentialEnv = credentialEnv || (config && config.credentialEnv);
        const resolvedEndpointUrl = endpointUrl || (config && config.endpointUrl);
        const credentialValue = hydrateCredentialEnv(resolvedCredentialEnv);
        const env =
          resolvedCredentialEnv && credentialValue
            ? { [resolvedCredentialEnv]: credentialValue }
            : {};
        const providerResult = upsertProvider(
          provider,
          config.providerType,
          resolvedCredentialEnv,
          resolvedEndpointUrl,
          env,
        );
        if (!providerResult.ok) {
          console.error(`  ${providerResult.message}`);
          if (isNonInteractive()) {
            process.exit(providerResult.status || 1);
          }
          const retry = await promptValidationRecovery(
            config.label,
            classifyApplyFailure(providerResult.message),
            resolvedCredentialEnv,
            config.helpUrl,
          );
          if (retry === "credential" || retry === "retry") {
            continue;
          }
          if (retry === "selection" || retry === "model") {
            return { retry: "selection" };
          }
          process.exit(providerResult.status || 1);
        }
        const args = ["inference", "set"];
        if (config.skipVerify) {
          args.push("--no-verify");
        }
        args.push("--provider", provider, "--model", model);
        const applyResult = runOpenshell(args, { ignoreError: true });
        if (applyResult.status === 0) {
          break;
        }
        const message =
          compactText(`${applyResult.stderr || ""} ${applyResult.stdout || ""}`) ||
          `Failed to configure inference provider '${provider}'.`;
        console.error(`  ${message}`);
        if (isNonInteractive()) {
          process.exit(applyResult.status || 1);
        }
        const retry = await promptValidationRecovery(
          config.label,
          classifyApplyFailure(message),
          resolvedCredentialEnv,
          config.helpUrl,
        );
        if (retry === "credential" || retry === "retry") {
          continue;
        }
        if (retry === "selection" || retry === "model") {
          return { retry: "selection" };
        }
        process.exit(applyResult.status || 1);
      }
    } else if (provider === "vllm-local") {
      const validation = validateLocalProvider(provider, runCapture);
      if (!validation.ok) {
        console.error(`  ${validation.message}`);
        process.exit(1);
      }
      const baseUrl = getLocalProviderBaseUrl(provider);
      const providerResult = upsertProvider("vllm-local", "openai", "OPENAI_API_KEY", baseUrl, {
        OPENAI_API_KEY: "dummy",
      });
      if (!providerResult.ok) {
        console.error(`  ${providerResult.message}`);
        process.exit(providerResult.status || 1);
      }
      runOpenshell([
        "inference",
        "set",
        "--no-verify",
        "--provider",
        "vllm-local",
        "--model",
        model,
        "--timeout",
        String(LOCAL_INFERENCE_TIMEOUT_SECS),
      ]);
    } else if (provider === "ollama-local") {
      const validation = validateLocalProvider(provider, runCapture);
      if (!validation.ok) {
        console.error(`  ${validation.message}`);
        console.error(
          "  On macOS, local inference also depends on OpenShell host routing support.",
        );
        process.exit(1);
      }
      const baseUrl = getLocalProviderBaseUrl(provider);
      const providerResult = upsertProvider("ollama-local", "openai", "OPENAI_API_KEY", baseUrl, {
        OPENAI_API_KEY: "ollama",
      });
      if (!providerResult.ok) {
        console.error(`  ${providerResult.message}`);
        process.exit(providerResult.status || 1);
      }
      runOpenshell([
        "inference",
        "set",
        "--no-verify",
        "--provider",
        "ollama-local",
        "--model",
        model,
        "--timeout",
        String(LOCAL_INFERENCE_TIMEOUT_SECS),
      ]);
      console.log(`  Priming Ollama model: ${model}`);
      run(getOllamaWarmupCommand(model), { ignoreError: true });
      const probe = validateOllamaModel(model, runCapture);
      if (!probe.ok) {
        console.error(`  ${probe.message}`);
        process.exit(1);
      }
    }

    verifyInferenceRoute(provider, model);
    registry.updateSandbox(sandboxName, { model, provider });
    console.log(`  ✓ Inference route set: ${provider} / ${model}`);
    return { ok: true };
  }

  return {
    buildProviderArgs,
    isInferenceRouteReady,
    providerExistsInGateway,
    setupInference,
    upsertMessagingProviders,
    upsertProvider,
    verifyInferenceRoute,
  };
}
