// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Interactive onboarding wizard — 8 steps from zero to running sandbox.
// Supports non-interactive mode via --non-interactive flag or
// NEMOCLAW_NON_INTERACTIVE=1 env var for CI/CD pipelines.

const fs = require("fs");
const os = require("os");
const path = require("path");

/** Parse a numeric env var, returning `fallback` when unset or non-finite. */
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : fallback;
}

/** Inference timeout (seconds) for local providers (Ollama, vLLM, NIM). */
const LOCAL_INFERENCE_TIMEOUT_SECS = envInt("NEMOCLAW_LOCAL_INFERENCE_TIMEOUT", 180);
const { ROOT, SCRIPTS, redact, run, runCapture, shellQuote } = require("./runner");
const { stageOptimizedSandboxBuildContext } = require("./sandbox-build-context");
const {
  getDefaultOllamaModel,
  getBootstrapOllamaModelOptions,
  getLocalProviderBaseUrl,
  getLocalProviderValidationBaseUrl,
  getOllamaModelOptions,
  getOllamaWarmupCommand,
  validateOllamaModel,
  validateLocalProvider,
} = require("./local-inference");
const {
  DEFAULT_CLOUD_MODEL,
  getProviderSelectionConfig,
  parseGatewayInference,
} = require("./inference-config");
const { inferContainerRuntime, isWsl, shouldPatchCoredns } = require("./platform");
const { resolveOpenshell } = require("./resolve-openshell");
const {
  prompt,
  ensureApiKey,
  getCredential,
  normalizeCredentialValue,
  saveCredential,
} = require("./credentials");
const registry = require("./registry");
const nim = require("./nim");
const onboardSession = require("./onboard-session");
const policies = require("./policies");
const { ensureUsageNoticeConsent } = require("./usage-notice");
const {
  assessHost,
  checkPortAvailable,
  ensureSwap,
  getMemoryInfo,
  planHostRemediation,
} = require("./preflight");
const agentOnboard = require("./agent-onboard");

const gatewayState = require("./gateway-state");
const validation = require("./validation");
const urlUtils = require("./url-utils");
const buildContext = require("./build-context");
const dashboard = require("./dashboard");
const httpProbe = require("./http-probe");
const modelPrompts = require("./model-prompts");
const providerModels = require("./provider-models");
const sandboxCreateStream = require("./sandbox-create-stream");
const validationRecovery = require("./validation-recovery");
const webSearch = require("./web-search");
const { createOnboardDashboardHelpers } = require("./onboard-dashboard");
const { createOnboardPolicyHelpers } = require("./onboard-policies");
const { createOnboardGatewayHelpers } = require("./onboard-gateway");
const { createOnboardImageConfigHelpers } = require("./onboard-image-config");
const { createOnboardMessagingHelpers } = require("./onboard-messaging");
const { createOnboardOpenclawHelpers } = require("./onboard-openclaw");
const { createOnboardProviderHelpers } = require("./onboard-provider");
const { createOnboardProviderValidationHelpers } = require("./onboard-provider-validation");
const { createOnboardSandboxHelpers } = require("./onboard-sandbox");
const { createOnboardSelectionHelpers } = require("./onboard-selection");
const { createOnboardRuntimeHelpers } = require("./onboard-runtime");
const { createOnboardSharedHelpers } = require("./onboard-shared");
const { createOnboardWebSearchHelpers } = require("./onboard-web-search");

const EXPERIMENTAL = process.env.NEMOCLAW_EXPERIMENTAL === "1";
const USE_COLOR = !process.env.NO_COLOR && !!process.stdout.isTTY;
const DIM = USE_COLOR ? "\x1b[2m" : "";
const RESET = USE_COLOR ? "\x1b[0m" : "";
let OPENSHELL_BIN = null;
const GATEWAY_NAME = "nemoclaw";
const BACK_TO_SELECTION = "__NEMOCLAW_BACK_TO_SELECTION__";
const OPENCLAW_LAUNCH_AGENT_PLIST = "~/Library/LaunchAgents/ai.openclaw.gateway.plist";

const BUILD_ENDPOINT_URL = "https://integrate.api.nvidia.com/v1";
const OPENAI_ENDPOINT_URL = "https://api.openai.com/v1";
const ANTHROPIC_ENDPOINT_URL = "https://api.anthropic.com";
const GEMINI_ENDPOINT_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
const BRAVE_SEARCH_HELP_URL = "https://brave.com/search/api/";

