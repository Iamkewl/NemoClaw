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
const { spawn, spawnSync } = require("child_process");
const pRetry = require("p-retry");

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
const { createOnboardMessagingHelpers } = require("./onboard-messaging");
const { createOnboardProviderHelpers } = require("./onboard-provider");
const { createOnboardProviderValidationHelpers } = require("./onboard-provider-validation");
const { createOnboardSandboxHelpers } = require("./onboard-sandbox");
const { createOnboardSelectionHelpers } = require("./onboard-selection");
const { createOnboardWebSearchHelpers } = require("./onboard-web-search");

/**
 * Create a temp file inside a directory with a cryptographically random name.
 * Uses fs.mkdtempSync (OS-level mkdtemp) to avoid predictable filenames that
 * could be exploited via symlink attacks on shared /tmp.
 * Ref: https://github.com/NVIDIA/NemoClaw/issues/1093
 */
function secureTempFile(prefix, ext = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return path.join(dir, `${prefix}${ext}`);
}

/**
 * Safely remove a mkdtemp-created directory.  Guards against accidentally
 * deleting the system temp root if a caller passes os.tmpdir() itself.
 */
function cleanupTempDir(filePath, expectedPrefix) {
  const parentDir = path.dirname(filePath);
  if (parentDir !== os.tmpdir() && path.basename(parentDir).startsWith(`${expectedPrefix}-`)) {
    fs.rmSync(parentDir, { recursive: true, force: true });
  }
}

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

function isNonInteractive() {
  return NON_INTERACTIVE || process.env.NEMOCLAW_NON_INTERACTIVE === "1";
}

function isRecreateSandbox() {
  return RECREATE_SANDBOX || process.env.NEMOCLAW_RECREATE_SANDBOX === "1";
}

function note(message) {
  console.log(`${DIM}${message}${RESET}`);
}

// Prompt wrapper: returns env var value or default in non-interactive mode,
// otherwise prompts the user interactively.
async function promptOrDefault(question, envVar, defaultValue) {
  if (isNonInteractive()) {
    const val = envVar ? process.env[envVar] : null;
    const result = val || defaultValue;
    note(`  [non-interactive] ${question.trim()} → ${result}`);
    return result;
  }
  return prompt(question);
}

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

function step(n, total, msg) {
  console.log("");
  console.log(`  [${n}/${total}] ${msg}`);
  console.log(`  ${"─".repeat(50)}`);
}

function getInstalledOpenshellVersion(versionOutput = null) {
  const output = String(versionOutput ?? runCapture("openshell -V", { ignoreError: true })).trim();
  const match = output.match(/openshell\s+([0-9]+\.[0-9]+\.[0-9]+)/i);
  if (!match) return null;
  return match[1];
}

/**
 * Compare two semver-like x.y.z strings. Returns true iff `left >= right`.
 * Non-numeric or missing components are treated as 0.
 */
