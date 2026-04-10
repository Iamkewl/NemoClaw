// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

export function createOnboardSelectionHelpers(deps) {
  const {
    ANTHROPIC_ENDPOINT_URL,
    BACK_TO_SELECTION,
    DEFAULT_CLOUD_MODEL,
    EXPERIMENTAL,
    GATEWAY_NAME,
    REMOTE_PROVIDER_CONFIG,
    ROOT,
    ensureApiKey,
    ensureNamedCredential,
    exitOnboardFromPrompt,
    getBootstrapOllamaModelOptions,
    getCredential,
    getDefaultOllamaModel,
    getLocalProviderBaseUrl,
    getLocalProviderValidationBaseUrl,
    getNavigationChoice,
    getOllamaModelOptions,
    getOllamaWarmupCommand,
    isNonInteractive,
    isSafeModelId,
    isWsl,
    nim,
    normalizeProviderBaseUrl,
    note,
    prompt,
    promptCloudModel,
    promptInputModel,
    promptManualModelId,
    promptRemoteModel,
    run,
    runCapture,
    shellQuote,
    shouldRequireResponsesToolCalling,
    shouldSkipResponsesProbe,
    sleep,
    step,
    validateAnthropicModel,
    validateAnthropicSelectionWithRetryMessage,
    validateCustomAnthropicSelection,
    validateCustomOpenAiLikeSelection,
    validateNvidiaApiKeyValue,
    validateOllamaModel,
    validateOpenAiLikeModel,
    validateOpenAiLikeSelection,
  } = deps;

  async function promptOllamaModel(gpu = null) {
    const installed = getOllamaModelOptions(runCapture);
    const options = installed.length > 0 ? installed : getBootstrapOllamaModelOptions(gpu);
    const defaultModel = getDefaultOllamaModel(runCapture, gpu);
    const defaultIndex = Math.max(0, options.indexOf(defaultModel));

    console.log("");
    console.log(installed.length > 0 ? "  Ollama models:" : "  Ollama starter models:");
    options.forEach((option, index) => {
      console.log(`    ${index + 1}) ${option}`);
    });
    console.log(`    ${options.length + 1}) Other...`);
    if (installed.length === 0) {
      console.log("");
      console.log("  No local Ollama models are installed yet. Choose one to pull and load now.");
    }
    console.log("");

    const choice = await prompt(`  Choose model [${defaultIndex + 1}]: `);
    const index = parseInt(choice || String(defaultIndex + 1), 10) - 1;
    if (index >= 0 && index < options.length) {
      return options[index];
    }
    return promptManualModelId("  Ollama model id: ", "Ollama");
  }

  function pullOllamaModel(model) {
    const result = spawnSync("bash", ["-c", `ollama pull ${shellQuote(model)}`], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: "inherit",
      timeout: 600_000,
      env: { ...process.env },
    });
    if (result.signal === "SIGTERM") {
      console.error(
        `  Model pull timed out after 10 minutes. Try a smaller model or check your network connection.`,
      );
      return false;
    }
    return result.status === 0;
  }

  function prepareOllamaModel(model, installedModels = []) {
    const alreadyInstalled = installedModels.includes(model);
    if (!alreadyInstalled) {
      console.log(`  Pulling Ollama model: ${model}`);
      if (!pullOllamaModel(model)) {
        return {
          ok: false,
          message:
            `Failed to pull Ollama model '${model}'. ` +
            "Check the model name and that Ollama can access the registry, then try another model.",
        };
      }
    }

    console.log(`  Loading Ollama model: ${model}`);
    run(getOllamaWarmupCommand(model), { ignoreError: true });
    return validateOllamaModel(model, runCapture);
  }

  function getNonInteractiveProvider() {
    const providerKey = (process.env.NEMOCLAW_PROVIDER || "").trim().toLowerCase();
    if (!providerKey) return null;
    const aliases = {
      cloud: "build",
      nim: "nim-local",
      vllm: "vllm",
      anthropiccompatible: "anthropicCompatible",
    };
    const normalized = aliases[providerKey] || providerKey;
    const validProviders = new Set([
      "build",
      "openai",
      "anthropic",
      "anthropicCompatible",
      "gemini",
      "ollama",
      "custom",
      "nim-local",
      "vllm",
    ]);
    if (!validProviders.has(normalized)) {
      console.error(`  Unsupported NEMOCLAW_PROVIDER: ${providerKey}`);
      console.error(
        "  Valid values: build, openai, anthropic, anthropicCompatible, gemini, ollama, custom, nim-local, vllm",
      );
      process.exit(1);
    }

    return normalized;
  }

  function getNonInteractiveModel(providerKey) {
    const model = (process.env.NEMOCLAW_MODEL || "").trim();
    if (!model) return null;
    if (!isSafeModelId(model)) {
      console.error(`  Invalid NEMOCLAW_MODEL for provider '${providerKey}': ${model}`);
      console.error(
        "  Model values may only contain letters, numbers, '.', '_', ':', '/', and '-'.",
      );
      process.exit(1);
    }
    return model;
  }

  // ── Step 1: Preflight ────────────────────────────────────────────

  // eslint-disable-next-line complexity

  async function setupNim(gpu) {
    step(3, 8, "Configuring inference (NIM)");

    let model = null;
    let provider = REMOTE_PROVIDER_CONFIG.build.providerName;
    let nimContainer = null;
    let endpointUrl = REMOTE_PROVIDER_CONFIG.build.endpointUrl;
    let credentialEnv = REMOTE_PROVIDER_CONFIG.build.credentialEnv;
    let preferredInferenceApi = null;

    // Detect local inference options
    const hasOllama = !!runCapture("command -v ollama", { ignoreError: true });
    const ollamaRunning = !!runCapture("curl -sf http://localhost:11434/api/tags 2>/dev/null", {
      ignoreError: true,
    });
    const vllmRunning = !!runCapture("curl -sf http://localhost:8000/v1/models 2>/dev/null", {
      ignoreError: true,
    });
    const requestedProvider = isNonInteractive() ? getNonInteractiveProvider() : null;
    const requestedModel = isNonInteractive()
      ? getNonInteractiveModel(requestedProvider || "build")
      : null;
    const options = [];
    options.push({ key: "build", label: "NVIDIA Endpoints" });
    options.push({ key: "openai", label: "OpenAI" });
    options.push({ key: "custom", label: "Other OpenAI-compatible endpoint" });
    options.push({ key: "anthropic", label: "Anthropic" });
    options.push({ key: "anthropicCompatible", label: "Other Anthropic-compatible endpoint" });
    options.push({ key: "gemini", label: "Google Gemini" });
    if (hasOllama || ollamaRunning) {
      options.push({
        key: "ollama",
        label:
          `Local Ollama (localhost:11434)${ollamaRunning ? " — running" : ""}` +
          (ollamaRunning ? " (suggested)" : ""),
      });
    }
    if (EXPERIMENTAL && gpu && gpu.nimCapable) {
      options.push({ key: "nim-local", label: "Local NVIDIA NIM [experimental]" });
    }
    if (EXPERIMENTAL && vllmRunning) {
      options.push({
        key: "vllm",
        label: "Local vLLM [experimental] — running",
      });
    }
    // On macOS without Ollama, offer to install it
    if (!hasOllama && process.platform === "darwin") {
      options.push({ key: "install-ollama", label: "Install Ollama (macOS)" });
    }

    if (options.length > 1) {
      selectionLoop: while (true) {
        let selected;

        if (isNonInteractive()) {
          const providerKey = requestedProvider || "build";
          selected = options.find((o) => o.key === providerKey);
          if (!selected) {
            console.error(
              `  Requested provider '${providerKey}' is not available in this environment.`,
            );
            process.exit(1);
          }
          note(`  [non-interactive] Provider: ${selected.key}`);
        } else {
          const suggestions = [];
          if (vllmRunning) suggestions.push("vLLM");
          if (ollamaRunning) suggestions.push("Ollama");
          if (suggestions.length > 0) {
            console.log(
              `  Detected local inference option${suggestions.length > 1 ? "s" : ""}: ${suggestions.join(", ")}`,
            );
            console.log("");
          }

          console.log("");
          console.log("  Inference options:");
          options.forEach((o, i) => {
            console.log(`    ${i + 1}) ${o.label}`);
          });
          console.log("");

          const defaultIdx = options.findIndex((o) => o.key === "build") + 1;
          const choice = await prompt(`  Choose [${defaultIdx}]: `);
          const idx = parseInt(choice || String(defaultIdx), 10) - 1;
          selected = options[idx] || options[defaultIdx - 1];
        }

        if (REMOTE_PROVIDER_CONFIG[selected.key]) {
          const remoteConfig = REMOTE_PROVIDER_CONFIG[selected.key];
          provider = remoteConfig.providerName;
          credentialEnv = remoteConfig.credentialEnv;
          endpointUrl = remoteConfig.endpointUrl;
          preferredInferenceApi = null;

          if (selected.key === "custom") {
            const endpointInput = isNonInteractive()
              ? (process.env.NEMOCLAW_ENDPOINT_URL || "").trim()
              : await prompt("  OpenAI-compatible base URL (e.g., https://openrouter.ai): ");
            const navigation = getNavigationChoice(endpointInput);
            if (navigation === "back") {
              console.log("  Returning to provider selection.");
              console.log("");
              continue selectionLoop;
            }
            if (navigation === "exit") {
              exitOnboardFromPrompt();
            }
            endpointUrl = normalizeProviderBaseUrl(endpointInput, "openai");
            if (!endpointUrl) {
              console.error("  Endpoint URL is required for Other OpenAI-compatible endpoint.");
              if (isNonInteractive()) {
                process.exit(1);
              }
              console.log("");
              continue selectionLoop;
            }
          } else if (selected.key === "anthropicCompatible") {
            const endpointInput = isNonInteractive()
              ? (process.env.NEMOCLAW_ENDPOINT_URL || "").trim()
              : await prompt("  Anthropic-compatible base URL (e.g., https://proxy.example.com): ");
            const navigation = getNavigationChoice(endpointInput);
            if (navigation === "back") {
              console.log("  Returning to provider selection.");
              console.log("");
              continue selectionLoop;
            }
            if (navigation === "exit") {
              exitOnboardFromPrompt();
            }
            endpointUrl = normalizeProviderBaseUrl(endpointInput, "anthropic");
            if (!endpointUrl) {
              console.error("  Endpoint URL is required for Other Anthropic-compatible endpoint.");
              if (isNonInteractive()) {
                process.exit(1);
              }
              console.log("");
              continue selectionLoop;
            }
          }

          if (selected.key === "build") {
            if (isNonInteractive()) {
              if (!process.env.NVIDIA_API_KEY) {
                console.error(
                  "  NVIDIA_API_KEY is required for NVIDIA Endpoints in non-interactive mode.",
                );
                process.exit(1);
              }
              const keyError = validateNvidiaApiKeyValue(process.env.NVIDIA_API_KEY);
              if (keyError) {
                console.error(keyError);
                console.error(`  Get a key from ${REMOTE_PROVIDER_CONFIG.build.helpUrl}`);
                process.exit(1);
              }
            } else {
              await ensureApiKey();
            }
            model =
              requestedModel ||
              (isNonInteractive() ? DEFAULT_CLOUD_MODEL : await promptCloudModel()) ||
              DEFAULT_CLOUD_MODEL;
            if (model === BACK_TO_SELECTION) {
              console.log("  Returning to provider selection.");
              console.log("");
              continue selectionLoop;
            }
          } else {
            if (isNonInteractive()) {
              if (!process.env[credentialEnv]) {
                console.error(
                  `  ${credentialEnv} is required for ${remoteConfig.label} in non-interactive mode.`,
                );
                process.exit(1);
              }
            } else {
              await ensureNamedCredential(
                credentialEnv,
                remoteConfig.label + " API key",
                remoteConfig.helpUrl,
              );
            }
            const defaultModel = requestedModel || remoteConfig.defaultModel;
            let modelValidator = null;
            if (selected.key === "openai" || selected.key === "gemini") {
              modelValidator = (candidate) =>
                validateOpenAiLikeModel(
                  remoteConfig.label,
                  endpointUrl,
                  candidate,
                  getCredential(credentialEnv),
                );
            } else if (selected.key === "anthropic") {
              modelValidator = (candidate) =>
                validateAnthropicModel(
                  endpointUrl || ANTHROPIC_ENDPOINT_URL,
                  candidate,
                  getCredential(credentialEnv),
                );
            }
            while (true) {
              if (isNonInteractive()) {
                model = defaultModel;
              } else if (remoteConfig.modelMode === "curated") {
                model = await promptRemoteModel(
                  remoteConfig.label,
                  selected.key,
                  defaultModel,
                  modelValidator,
                );
              } else {
                model = await promptInputModel(remoteConfig.label, defaultModel, modelValidator);
              }
              if (model === BACK_TO_SELECTION) {
                console.log("  Returning to provider selection.");
                console.log("");
                continue selectionLoop;
              }

              if (selected.key === "custom") {
                const validation = await validateCustomOpenAiLikeSelection(
                  remoteConfig.label,
                  endpointUrl,
                  model,
                  credentialEnv,
                  remoteConfig.helpUrl,
                );
                if (validation.ok) {
                  preferredInferenceApi = validation.api;
                  break;
                }
                if (
                  validation.retry === "credential" ||
                  validation.retry === "retry" ||
                  validation.retry === "model"
                ) {
                  continue;
                }
                if (validation.retry === "selection") {
                  continue selectionLoop;
                }
              } else if (selected.key === "anthropicCompatible") {
                const validation = await validateCustomAnthropicSelection(
                  remoteConfig.label,
                  endpointUrl || ANTHROPIC_ENDPOINT_URL,
                  model,
                  credentialEnv,
                  remoteConfig.helpUrl,
                );
                if (validation.ok) {
                  preferredInferenceApi = validation.api;
                  break;
                }
                if (
                  validation.retry === "credential" ||
                  validation.retry === "retry" ||
                  validation.retry === "model"
                ) {
                  continue;
                }
                if (validation.retry === "selection") {
                  continue selectionLoop;
                }
              } else {
                const retryMessage = "Please choose a provider/model again.";
                if (selected.key === "anthropic") {
                  const validation = await validateAnthropicSelectionWithRetryMessage(
                    remoteConfig.label,
                    endpointUrl || ANTHROPIC_ENDPOINT_URL,
                    model,
                    credentialEnv,
                    retryMessage,
                    remoteConfig.helpUrl,
                  );
                  if (validation.ok) {
                    preferredInferenceApi = validation.api;
                    break;
                  }
                  if (
                    validation.retry === "credential" ||
                    validation.retry === "retry" ||
                    validation.retry === "model"
                  ) {
                    continue;
                  }
                } else {
                  const validation = await validateOpenAiLikeSelection(
                    remoteConfig.label,
                    endpointUrl,
                    model,
                    credentialEnv,
                    retryMessage,
                    remoteConfig.helpUrl,
                    {
                      requireResponsesToolCalling: shouldRequireResponsesToolCalling(provider),
                      skipResponsesProbe: shouldSkipResponsesProbe(provider),
                    },
                  );
                  if (validation.ok) {
                    preferredInferenceApi = validation.api;
                    break;
                  }
                  if (
                    validation.retry === "credential" ||
                    validation.retry === "retry" ||
                    validation.retry === "model"
                  ) {
                    continue;
                  }
                }
                continue selectionLoop;
              }
            }
          }

          if (selected.key === "build") {
            while (true) {
              const validation = await validateOpenAiLikeSelection(
                remoteConfig.label,
                endpointUrl,
                model,
                credentialEnv,
                "Please choose a provider/model again.",
                remoteConfig.helpUrl,
                {
                  requireResponsesToolCalling: shouldRequireResponsesToolCalling(provider),
                  skipResponsesProbe: shouldSkipResponsesProbe(provider),
                },
              );
              if (validation.ok) {
                preferredInferenceApi = validation.api;
                break;
              }
              if (validation.retry === "credential" || validation.retry === "retry") {
                continue;
              }
              continue selectionLoop;
            }
          }

          console.log(`  Using ${remoteConfig.label} with model: ${model}`);
          break;
        } else if (selected.key === "nim-local") {
          // List models that fit GPU VRAM
          const models = nim.listModels().filter((m) => m.minGpuMemoryMB <= gpu.totalMemoryMB);
          if (models.length === 0) {
            console.log("  No NIM models fit your GPU VRAM. Falling back to cloud API.");
          } else {
            let sel;
            if (isNonInteractive()) {
              if (requestedModel) {
                sel = models.find((m) => m.name === requestedModel);
                if (!sel) {
                  console.error(`  Unsupported NEMOCLAW_MODEL for NIM: ${requestedModel}`);
                  process.exit(1);
                }
              } else {
                sel = models[0];
              }
              note(`  [non-interactive] NIM model: ${sel.name}`);
            } else {
              console.log("");
              console.log("  Models that fit your GPU:");
              models.forEach((m, i) => {
                console.log(`    ${i + 1}) ${m.name} (min ${m.minGpuMemoryMB} MB)`);
              });
              console.log("");

              const modelChoice = await prompt(`  Choose model [1]: `);
              const midx = parseInt(modelChoice || "1", 10) - 1;
              sel = models[midx] || models[0];
            }
            model = sel.name;

            console.log(`  Pulling NIM image for ${model}...`);
            nim.pullNimImage(model);

            console.log("  Starting NIM container...");
            nimContainer = nim.startNimContainerByName(nim.containerName(GATEWAY_NAME), model);

            console.log("  Waiting for NIM to become healthy...");
            if (!nim.waitForNimHealth()) {
              console.error("  NIM failed to start. Falling back to cloud API.");
              model = null;
              nimContainer = null;
            } else {
              provider = "vllm-local";
              credentialEnv = "OPENAI_API_KEY";
              endpointUrl = getLocalProviderBaseUrl(provider);
              const validation = await validateOpenAiLikeSelection(
                "Local NVIDIA NIM",
                endpointUrl,
                model,
                credentialEnv,
              );
              if (
                validation.retry === "selection" ||
                validation.retry === "back" ||
                validation.retry === "model"
              ) {
                continue selectionLoop;
              }
              if (!validation.ok) {
                continue selectionLoop;
              }
              preferredInferenceApi = validation.api;
              // NIM uses vLLM internally — same tool-call-parser limitation
              // applies to /v1/responses. Force chat completions.
              if (preferredInferenceApi !== "openai-completions") {
                console.log(
                  "  ℹ Using chat completions API (tool-call-parser requires /v1/chat/completions)",
                );
              }
              preferredInferenceApi = "openai-completions";
            }
          }
          break;
        } else if (selected.key === "ollama") {
          if (!ollamaRunning) {
            console.log("  Starting Ollama...");
            // On WSL2, binding to 0.0.0.0 creates a dual-stack socket that Docker
            // cannot reach via host-gateway. The default 127.0.0.1 binding works
            // because WSL2 relays IPv4-only sockets to the Windows host.
            const ollamaEnv = isWsl() ? "" : "OLLAMA_HOST=0.0.0.0:11434 ";
            run(`${ollamaEnv}ollama serve > /dev/null 2>&1 &`, { ignoreError: true });
            sleep(2);
          }
          console.log("  ✓ Using Ollama on localhost:11434");
          provider = "ollama-local";
          credentialEnv = "OPENAI_API_KEY";
          endpointUrl = getLocalProviderBaseUrl(provider);
          while (true) {
            const installedModels = getOllamaModelOptions(runCapture);
            if (isNonInteractive()) {
              model = requestedModel || getDefaultOllamaModel(runCapture, gpu);
            } else {
              model = await promptOllamaModel(gpu);
            }
            if (model === BACK_TO_SELECTION) {
              console.log("  Returning to provider selection.");
              console.log("");
              continue selectionLoop;
            }
            const probe = prepareOllamaModel(model, installedModels);
            if (!probe.ok) {
              console.error(`  ${probe.message}`);
              if (isNonInteractive()) {
                process.exit(1);
              }
              console.log("  Choose a different Ollama model or select Other.");
              console.log("");
              continue;
            }
            const validation = await validateOpenAiLikeSelection(
              "Local Ollama",
              getLocalProviderValidationBaseUrl(provider),
              model,
              null,
              "Choose a different Ollama model or select Other.",
            );
            if (validation.retry === "selection" || validation.retry === "back") {
              continue selectionLoop;
            }
            if (!validation.ok) {
              continue;
            }
            // Ollama's /v1/responses endpoint does not produce correctly
            // formatted tool calls — force chat completions like vLLM/NIM.
            if (validation.api !== "openai-completions") {
              console.log(
                "  ℹ Using chat completions API (Ollama tool calls require /v1/chat/completions)",
              );
            }
            preferredInferenceApi = "openai-completions";
            break;
          }
          break;
        } else if (selected.key === "install-ollama") {
          // macOS only — this option is gated by process.platform === "darwin" above
          console.log("  Installing Ollama via Homebrew...");
          run("brew install ollama", { ignoreError: true });
          console.log("  Starting Ollama...");
          run("OLLAMA_HOST=0.0.0.0:11434 ollama serve > /dev/null 2>&1 &", { ignoreError: true });
          sleep(2);
          console.log("  ✓ Using Ollama on localhost:11434");
          provider = "ollama-local";
          credentialEnv = "OPENAI_API_KEY";
          endpointUrl = getLocalProviderBaseUrl(provider);
          while (true) {
            const installedModels = getOllamaModelOptions(runCapture);
            if (isNonInteractive()) {
              model = requestedModel || getDefaultOllamaModel(runCapture, gpu);
            } else {
              model = await promptOllamaModel(gpu);
            }
            if (model === BACK_TO_SELECTION) {
              console.log("  Returning to provider selection.");
              console.log("");
              continue selectionLoop;
            }
            const probe = prepareOllamaModel(model, installedModels);
            if (!probe.ok) {
              console.error(`  ${probe.message}`);
              if (isNonInteractive()) {
                process.exit(1);
              }
              console.log("  Choose a different Ollama model or select Other.");
              console.log("");
              continue;
            }
            const validation = await validateOpenAiLikeSelection(
              "Local Ollama",
              getLocalProviderValidationBaseUrl(provider),
              model,
              null,
              "Choose a different Ollama model or select Other.",
            );
            if (validation.retry === "selection" || validation.retry === "back") {
              continue selectionLoop;
            }
            if (!validation.ok) {
              continue;
            }
            // Ollama's /v1/responses endpoint does not produce correctly
            // formatted tool calls — force chat completions like vLLM/NIM.
            if (validation.api !== "openai-completions") {
              console.log(
                "  ℹ Using chat completions API (Ollama tool calls require /v1/chat/completions)",
              );
            }
            preferredInferenceApi = "openai-completions";
            break;
          }
          break;
        } else if (selected.key === "vllm") {
          console.log("  ✓ Using existing vLLM on localhost:8000");
          provider = "vllm-local";
          credentialEnv = "OPENAI_API_KEY";
          endpointUrl = getLocalProviderBaseUrl(provider);
          // Query vLLM for the actual model ID
          const vllmModelsRaw = runCapture("curl -sf http://localhost:8000/v1/models 2>/dev/null", {
            ignoreError: true,
          });
          try {
            const vllmModels = JSON.parse(vllmModelsRaw);
            if (vllmModels.data && vllmModels.data.length > 0) {
              model = vllmModels.data[0].id;
              if (!isSafeModelId(model)) {
                console.error(`  Detected model ID contains invalid characters: ${model}`);
                process.exit(1);
              }
              console.log(`  Detected model: ${model}`);
            } else {
              console.error("  Could not detect model from vLLM. Please specify manually.");
              process.exit(1);
            }
          } catch {
            console.error(
              "  Could not query vLLM models endpoint. Is vLLM running on localhost:8000?",
            );
            process.exit(1);
          }
          const validation = await validateOpenAiLikeSelection(
            "Local vLLM",
            getLocalProviderValidationBaseUrl(provider),
            model,
            credentialEnv,
          );
          if (
            validation.retry === "selection" ||
            validation.retry === "back" ||
            validation.retry === "model"
          ) {
            continue selectionLoop;
          }
          if (!validation.ok) {
            continue selectionLoop;
          }
          preferredInferenceApi = validation.api;
          // Force chat completions — vLLM's /v1/responses endpoint does not
          // run the --tool-call-parser, so tool calls arrive as raw text.
          // See: https://github.com/NVIDIA/NemoClaw/issues/976
          if (preferredInferenceApi !== "openai-completions") {
            console.log(
              "  ℹ Using chat completions API (tool-call-parser requires /v1/chat/completions)",
            );
          }
          preferredInferenceApi = "openai-completions";
          break;
        }
      }
    }

    return { model, provider, endpointUrl, credentialEnv, preferredInferenceApi, nimContainer };
  }

  return {
    getNonInteractiveModel,
    getNonInteractiveProvider,
    prepareOllamaModel,
    promptOllamaModel,
    pullOllamaModel,
    setupNim,
  };
}