const REMOTE_PROVIDER_CONFIG = {
  build: {
    label: "NVIDIA Endpoints",
    providerName: "nvidia-prod",
    providerType: "nvidia",
    credentialEnv: "NVIDIA_API_KEY",
    endpointUrl: BUILD_ENDPOINT_URL,
    helpUrl: "https://build.nvidia.com/settings/api-keys",
    modelMode: "catalog",
    defaultModel: DEFAULT_CLOUD_MODEL,
    skipVerify: true,
  },
  openai: {
    label: "OpenAI",
    providerName: "openai-api",
    providerType: "openai",
    credentialEnv: "OPENAI_API_KEY",
    endpointUrl: OPENAI_ENDPOINT_URL,
    helpUrl: "https://platform.openai.com/api-keys",
    modelMode: "curated",
    defaultModel: "gpt-5.4",
    skipVerify: true,
  },
  anthropic: {
    label: "Anthropic",
    providerName: "anthropic-prod",
    providerType: "anthropic",
    credentialEnv: "ANTHROPIC_API_KEY",
    endpointUrl: ANTHROPIC_ENDPOINT_URL,
    helpUrl: "https://console.anthropic.com/settings/keys",
    modelMode: "curated",
    defaultModel: "claude-sonnet-4-6",
  },
  anthropicCompatible: {
    label: "Other Anthropic-compatible endpoint",
    providerName: "compatible-anthropic-endpoint",
    providerType: "anthropic",
    credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
    endpointUrl: "",
    helpUrl: null,
    modelMode: "input",
    defaultModel: "",
  },
  gemini: {
    label: "Google Gemini",
    providerName: "gemini-api",
    providerType: "openai",
    credentialEnv: "GEMINI_API_KEY",
    endpointUrl: GEMINI_ENDPOINT_URL,
    helpUrl: "https://aistudio.google.com/app/apikey",
    modelMode: "curated",
    defaultModel: "gemini-2.5-flash",
    skipVerify: true,
  },
  custom: {
    label: "Other OpenAI-compatible endpoint",
    providerName: "compatible-endpoint",
    providerType: "openai",
    credentialEnv: "COMPATIBLE_API_KEY",
    endpointUrl: "",
    helpUrl: null,
    modelMode: "input",
    defaultModel: "",
    skipVerify: true,
  },
};

const DISCORD_SNOWFLAKE_RE = /^[0-9]{17,19}$/;

// Non-interactive mode: set by --non-interactive flag or env var.
// When active, all prompts use env var overrides or sensible defaults.
let NON_INTERACTIVE = false;
let RECREATE_SANDBOX = false;

const {
  cleanupTempDir,
  encodeDockerJsonArg,
  exitOnboardFromPrompt,
  getNavigationChoice,
  getRequestedModelHint,
  getRequestedProviderHint,
  getRequestedSandboxNameHint,
  getResumeConfigConflicts,
  getResumeSandboxConflict,
  hydrateCredentialEnv,
  isAffirmativeAnswer,
  isNonInteractive,
  isRecreateSandbox,
  note,
  promptOrDefault,
  secureTempFile,
  skippedStepMessage,
  startRecordedStep,
  step,
} = createOnboardSharedHelpers({
  DIM,
  RESET,
  getCredential,
  getNonInteractiveFlag: () => NON_INTERACTIVE,
  getRecreateSandboxFlag: () => RECREATE_SANDBOX,
  onboardSession,
  prompt,
});

// ── Helpers ──────────────────────────────────────────────────────

// Gateway state functions — delegated to src/lib/gateway-state.ts
const {
  isSandboxReady,
  hasStaleGateway,
  isSelectedGateway,
  isGatewayHealthy,
  getGatewayReuseState,
  getSandboxStateFromOutputs,
} = gatewayState;

/**
 * Remove known_hosts lines whose host field contains an openshell-* entry.
 * Preserves blank lines and comments. Returns the cleaned string.
 */
const { streamSandboxCreate } = sandboxCreateStream;

const {
  getBlueprintMinOpenshellVersion,
  getContainerRuntime,
  getFutureShellPathHint,
  getInstalledOpenshellVersion,
  getOpenshellBinary,
  getPortConflictServiceHints,
  getStableGatewayImageRef,
  installOpenshell,
  isOpenshellInstalled,
  openshellShellCommand,
  preflight,
  printRemediationActions,
  runCaptureOpenshell,
  runOpenshell,
  sleep,
  versionGte,
} = createOnboardRuntimeHelpers({
  GATEWAY_NAME,
  OPENCLAW_LAUNCH_AGENT_PLIST,
  ROOT,
  SCRIPTS,
  assessHost,
  checkPortAvailable,
  ensureSwap,
  getGatewayReuseState,
  getMemoryInfo,
  getOpenshellBin: () => OPENSHELL_BIN,
  inferContainerRuntime,
  isNonInteractive,
  nim,
  planHostRemediation,
  prompt,
  registry,
  resolveOpenshell,
  run,
  runCapture,
  setOpenshellBin: (value) => {
    OPENSHELL_BIN = value;
  },
  shellQuote,
  step,
});