function versionGte(left = "0.0.0", right = "0.0.0") {
  const lhs = String(left)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const rhs = String(right)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(lhs.length, rhs.length);
  for (let index = 0; index < length; index += 1) {
    const a = lhs[index] || 0;
    const b = rhs[index] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

/**
 * Read `min_openshell_version` from nemoclaw-blueprint/blueprint.yaml. Returns
 * null if the blueprint or field is missing or unparseable — callers must
 * treat null as "no constraint configured" so a malformed install does not
 * become a hard onboard blocker. See #1317.
 */
function getBlueprintMinOpenshellVersion(rootDir = ROOT) {
  try {
    // Lazy require: yaml is already a dependency via the policy helpers but
    // pulling it at module load would slow down `nemoclaw --help` for users
    // who never reach the preflight path.
    const YAML = require("yaml");
    const blueprintPath = path.join(rootDir, "nemoclaw-blueprint", "blueprint.yaml");
    if (!fs.existsSync(blueprintPath)) return null;
    const raw = fs.readFileSync(blueprintPath, "utf8");
    const parsed = YAML.parse(raw);
    const value = parsed && parsed.min_openshell_version;
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!/^[0-9]+\.[0-9]+\.[0-9]+/.test(trimmed)) return null;
    return trimmed;
  } catch {
    return null;
  }
}

function getStableGatewayImageRef(versionOutput = null) {
  const version = getInstalledOpenshellVersion(versionOutput);
  if (!version) return null;
  return `ghcr.io/nvidia/openshell/cluster:${version}`;
}

function getOpenshellBinary() {
  if (OPENSHELL_BIN) return OPENSHELL_BIN;
  const resolved = resolveOpenshell();
  if (!resolved) {
    console.error("  openshell CLI not found.");
    console.error("  Install manually: https://github.com/NVIDIA/OpenShell/releases");
    process.exit(1);
  }
  OPENSHELL_BIN = resolved;
  return OPENSHELL_BIN;
}

function openshellShellCommand(args) {
  return [shellQuote(getOpenshellBinary()), ...args.map((arg) => shellQuote(arg))].join(" ");
}

function runOpenshell(args, opts = {}) {
  return run(openshellShellCommand(args), opts);
}

function runCaptureOpenshell(args, opts = {}) {
  return runCapture(openshellShellCommand(args), opts);
}

// URL/string utilities — delegated to src/lib/url-utils.ts
const {
  compactText,
  normalizeProviderBaseUrl,
  isLoopbackHostname,
  formatEnvAssignment,
  parsePolicyPresetEnv,
} = urlUtils;

function hydrateCredentialEnv(envName) {
  if (!envName) return null;
  const value = getCredential(envName);
  if (value) {
    process.env[envName] = value;
  }
  return value || null;
}

const { getCurlTimingArgs, summarizeCurlFailure, summarizeProbeFailure, runCurlProbe } = httpProbe;

function getNavigationChoice(value = "") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "back") return "back";
  if (normalized === "exit" || normalized === "quit") return "exit";
  return null;
}

function exitOnboardFromPrompt() {
  console.log("  Exiting onboarding.");
  process.exit(1);
}

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

function encodeDockerJsonArg(value) {
  return Buffer.from(JSON.stringify(value || {}), "utf8").toString("base64");
}

function isAffirmativeAnswer(value) {
  return ["y", "yes"].includes(
    String(value || "")
      .trim()
      .toLowerCase(),
  );
}

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

function getSandboxInferenceConfig(model, provider = null, preferredInferenceApi = null) {
  let providerKey;
  let primaryModelRef;
  let inferenceBaseUrl = "https://inference.local/v1";
  let inferenceApi = preferredInferenceApi || "openai-completions";
  let inferenceCompat = null;

  switch (provider) {
    case "openai-api":
      providerKey = "openai";
      primaryModelRef = `openai/${model}`;
      break;
    case "anthropic-prod":
    case "compatible-anthropic-endpoint":
      providerKey = "anthropic";
      primaryModelRef = `anthropic/${model}`;
      inferenceBaseUrl = "https://inference.local";
      inferenceApi = "anthropic-messages";
      break;
    case "gemini-api":
      providerKey = "inference";
      primaryModelRef = `inference/${model}`;
      inferenceCompat = {
        supportsStore: false,
      };
      break;
    case "compatible-endpoint":
      providerKey = "inference";
      primaryModelRef = `inference/${model}`;
      inferenceCompat = {
        supportsStore: false,
      };
      break;
    case "nvidia-prod":
    case "nvidia-nim":
    default:
      providerKey = "inference";
      primaryModelRef = `inference/${model}`;
      break;
  }

  return { providerKey, primaryModelRef, inferenceBaseUrl, inferenceApi, inferenceCompat };
}