// URL/string utilities — delegated to src/lib/url-utils.ts
const {
  compactText,
  normalizeProviderBaseUrl,
  isLoopbackHostname,
  formatEnvAssignment,
  parsePolicyPresetEnv,
} = urlUtils;
const { getCurlTimingArgs, summarizeCurlFailure, summarizeProbeFailure, runCurlProbe } = httpProbe;

const { getTransportRecoveryMessage, getProbeRecovery } = validationRecovery;

// Validation functions — delegated to src/lib/validation.ts
const {
  classifyValidationFailure,
  classifyApplyFailure,
  classifySandboxCreateFailure,
  validateNvidiaApiKeyValue,
  isSafeModelId,
  isNvcfFunctionNotFoundForAccount,
  nvcfFunctionNotFoundMessage,
  shouldSkipResponsesProbe,
} = validation;

// validateNvidiaApiKeyValue — see validation import above

async function replaceNamedCredential(envName, label, helpUrl = null, validator = null) {
  if (helpUrl) {
    console.log("");
    console.log(`  Get your ${label} from: ${helpUrl}`);
    console.log("");
  }

  while (true) {
    const key = normalizeCredentialValue(await prompt(`  ${label}: `, { secret: true }));
    if (!key) {
      console.error(`  ${label} is required.`);
      continue;
    }
    const validationError = typeof validator === "function" ? validator(key) : null;
    if (validationError) {
      console.error(validationError);
      continue;
    }
    saveCredential(envName, key);
    process.env[envName] = key;
    console.log("");
    console.log(`  Key saved to ~/.nemoclaw/credentials.json (mode 600)`);
    console.log("");
    return key;
  }
}

async function promptValidationRecovery(label, recovery, credentialEnv = null, helpUrl = null) {
  if (isNonInteractive()) {
    process.exit(1);
  }

  if (recovery.kind === "credential" && credentialEnv) {
    console.log(
      `  ${label} authorization failed. Re-enter the API key or choose a different provider/model.`,
    );
    const choice = (await prompt("  Type 'retry', 'back', or 'exit' [retry]: ", { secret: true }))
      .trim()
      .toLowerCase();
    if (choice === "back") {
      console.log("  Returning to provider selection.");
      console.log("");
      return "selection";
    }
    if (choice === "exit" || choice === "quit") {
      exitOnboardFromPrompt();
    }
    if (choice === "" || choice === "retry") {
      const validator = credentialEnv === "NVIDIA_API_KEY" ? validateNvidiaApiKeyValue : null;
      await replaceNamedCredential(credentialEnv, `${label} API key`, helpUrl, validator);
      return "credential";
    }
    console.log("  Please choose a provider/model again.");
    console.log("");
    return "selection";
  }

  if (recovery.kind === "transport") {
    console.log(getTransportRecoveryMessage(recovery.failure || {}));
    const choice = (await prompt("  Type 'retry', 'back', or 'exit' [retry]: "))
      .trim()
      .toLowerCase();
    if (choice === "back") {
      console.log("  Returning to provider selection.");
      console.log("");
      return "selection";
    }
    if (choice === "exit" || choice === "quit") {
      exitOnboardFromPrompt();
    }
    if (choice === "" || choice === "retry") {
      console.log("");
      return "retry";
    }
    console.log("  Please choose a provider/model again.");
    console.log("");
    return "selection";
  }

  if (recovery.kind === "model") {
    console.log(`  Please enter a different ${label} model name.`);
    console.log("");
    return "model";
  }

  console.log("  Please choose a provider/model again.");
  console.log("");
  return "selection";
}

/**
 * Build the argument array for an `openshell provider create` or `update` command.
 * @param {"create"|"update"} action - Whether to create or update.
 * @param {string} name - Provider name.
 * @param {string} type - Provider type (e.g. "openai", "anthropic", "generic").
 * @param {string} credentialEnv - Credential environment variable name.
 * @param {string|null} baseUrl - Optional base URL for API-compatible endpoints.
 * @returns {string[]} Argument array for runOpenshell().
 */
const {
  buildProviderArgs,
  isInferenceRouteReady,
  providerExistsInGateway,
  setupInference,
  upsertMessagingProviders,
  upsertProvider,
  verifyInferenceRoute,
} = createOnboardProviderHelpers({
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
});

const {
  configureWebSearch,
  ensureValidatedBraveSearchCredential,
  printBraveExposureWarning,
  promptBraveSearchApiKey,
  promptBraveSearchRecovery,
  validateBraveSearchApiKey,
} = createOnboardWebSearchHelpers({
  BRAVE_SEARCH_HELP_URL,
  classifyValidationFailure,
  exitOnboardFromPrompt,
  getCredential,
  getTransportRecoveryMessage,
  isAffirmativeAnswer,
  isNonInteractive,
  normalizeCredentialValue,
  note,
  prompt,
  runCurlProbe,
  saveCredential,
  webSearch,
});