function patchStagedDockerfile(
  dockerfilePath,
  model,
  chatUiUrl,
  buildId = String(Date.now()),
  provider = null,
  preferredInferenceApi = null,
  webSearchConfig = null,
  messagingChannels = [],
  messagingAllowedIds = {},
  discordGuilds = {},
) {
  const { providerKey, primaryModelRef, inferenceBaseUrl, inferenceApi, inferenceCompat } =
    getSandboxInferenceConfig(model, provider, preferredInferenceApi);
  let dockerfile = fs.readFileSync(dockerfilePath, "utf8");
  dockerfile = dockerfile.replace(/^ARG NEMOCLAW_MODEL=.*$/m, `ARG NEMOCLAW_MODEL=${model}`);
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_PROVIDER_KEY=.*$/m,
    `ARG NEMOCLAW_PROVIDER_KEY=${providerKey}`,
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_PRIMARY_MODEL_REF=.*$/m,
    `ARG NEMOCLAW_PRIMARY_MODEL_REF=${primaryModelRef}`,
  );
  dockerfile = dockerfile.replace(/^ARG CHAT_UI_URL=.*$/m, `ARG CHAT_UI_URL=${chatUiUrl}`);
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_INFERENCE_BASE_URL=.*$/m,
    `ARG NEMOCLAW_INFERENCE_BASE_URL=${inferenceBaseUrl}`,
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_INFERENCE_API=.*$/m,
    `ARG NEMOCLAW_INFERENCE_API=${inferenceApi}`,
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_INFERENCE_COMPAT_B64=.*$/m,
    `ARG NEMOCLAW_INFERENCE_COMPAT_B64=${encodeDockerJsonArg(inferenceCompat)}`,
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_BUILD_ID=.*$/m,
    `ARG NEMOCLAW_BUILD_ID=${buildId}`,
  );
  // Honor NEMOCLAW_PROXY_HOST / NEMOCLAW_PROXY_PORT exported in the host
  // shell so the sandbox-side nemoclaw-start.sh sees them via $ENV at runtime.
  // Without this, the host export is silently dropped at image build time and
  // the sandbox falls back to the default 10.200.0.1:3128 proxy. See #1409.
  const PROXY_HOST_RE = /^[A-Za-z0-9._:-]+$/;
  const PROXY_PORT_RE = /^[0-9]{1,5}$/;
  const proxyHostEnv = process.env.NEMOCLAW_PROXY_HOST;
  if (proxyHostEnv && PROXY_HOST_RE.test(proxyHostEnv)) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_PROXY_HOST=.*$/m,
      `ARG NEMOCLAW_PROXY_HOST=${proxyHostEnv}`,
    );
  }
  const proxyPortEnv = process.env.NEMOCLAW_PROXY_PORT;
  if (proxyPortEnv && PROXY_PORT_RE.test(proxyPortEnv)) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_PROXY_PORT=.*$/m,
      `ARG NEMOCLAW_PROXY_PORT=${proxyPortEnv}`,
    );
  }
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_WEB_CONFIG_B64=.*$/m,
    `ARG NEMOCLAW_WEB_CONFIG_B64=${webSearch.buildWebSearchDockerConfig(
      webSearchConfig,
      webSearchConfig ? getCredential(webSearch.BRAVE_API_KEY_ENV) : null,
    )}`,
  );
  // Onboard flow expects immediate dashboard access without device pairing,
  // so disable device auth for images built during onboard (see #1217).
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_DISABLE_DEVICE_AUTH=.*$/m,
    `ARG NEMOCLAW_DISABLE_DEVICE_AUTH=1`,
  );
  if (messagingChannels.length > 0) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_MESSAGING_CHANNELS_B64=.*$/m,
      `ARG NEMOCLAW_MESSAGING_CHANNELS_B64=${encodeDockerJsonArg(messagingChannels)}`,
    );
  }
  if (Object.keys(messagingAllowedIds).length > 0) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_MESSAGING_ALLOWED_IDS_B64=.*$/m,
      `ARG NEMOCLAW_MESSAGING_ALLOWED_IDS_B64=${encodeDockerJsonArg(messagingAllowedIds)}`,
    );
  }
  if (Object.keys(discordGuilds).length > 0) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_DISCORD_GUILDS_B64=.*$/m,
      `ARG NEMOCLAW_DISCORD_GUILDS_B64=${encodeDockerJsonArg(discordGuilds)}`,
    );
  }
  fs.writeFileSync(dockerfilePath, dockerfile);
}

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