const { getSandboxInferenceConfig, patchStagedDockerfile } = createOnboardImageConfigHelpers({
  encodeDockerJsonArg,
  getCredential,
  webSearch,
});

const {
  getValidationProbeCurlArgs,
  hasResponsesToolCall,
  parseJsonObject,
  probeAnthropicEndpoint,
  probeOpenAiLikeEndpoint,
  probeResponsesToolCalling,
  shouldRequireResponsesToolCalling,
  validateAnthropicSelectionWithRetryMessage,
  validateCustomAnthropicSelection,
  validateCustomOpenAiLikeSelection,
  validateOpenAiLikeSelection,
} = createOnboardProviderValidationHelpers({
  getCredential,
  getCurlTimingArgs,
  getProbeRecovery,
  isNonInteractive,
  isNvcfFunctionNotFoundForAccount,
  normalizeCredentialValue,
  nvcfFunctionNotFoundMessage,
  promptValidationRecovery,
  runCurlProbe,
});

// shouldSkipResponsesProbe and isNvcfFunctionNotFoundForAccount /
// nvcfFunctionNotFoundMessage — see validation import above. They live in
// src/lib/validation.ts so they can be unit-tested independently.

const { promptManualModelId, promptCloudModel, promptRemoteModel, promptInputModel } = modelPrompts;
const { validateAnthropicModel, validateOpenAiLikeModel } = providerModels;

// Build context helpers — delegated to src/lib/build-context.ts
const { shouldIncludeBuildContextPath, copyBuildContextDir, printSandboxCreateRecoveryHints } =
  buildContext;
// classifySandboxCreateFailure — see validation import above

const {
  destroyGateway,
  getGatewayStartEnv,
  pruneKnownHostsEntries,
  recoverGatewayRuntime,
  startGateway,
  startGatewayForRecovery,
  startGatewayWithOptions,
  streamGatewayStart,
} = createOnboardGatewayHelpers({
  GATEWAY_NAME,
  ROOT,
  SCRIPTS,
  compactText,
  envInt,
  getContainerRuntime,
  getInstalledOpenshellVersion,
  hasStaleGateway,
  isGatewayHealthy,
  isSelectedGateway,
  openshellShellCommand,
  redact,
  registry,
  run,
  runCaptureOpenshell,
  runOpenshell,
  shouldPatchCoredns,
  sleep,
  step,
});

async function ensureNamedCredential(envName, label, helpUrl = null) {
  let key = getCredential(envName);
  if (key) {
    process.env[envName] = key;
    return key;
  }
  return replaceNamedCredential(envName, label, helpUrl);
}

// parsePolicyPresetEnv — see urlUtils import above
// isSafeModelId — see validation import above

const {
  getNonInteractiveModel,
  getNonInteractiveProvider,
  prepareOllamaModel,
  promptOllamaModel,
  pullOllamaModel,
  setupNim,
} = createOnboardSelectionHelpers({
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
});

// ── Step 1: Preflight ────────────────────────────────────────────

// eslint-disable-next-line complexity
// ── Step 2: Gateway ──────────────────────────────────────────────

// ── Step 3: Inference selection ──────────────────────────────────

// eslint-disable-next-line complexity
// ── Step 4: Inference provider ───────────────────────────────────

// ── Step 6: Messaging channels ───────────────────────────────────

const { MESSAGING_CHANNELS, setupMessagingChannels } = createOnboardMessagingHelpers({
  getCredential,
  isNonInteractive,
  normalizeCredentialValue,
  note,
  prompt,
  saveCredential,
  step,
});

// ── Step 7: OpenClaw ─────────────────────────────────────────────

// ── Dashboard ────────────────────────────────────────────────────

const CONTROL_UI_PORT = 18789;

// Dashboard helpers — delegated to src/lib/dashboard.ts
// isLoopbackHostname — see urlUtils import above
const { resolveDashboardForwardTarget, buildControlUiUrls } = dashboard;
const {
  ensureDashboardForward,
  fetchGatewayAuthTokenFromSandbox,
  findOpenclawJsonPath,
  printDashboard,
} = createOnboardDashboardHelpers({
  agentOnboard,
  buildControlUiUrls,
  controlUiPort: CONTROL_UI_PORT,
  nim,
  note,
  resolveDashboardForwardTarget,
  runOpenshell,
});