function getRequestedSandboxNameHint() {
  const raw = process.env.NEMOCLAW_SANDBOX_NAME;
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  return normalized || null;
}

function getResumeSandboxConflict(session) {
  const requestedSandboxName = getRequestedSandboxNameHint();
  if (!requestedSandboxName || !session?.sandboxName) {
    return null;
  }
  return requestedSandboxName !== session.sandboxName
    ? { requestedSandboxName, recordedSandboxName: session.sandboxName }
    : null;
}

function getRequestedProviderHint(nonInteractive = isNonInteractive()) {
  return nonInteractive ? getNonInteractiveProvider() : null;
}

function getRequestedModelHint(nonInteractive = isNonInteractive()) {
  if (!nonInteractive) return null;
  const providerKey = getRequestedProviderHint(nonInteractive) || "cloud";
  return getNonInteractiveModel(providerKey);
}

function getEffectiveProviderName(providerKey) {
  if (!providerKey) return null;
  if (REMOTE_PROVIDER_CONFIG[providerKey]) {
    return REMOTE_PROVIDER_CONFIG[providerKey].providerName;
  }

  switch (providerKey) {
    case "nim-local":
      return "nvidia-nim";
    case "ollama":
      return "ollama-local";
    case "vllm":
      return "vllm-local";
    default:
      return providerKey;
  }
}

function getResumeConfigConflicts(session, opts = {}) {
  const conflicts = [];
  const nonInteractive = opts.nonInteractive ?? isNonInteractive();

  const sandboxConflict = getResumeSandboxConflict(session);
  if (sandboxConflict) {
    conflicts.push({
      field: "sandbox",
      requested: sandboxConflict.requestedSandboxName,
      recorded: sandboxConflict.recordedSandboxName,
    });
  }

  const requestedProvider = getRequestedProviderHint(nonInteractive);
  const effectiveRequestedProvider = getEffectiveProviderName(requestedProvider);
  if (
    effectiveRequestedProvider &&
    session?.provider &&
    effectiveRequestedProvider !== session.provider
  ) {
    conflicts.push({
      field: "provider",
      requested: effectiveRequestedProvider,
      recorded: session.provider,
    });
  }

  const requestedModel = getRequestedModelHint(nonInteractive);
  if (requestedModel && session?.model && requestedModel !== session.model) {
    conflicts.push({
      field: "model",
      requested: requestedModel,
      recorded: session.model,
    });
  }

  const requestedFrom = opts.fromDockerfile ? path.resolve(opts.fromDockerfile) : null;
  const recordedFrom = session?.metadata?.fromDockerfile
    ? path.resolve(session.metadata.fromDockerfile)
    : null;
  if (requestedFrom !== recordedFrom) {
    conflicts.push({
      field: "fromDockerfile",
      requested: requestedFrom,
      recorded: recordedFrom,
    });
  }

  const requestedAgent = opts.agent || process.env.NEMOCLAW_AGENT || null;
  const recordedAgent = session?.agent || null;
  if (requestedAgent && recordedAgent && requestedAgent !== recordedAgent) {
    conflicts.push({
      field: "agent",
      requested: requestedAgent,
      recorded: recordedAgent,
    });
  }

  return conflicts;
}

function getContainerRuntime() {
  const info = runCapture("docker info 2>/dev/null", { ignoreError: true });
  return inferContainerRuntime(info);
}

function printRemediationActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) {
    return;
  }

  console.error("");
  console.error("  Suggested fix:");
  console.error("");
  for (const action of actions) {
    console.error(`  - ${action.title}: ${action.reason}`);
    for (const command of action.commands || []) {
      console.error(`    ${command}`);
    }
  }
}