const {
  buildSandboxConfigSyncScript,
  createSandbox,
  getSandboxReuseState,
  isOpenclawReady,
  pruneStaleSandboxEntry,
  promptValidatedSandboxName,
  repairRecordedSandbox,
  waitForSandboxReady,
  writeSandboxConfigSyncFile,
} = createOnboardSandboxHelpers({
  CONTROL_UI_PORT,
  DISCORD_SNOWFLAKE_RE,
  GATEWAY_NAME,
  ROOT,
  SCRIPTS,
  MESSAGING_CHANNELS,
  REMOTE_PROVIDER_CONFIG,
  agentOnboard,
  classifySandboxCreateFailure,
  ensureDashboardForward,
  fetchGatewayAuthTokenFromSandbox,
  formatEnvAssignment,
  getCredential,
  getSandboxStateFromOutputs,
  isNonInteractive,
  isRecreateSandbox,
  isSandboxReady,
  normalizeCredentialValue,
  note,
  openshellShellCommand,
  patchStagedDockerfile,
  printSandboxCreateRecoveryHints,
  promptOrDefault,
  providerExistsInGateway,
  registry,
  run,
  runCapture,
  runCaptureOpenshell,
  runOpenshell,
  secureTempFile,
  shellQuote,
  sleep,
  stageOptimizedSandboxBuildContext,
  step,
  streamSandboxCreate,
  upsertMessagingProviders,
  webSearch,
});

const { setupOpenclaw } = createOnboardOpenclawHelpers({
  buildSandboxConfigSyncScript,
  cleanupTempDir,
  getProviderSelectionConfig,
  openshellShellCommand,
  run,
  shellQuote,
  step,
  writeSandboxConfigSyncFile,
});

const {
  _setupPolicies,
  arePolicyPresetsApplied,
  getSuggestedPolicyPresets,
  presetsCheckboxSelector,
  setupPoliciesWithSelection,
} = createOnboardPolicyHelpers({
  USE_COLOR,
  getCredential,
  isNonInteractive,
  note,
  parsePolicyPresetEnv,
  policies,
  prompt,
  sleep,
  step,
  waitForSandboxReady,
});

// ── Main ─────────────────────────────────────────────────────────

// eslint-disable-next-line complexity
async function onboard(opts = {}) {
  NON_INTERACTIVE = opts.nonInteractive || process.env.NEMOCLAW_NON_INTERACTIVE === "1";
  RECREATE_SANDBOX = opts.recreateSandbox || process.env.NEMOCLAW_RECREATE_SANDBOX === "1";
  const dangerouslySkipPermissions =
    opts.dangerouslySkipPermissions || process.env.NEMOCLAW_DANGEROUSLY_SKIP_PERMISSIONS === "1";
  if (dangerouslySkipPermissions) {
    console.error("");
    console.error(
      "  \u26a0  --dangerously-skip-permissions: sandbox security restrictions disabled.",
    );
    console.error("     Network:    all known endpoints open (no method/path filtering)");
    console.error("     Filesystem: sandbox home directory is writable");
    console.error("     Use for development/testing only.");
    console.error("");
  }
  delete process.env.OPENSHELL_GATEWAY;
  const resume = opts.resume === true;
  // In non-interactive mode also accept the env var so CI pipelines can set it.
  // This is the explicitly requested value; on resume it may be absent and the
  // session-recorded path is used instead (see below).
  const requestedFromDockerfile =
    opts.fromDockerfile ||
    (isNonInteractive() ? process.env.NEMOCLAW_FROM_DOCKERFILE || null : null);
  const noticeAccepted = await ensureUsageNoticeConsent({
    nonInteractive: isNonInteractive(),
    acceptedByFlag: opts.acceptThirdPartySoftware === true,
    writeLine: console.error,
  });
  if (!noticeAccepted) {
    process.exit(1);
  }
  const lockResult = onboardSession.acquireOnboardLock(
    `nemoclaw onboard${resume ? " --resume" : ""}${isNonInteractive() ? " --non-interactive" : ""}${requestedFromDockerfile ? ` --from ${requestedFromDockerfile}` : ""}`,
  );
  if (!lockResult.acquired) {
    console.error("  Another NemoClaw onboarding run is already in progress.");
    if (lockResult.holderPid) {
      console.error(`  Lock holder PID: ${lockResult.holderPid}`);
    }
    if (lockResult.holderStartedAt) {
      console.error(`  Started: ${lockResult.holderStartedAt}`);
    }
    console.error("  Wait for it to finish, or remove the stale lock if the previous run crashed:");
    console.error(`    rm -f "${lockResult.lockFile}"`);
    process.exit(1);
  }

  let lockReleased = false;
  const releaseOnboardLock = () => {
    if (lockReleased) return;
    lockReleased = true;
    onboardSession.releaseOnboardLock();
  };
  process.once("exit", releaseOnboardLock);

  try {
    let session;
    let selectedMessagingChannels = [];
    // Merged, absolute fromDockerfile: explicit flag/env takes precedence; on
    // resume falls back to what the original session recorded so the same image
    // is used even when --from is omitted from the resume invocation.
    let fromDockerfile;
    if (resume) {
      session = onboardSession.loadSession();
      if (!session || session.resumable === false) {
        console.error("  No resumable onboarding session was found.");
        console.error("  Run: nemoclaw onboard");
        process.exit(1);
      }
      const sessionFrom = session?.metadata?.fromDockerfile || null;
      fromDockerfile = requestedFromDockerfile
        ? path.resolve(requestedFromDockerfile)
        : sessionFrom
          ? path.resolve(sessionFrom)
          : null;
      const resumeConflicts = getResumeConfigConflicts(session, {
        nonInteractive: isNonInteractive(),
        fromDockerfile: requestedFromDockerfile,
        agent: opts.agent || null,
      });
      if (resumeConflicts.length > 0) {
        for (const conflict of resumeConflicts) {
          if (conflict.field === "sandbox") {
            console.error(
              `  Resumable state belongs to sandbox '${conflict.recorded}', not '${conflict.requested}'.`,
            );
          } else if (conflict.field === "agent") {
            console.error(
              `  Session was started with agent '${conflict.recorded}', not '${conflict.requested}'.`,
            );
          } else if (conflict.field === "fromDockerfile") {
            if (!conflict.recorded) {
              console.error(
                `  Session was started without --from; add --from '${conflict.requested}' to resume it.`,
              );
            } else if (!conflict.requested) {
              console.error(
                `  Session was started with --from '${conflict.recorded}'; rerun with that path to resume it.`,
              );
            } else {
              console.error(
                `  Session was started with --from '${conflict.recorded}', not '${conflict.requested}'.`,
              );
            }
          } else {
            console.error(
              `  Resumable state recorded ${conflict.field} '${conflict.recorded}', not '${conflict.requested}'.`,
            );
          }
        }
        console.error("  Run: nemoclaw onboard              # start a fresh onboarding session");
        console.error("  Or rerun with the original settings to continue that session.");
        process.exit(1);
      }
      onboardSession.updateSession((current) => {
        current.mode = isNonInteractive() ? "non-interactive" : "interactive";
        current.failure = null;
        current.status = "in_progress";
        return current;
      });
      session = onboardSession.loadSession();
    } else {
      fromDockerfile = requestedFromDockerfile ? path.resolve(requestedFromDockerfile) : null;
      session = onboardSession.saveSession(
        onboardSession.createSession({
          mode: isNonInteractive() ? "non-interactive" : "interactive",
          metadata: { gatewayName: "nemoclaw", fromDockerfile: fromDockerfile || null },
        }),
      );
    }

    let completed = false;
    process.once("exit", (code) => {
      if (!completed && code !== 0) {
        const current = onboardSession.loadSession();
        const failedStep = current?.lastStepStarted;
        if (failedStep) {
          onboardSession.markStepFailed(failedStep, "Onboarding exited before the step completed.");
        }
      }
    });

    console.log("");
    console.log("  NemoClaw Onboarding");
    if (isNonInteractive()) note("  (non-interactive mode)");
    if (resume) note("  (resume mode)");
    console.log("  ===================");

    const agent = agentOnboard.resolveAgent({ agentFlag: opts.agent, session });
    if (agent) {
      onboardSession.updateSession((s) => {
        s.agent = agent.name;
        return s;
      });
    }

    let gpu;
    const resumePreflight = resume && session?.steps?.preflight?.status === "complete";
    if (resumePreflight) {
      skippedStepMessage("preflight", "cached");
      gpu = nim.detectGpu();
    } else {
      startRecordedStep("preflight");
      gpu = await preflight();
      onboardSession.markStepComplete("preflight");
    }

    const gatewayStatus = runCaptureOpenshell(["status"], { ignoreError: true });
    const gatewayInfo = runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], {
      ignoreError: true,
    });
    const activeGatewayInfo = runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
    const gatewayReuseState = getGatewayReuseState(gatewayStatus, gatewayInfo, activeGatewayInfo);
    const canReuseHealthyGateway = gatewayReuseState === "healthy";
    const resumeGateway =
      resume && session?.steps?.gateway?.status === "complete" && canReuseHealthyGateway;
    if (resumeGateway) {
      skippedStepMessage("gateway", "running");
    } else if (!resume && canReuseHealthyGateway) {
      skippedStepMessage("gateway", "running", "reuse");
      note("  Reusing healthy NemoClaw gateway.");
    } else {
      if (resume && session?.steps?.gateway?.status === "complete") {
        if (gatewayReuseState === "active-unnamed") {
          note("  [resume] Gateway is active but named metadata is missing; recreating it safely.");
        } else if (gatewayReuseState === "foreign-active") {
          note("  [resume] A different OpenShell gateway is active; NemoClaw will not reuse it.");
        } else if (gatewayReuseState === "stale") {
          note("  [resume] Recorded gateway is unhealthy; recreating it.");
        } else {
          note("  [resume] Recorded gateway state is unavailable; recreating it.");
        }
      }
      startRecordedStep("gateway");
      await startGateway(gpu);
      onboardSession.markStepComplete("gateway");
    }

    let sandboxName = session?.sandboxName || null;
    let model = session?.model || null;
    let provider = session?.provider || null;
    let endpointUrl = session?.endpointUrl || null;
    let credentialEnv = session?.credentialEnv || null;
    let preferredInferenceApi = session?.preferredInferenceApi || null;
    let nimContainer = session?.nimContainer || null;
    let webSearchConfig = session?.webSearchConfig || null;
    let forceProviderSelection = false;
    while (true) {
      const resumeProviderSelection =
        !forceProviderSelection &&
        resume &&
        session?.steps?.provider_selection?.status === "complete" &&
        typeof provider === "string" &&
        typeof model === "string";
      if (resumeProviderSelection) {
        skippedStepMessage("provider_selection", `${provider} / ${model}`);
        hydrateCredentialEnv(credentialEnv);
      } else {
        startRecordedStep("provider_selection", { sandboxName });
        const selection = await setupNim(gpu);
        model = selection.model;
        provider = selection.provider;
        endpointUrl = selection.endpointUrl;
        credentialEnv = selection.credentialEnv;
        preferredInferenceApi = selection.preferredInferenceApi;
        nimContainer = selection.nimContainer;
        onboardSession.markStepComplete("provider_selection", {
          sandboxName,
          provider,
          model,
          endpointUrl,
          credentialEnv,
          preferredInferenceApi,
          nimContainer,
        });
      }

      process.env.NEMOCLAW_OPENSHELL_BIN = getOpenshellBinary();
      const resumeInference =
        !forceProviderSelection &&
        resume &&
        typeof provider === "string" &&
        typeof model === "string" &&
        isInferenceRouteReady(provider, model);
      if (resumeInference) {
        skippedStepMessage("inference", `${provider} / ${model}`);
        if (nimContainer) {
          registry.updateSandbox(sandboxName, { nimContainer });
        }
        onboardSession.markStepComplete("inference", {
          sandboxName,
          provider,
          model,
          nimContainer,
        });
        break;
      }

      startRecordedStep("inference", { sandboxName, provider, model });
      const inferenceResult = await setupInference(
        GATEWAY_NAME,
        model,
        provider,
        endpointUrl,
        credentialEnv,
      );
      delete process.env.NVIDIA_API_KEY;
      if (inferenceResult?.retry === "selection") {
        forceProviderSelection = true;
        continue;
      }
      if (nimContainer) {
        registry.updateSandbox(sandboxName, { nimContainer });
      }
      onboardSession.markStepComplete("inference", { sandboxName, provider, model, nimContainer });
      break;
    }

    if (webSearchConfig) {
      note("  [resume] Revalidating Brave Search configuration.");
      const braveApiKey = await ensureValidatedBraveSearchCredential();
      if (braveApiKey) {
        webSearchConfig = { fetchEnabled: true };
        onboardSession.updateSession((current) => {
          current.webSearchConfig = webSearchConfig;
          return current;
        });
        note("  [resume] Reusing Brave Search configuration.");
      } else {
        webSearchConfig = await configureWebSearch(null);
        onboardSession.updateSession((current) => {
          current.webSearchConfig = webSearchConfig;
          return current;
        });
      }
    } else {
      webSearchConfig = await configureWebSearch(webSearchConfig);
      onboardSession.updateSession((current) => {
        current.webSearchConfig = webSearchConfig;
        return current;
      });
    }

    const sandboxReuseState = getSandboxReuseState(sandboxName);
    const resumeSandbox =
      resume && session?.steps?.sandbox?.status === "complete" && sandboxReuseState === "ready";
    if (resumeSandbox) {
      skippedStepMessage("sandbox", sandboxName);
    } else {
      if (resume && session?.steps?.sandbox?.status === "complete") {
        if (sandboxReuseState === "not_ready") {
          note(
            `  [resume] Recorded sandbox '${sandboxName}' exists but is not ready; recreating it.`,
          );
          repairRecordedSandbox(sandboxName);
        } else {
          note("  [resume] Recorded sandbox state is unavailable; recreating it.");
          if (sandboxName) {
            registry.removeSandbox(sandboxName);
          }
        }
      }
      startRecordedStep("sandbox", { sandboxName, provider, model });
      selectedMessagingChannels = await setupMessagingChannels();
      onboardSession.updateSession((current) => {
        current.messagingChannels = selectedMessagingChannels;
        return current;
      });
      sandboxName = await createSandbox(
        gpu,
        model,
        provider,
        preferredInferenceApi,
        sandboxName,
        webSearchConfig,
        selectedMessagingChannels,
        fromDockerfile,
        agent,
        dangerouslySkipPermissions,
      );
      onboardSession.markStepComplete("sandbox", { sandboxName, provider, model, nimContainer });
    }

    if (agent) {
      await agentOnboard.handleAgentSetup(sandboxName, model, provider, agent, resume, session, {
        step,
        runCaptureOpenshell,
        openshellShellCommand,
        buildSandboxConfigSyncScript,
        writeSandboxConfigSyncFile,
        cleanupTempDir,
        startRecordedStep,
        skippedStepMessage,
      });
    } else {
      const resumeOpenclaw = resume && sandboxName && isOpenclawReady(sandboxName);
      if (resumeOpenclaw) {
        skippedStepMessage("openclaw", sandboxName);
        onboardSession.markStepComplete("openclaw", { sandboxName, provider, model });
      } else {
        startRecordedStep("openclaw", { sandboxName, provider, model });
        await setupOpenclaw(sandboxName, model, provider);
        onboardSession.markStepComplete("openclaw", { sandboxName, provider, model });
      }
    }

    const recordedPolicyPresets = Array.isArray(session?.policyPresets)
      ? session.policyPresets
      : null;
    if (dangerouslySkipPermissions) {
      step(8, 8, "Policy presets");
      console.log("  Skipped — --dangerously-skip-permissions applies permissive base policy.");
      onboardSession.markStepComplete("policies", {
        sandboxName,
        provider,
        model,
        policyPresets: [],
      });
    } else {
      const resumePolicies =
        resume && sandboxName && arePolicyPresetsApplied(sandboxName, recordedPolicyPresets || []);
      if (resumePolicies) {
        skippedStepMessage("policies", (recordedPolicyPresets || []).join(", "));
        onboardSession.markStepComplete("policies", {
          sandboxName,
          provider,
          model,
          policyPresets: recordedPolicyPresets || [],
        });
      } else {
        startRecordedStep("policies", {
          sandboxName,
          provider,
          model,
          policyPresets: recordedPolicyPresets || [],
        });
        const appliedPolicyPresets = await setupPoliciesWithSelection(sandboxName, {
          selectedPresets:
            resume &&
            session?.steps?.policies?.status !== "complete" &&
            Array.isArray(recordedPolicyPresets) &&
            recordedPolicyPresets.length > 0
              ? recordedPolicyPresets
              : null,
          enabledChannels: selectedMessagingChannels,
          webSearchConfig,
          onSelection: (policyPresets) => {
            onboardSession.updateSession((current) => {
              current.policyPresets = policyPresets;
              return current;
            });
          },
        });
        onboardSession.markStepComplete("policies", {
          sandboxName,
          provider,
          model,
          policyPresets: appliedPolicyPresets,
        });
      }
    }

    onboardSession.completeSession({ sandboxName, provider, model });
    completed = true;
    printDashboard(sandboxName, model, provider, nimContainer, agent);
  } finally {
    releaseOnboardLock();
  }
}