function isOpenshellInstalled() {
  return resolveOpenshell() !== null;
}

function getFutureShellPathHint(binDir, pathValue = process.env.PATH || "") {
  if (String(pathValue).split(path.delimiter).includes(binDir)) {
    return null;
  }
  return `export PATH="${binDir}:$PATH"`;
}

function getPortConflictServiceHints(platform = process.platform) {
  if (platform === "darwin") {
    return [
      "       # or, if it's a launchctl service (macOS):",
      "       launchctl list | grep -i claw   # columns: PID | ExitStatus | Label",
      `       launchctl unload ${OPENCLAW_LAUNCH_AGENT_PLIST}`,
      "       # or: launchctl bootout gui/$(id -u)/ai.openclaw.gateway",
    ];
  }
  return [
    "       # or, if it's a systemd service:",
    "       systemctl --user stop openclaw-gateway.service",
  ];
}

function installOpenshell() {
  const result = spawnSync("bash", [path.join(SCRIPTS, "install-openshell.sh")], {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    timeout: 300_000,
  });
  if (result.status !== 0) {
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    if (output) {
      console.error(output);
    }
    return { installed: false, localBin: null, futureShellPathHint: null };
  }
  const localBin = process.env.XDG_BIN_HOME || path.join(process.env.HOME || "", ".local", "bin");
  const openshellPath = path.join(localBin, "openshell");
  const futureShellPathHint = fs.existsSync(openshellPath)
    ? getFutureShellPathHint(localBin, process.env.PATH)
    : null;
  if (fs.existsSync(openshellPath) && futureShellPathHint) {
    process.env.PATH = `${localBin}${path.delimiter}${process.env.PATH}`;
  }
  OPENSHELL_BIN = resolveOpenshell();
  return {
    installed: OPENSHELL_BIN !== null,
    localBin,
    futureShellPathHint,
  };
}

function sleep(seconds) {
  require("child_process").spawnSync("sleep", [String(seconds)]);
}

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
async function preflight() {
  step(1, 8, "Preflight checks");

  const host = assessHost();

  // Docker / runtime
  if (!host.dockerReachable) {
    console.error("  Docker is not reachable. Please fix Docker and try again.");
    printRemediationActions(planHostRemediation(host));
    process.exit(1);
  }
  console.log("  ✓ Docker is running");

  if (host.runtime !== "unknown") {
    console.log(`  ✓ Container runtime: ${host.runtime}`);
  }
  // Podman is now supported — no unsupported runtime warning needed.
  if (host.notes.includes("Running under WSL")) {
    console.log("  ⓘ Running under WSL");
  }

  // OpenShell CLI — install if missing, upgrade if below minimum version.
  // MIN_VERSION in install-openshell.sh handles the version gate; calling it
  // when openshell already exists is safe (it exits early if version is OK).
  let openshellInstall = { localBin: null, futureShellPathHint: null };
  if (!isOpenshellInstalled()) {
    console.log("  openshell CLI not found. Installing...");
    openshellInstall = installOpenshell();
    if (!openshellInstall.installed) {
      console.error("  Failed to install openshell CLI.");
      console.error("  Install manually: https://github.com/NVIDIA/OpenShell/releases");
      process.exit(1);
    }
  } else {
    // Ensure the installed version meets the minimum required by install-openshell.sh.
    // The script itself is idempotent — it exits early if the version is already sufficient.
    const currentVersion = getInstalledOpenshellVersion();
    if (!currentVersion) {
      console.log("  openshell version could not be determined. Reinstalling...");
      openshellInstall = installOpenshell();
      if (!openshellInstall.installed) {
        console.error("  Failed to reinstall openshell CLI.");
        console.error("  Install manually: https://github.com/NVIDIA/OpenShell/releases");
        process.exit(1);
      }
    } else {
      const parts = currentVersion.split(".").map(Number);
      const minParts = [0, 0, 24]; // must match MIN_VERSION in scripts/install-openshell.sh
      const needsUpgrade =
        parts[0] < minParts[0] ||
        (parts[0] === minParts[0] && parts[1] < minParts[1]) ||
        (parts[0] === minParts[0] && parts[1] === minParts[1] && parts[2] < minParts[2]);
      if (needsUpgrade) {
        console.log(
          `  openshell ${currentVersion} is below minimum required version. Upgrading...`,
        );
        openshellInstall = installOpenshell();
        if (!openshellInstall.installed) {
          console.error("  Failed to upgrade openshell CLI.");
          console.error("  Install manually: https://github.com/NVIDIA/OpenShell/releases");
          process.exit(1);
        }
      }
    }
  }
  const openshellVersionOutput = runCaptureOpenshell(["--version"], { ignoreError: true });
  console.log(`  ✓ openshell CLI: ${openshellVersionOutput || "unknown"}`);
  // Enforce nemoclaw-blueprint/blueprint.yaml's min_openshell_version. Without
  // this check, users can complete a full onboard against an OpenShell that
  // pre-dates required CLI surface (e.g. `sandbox exec`, `--upload`) and hit
  // silent failures inside the sandbox at runtime. See #1317.
  const installedOpenshellVersion = getInstalledOpenshellVersion(openshellVersionOutput);
  const minOpenshellVersion = getBlueprintMinOpenshellVersion();
  if (
    installedOpenshellVersion &&
    minOpenshellVersion &&
    !versionGte(installedOpenshellVersion, minOpenshellVersion)
  ) {
    console.error("");
    console.error(
      `  ✗ openshell ${installedOpenshellVersion} is below the minimum required by this NemoClaw release.`,
    );
    console.error(`    blueprint.yaml min_openshell_version: ${minOpenshellVersion}`);
    console.error("");
    console.error("    Upgrade openshell and retry:");
    console.error("      https://github.com/NVIDIA/OpenShell/releases");
    console.error(
      "    Or remove the existing binary so the installer can re-fetch a current build:",
    );
    console.error('      command -v openshell && rm -f "$(command -v openshell)"');
    console.error("");
    process.exit(1);
  }
  if (openshellInstall.futureShellPathHint) {
    console.log(
      `  Note: openshell was installed to ${openshellInstall.localBin} for this onboarding run.`,
    );
    console.log(`  Future shells may still need: ${openshellInstall.futureShellPathHint}`);
    console.log(
      "  Add that export to your shell profile, or open a new terminal before running openshell directly.",
    );
  }

  // Clean up stale or unnamed NemoClaw gateway state before checking ports.
  // A healthy named gateway can be reused later in onboarding, so avoid
  // tearing it down here. If some other gateway is active, do not treat it
  // as NemoClaw state; let the port checks surface the conflict instead.
  const gatewayStatus = runCaptureOpenshell(["status"], { ignoreError: true });
  const gwInfo = runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], {
    ignoreError: true,
  });
  const activeGatewayInfo = runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
  const gatewayReuseState = getGatewayReuseState(gatewayStatus, gwInfo, activeGatewayInfo);
  if (gatewayReuseState === "stale" || gatewayReuseState === "active-unnamed") {
    console.log("  Cleaning up previous NemoClaw session...");
    runOpenshell(["forward", "stop", "18789"], { ignoreError: true });
    const destroyResult = runOpenshell(["gateway", "destroy", "-g", GATEWAY_NAME], {
      ignoreError: true,
    });
    // Sandboxes under the destroyed gateway no longer exist in OpenShell —
    // clear the local registry so `nemoclaw list` stays consistent. (#532)
    if (destroyResult.status === 0) {
      registry.clearAll();
    }
    console.log("  ✓ Previous session cleaned up");
  }

  // Clean up orphaned Docker containers from interrupted onboard (e.g. Ctrl+C
  // during gateway start). The container may still be running even though
  // OpenShell has no metadata for it (gatewayReuseState === "missing").
  if (gatewayReuseState === "missing") {
    const containerName = `openshell-cluster-${GATEWAY_NAME}`;
    const inspectResult = run(
      `docker inspect --type container --format '{{.State.Status}}' ${containerName} 2>/dev/null`,
      { ignoreError: true, suppressOutput: true },
    );
    if (inspectResult.status === 0) {
      console.log("  Cleaning up orphaned gateway container...");
      run(`docker stop ${containerName} >/dev/null 2>&1`, {
        ignoreError: true,
        suppressOutput: true,
      });
      run(`docker rm ${containerName} >/dev/null 2>&1`, {
        ignoreError: true,
        suppressOutput: true,
      });
      const postInspectResult = run(
        `docker inspect --type container ${containerName} 2>/dev/null`,
        {
          ignoreError: true,
          suppressOutput: true,
        },
      );
      if (postInspectResult.status !== 0) {
        run(
          `docker volume ls -q --filter "name=openshell-cluster-${GATEWAY_NAME}" | grep . && docker volume ls -q --filter "name=openshell-cluster-${GATEWAY_NAME}" | xargs docker volume rm 2>/dev/null || true`,
          { ignoreError: true, suppressOutput: true },
        );
        registry.clearAll();
        console.log("  ✓ Orphaned gateway container removed");
      } else {
        console.warn("  ! Found an orphaned gateway container, but automatic cleanup failed.");
      }
    }
  }

  // Required ports — gateway (8080) and dashboard (18789)
  const requiredPorts = [
    { port: 8080, label: "OpenShell gateway" },
    { port: 18789, label: "NemoClaw dashboard" },
  ];
  for (const { port, label } of requiredPorts) {
    const portCheck = await checkPortAvailable(port);
    if (!portCheck.ok) {
      if ((port === 8080 || port === 18789) && gatewayReuseState === "healthy") {
        console.log(`  ✓ Port ${port} already owned by healthy NemoClaw runtime (${label})`);
        continue;
      }
      console.error("");
      console.error(`  !! Port ${port} is not available.`);
      console.error(`     ${label} needs this port.`);
      console.error("");
      if (portCheck.process && portCheck.process !== "unknown") {
        console.error(
          `     Blocked by: ${portCheck.process}${portCheck.pid ? ` (PID ${portCheck.pid})` : ""}`,
        );
        console.error("");
        console.error("     To fix, stop the conflicting process:");
        console.error("");
        if (portCheck.pid) {
          console.error(`       sudo kill ${portCheck.pid}`);
        } else {
          console.error(`       sudo lsof -i :${port} -sTCP:LISTEN -P -n`);
        }
        for (const hint of getPortConflictServiceHints()) {
          console.error(hint);
        }
      } else {
        console.error(`     Could not identify the process using port ${port}.`);
        console.error(`     Run: sudo lsof -i :${port} -sTCP:LISTEN`);
      }
      console.error("");
      console.error(`     Detail: ${portCheck.reason}`);
      process.exit(1);
    }
    console.log(`  ✓ Port ${port} available (${label})`);
  }

  // GPU
  const gpu = nim.detectGpu();
  if (gpu && gpu.type === "nvidia") {
    console.log(`  ✓ NVIDIA GPU detected: ${gpu.count} GPU(s), ${gpu.totalMemoryMB} MB VRAM`);
    if (!gpu.nimCapable) {
      console.log("  ⓘ GPU VRAM too small for local NIM — will use cloud inference");
    }
  } else if (gpu && gpu.type === "apple") {
    console.log(
      `  ✓ Apple GPU detected: ${gpu.name}${gpu.cores ? ` (${gpu.cores} cores)` : ""}, ${gpu.totalMemoryMB} MB unified memory`,
    );
    console.log("  ⓘ NIM requires NVIDIA GPU — will use cloud inference");
  } else {
    console.log("  ⓘ No GPU detected — will use cloud inference");
  }

  // Memory / swap check (Linux only)
  if (process.platform === "linux") {
    const mem = getMemoryInfo();
    if (mem) {
      if (mem.totalMB < 12000) {
        console.log(
          `  ⚠ Low memory detected (${mem.totalRamMB} MB RAM + ${mem.totalSwapMB} MB swap = ${mem.totalMB} MB total)`,
        );

        let proceedWithSwap = false;
        if (!isNonInteractive()) {
          const answer = await prompt(
            "  Create a 4 GB swap file to prevent OOM during sandbox build? (requires sudo) [y/N]: ",
          );
          proceedWithSwap = answer && answer.toLowerCase().startsWith("y");
        }

        if (!proceedWithSwap) {
          console.log(
            "  ⓘ Skipping swap creation. Sandbox build may fail with OOM on this system.",
          );
        } else {
          console.log("  Creating 4 GB swap file to prevent OOM during sandbox build...");
          const swapResult = ensureSwap(12000);
          if (swapResult.ok && swapResult.swapCreated) {
            console.log("  ✓ Swap file created and activated");
          } else if (swapResult.ok) {
            if (swapResult.reason) {
              console.log(`  ⓘ ${swapResult.reason} — existing swap should help prevent OOM`);
            } else {
              console.log(`  ✓ Memory OK: ${mem.totalRamMB} MB RAM + ${mem.totalSwapMB} MB swap`);
            }
          } else {
            console.log(`  ⚠ Could not create swap: ${swapResult.reason}`);
            console.log("  Sandbox creation may fail with OOM on low-memory systems.");
          }
        }
      } else {
        console.log(`  ✓ Memory OK: ${mem.totalRamMB} MB RAM + ${mem.totalSwapMB} MB swap`);
      }
    }
  }

  return gpu;
}

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