module.exports = {
  buildProviderArgs,
  buildSandboxConfigSyncScript,
  compactText,
  copyBuildContextDir,
  classifySandboxCreateFailure,
  createSandbox,
  formatEnvAssignment,
  getFutureShellPathHint,
  getGatewayStartEnv,
  getGatewayReuseState,
  getNavigationChoice,
  getSandboxInferenceConfig,
  getInstalledOpenshellVersion,
  getBlueprintMinOpenshellVersion,
  versionGte,
  getRequestedModelHint,
  getRequestedProviderHint,
  getStableGatewayImageRef,
  getResumeConfigConflicts,
  isGatewayHealthy,
  hasStaleGateway,
  getRequestedSandboxNameHint,
  getResumeSandboxConflict,
  getSandboxReuseState,
  getSandboxStateFromOutputs,
  getPortConflictServiceHints,
  classifyValidationFailure,
  isSandboxReady,
  isLoopbackHostname,
  normalizeProviderBaseUrl,
  onboard,
  onboardSession,
  printSandboxCreateRecoveryHints,
  providerExistsInGateway,
  parsePolicyPresetEnv,
  pruneStaleSandboxEntry,
  repairRecordedSandbox,
  recoverGatewayRuntime,
  resolveDashboardForwardTarget,
  startGatewayForRecovery,
  runCaptureOpenshell,
  setupInference,
  setupMessagingChannels,
  setupNim,
  isInferenceRouteReady,
  isOpenclawReady,
  arePolicyPresetsApplied,
  getSuggestedPolicyPresets,
  presetsCheckboxSelector,
  setupPoliciesWithSelection,
  summarizeCurlFailure,
  summarizeProbeFailure,
  hasResponsesToolCall,
  upsertProvider,
  hydrateCredentialEnv,
  pruneKnownHostsEntries,
  shouldIncludeBuildContextPath,
  writeSandboxConfigSyncFile,
  patchStagedDockerfile,
};