async function setupOpenclaw(sandboxName, model, provider) {
  step(7, 8, "Setting up OpenClaw inside sandbox");

  const selectionConfig = getProviderSelectionConfig(provider, model);
  if (selectionConfig) {
    const sandboxConfig = {
      ...selectionConfig,
      onboardedAt: new Date().toISOString(),
    };
    const script = buildSandboxConfigSyncScript(sandboxConfig);
    const scriptFile = writeSandboxConfigSyncFile(script);
    try {
      run(
        `${openshellShellCommand(["sandbox", "connect", sandboxName])} < ${shellQuote(scriptFile)}`,
        { stdio: ["ignore", "ignore", "inherit"] },
      );
    } finally {
      cleanupTempDir(scriptFile, "nemoclaw-sync");
    }
  }

  console.log("  ✓ OpenClaw gateway launched inside sandbox");
}

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

function startRecordedStep(stepName, updates = {}) {
  onboardSession.markStepStarted(stepName);
  if (Object.keys(updates).length > 0) {
    onboardSession.updateSession((session) => {
      if (typeof updates.sandboxName === "string") session.sandboxName = updates.sandboxName;
      if (typeof updates.provider === "string") session.provider = updates.provider;
      if (typeof updates.model === "string") session.model = updates.model;
      return session;
    });
  }
}

const ONBOARD_STEP_INDEX = {
  preflight: { number: 1, title: "Preflight checks" },
  gateway: { number: 2, title: "Starting OpenShell gateway" },
  provider_selection: { number: 3, title: "Configuring inference (NIM)" },
  inference: { number: 4, title: "Setting up inference provider" },
  messaging: { number: 5, title: "Messaging channels" },
  sandbox: { number: 6, title: "Creating sandbox" },
  openclaw: { number: 7, title: "Setting up OpenClaw inside sandbox" },
  policies: { number: 8, title: "Policy presets" },
};

function skippedStepMessage(stepName, detail, reason = "resume") {
  const stepInfo = ONBOARD_STEP_INDEX[stepName];
  if (stepInfo) {
    step(stepInfo.number, 8, stepInfo.title);
  }
  const prefix = reason === "reuse" ? "[reuse]" : "[resume]";
  console.log(`  ${prefix} Skipping ${stepName}${detail ? ` (${detail})` : ""}`);
}

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
