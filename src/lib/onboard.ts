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
const { createOnboardMessagingHelpers } = require("./onboard-messaging");
const { createOnboardProviderHelpers } = require("./onboard-provider");
const { createOnboardProviderValidationHelpers } = require("./onboard-provider-validation");
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
function pruneKnownHostsEntries(contents) {
  return contents
    .split("\n")
    .filter((l) => {
      const trimmed = l.trim();
      if (!trimmed || trimmed.startsWith("#")) return true;
      const hostField = trimmed.split(/\s+/)[0];
      return !hostField.split(",").some((h) => h.startsWith("openshell-"));
    })
    .join("\n");
}

function getSandboxReuseState(sandboxName) {
  if (!sandboxName) return "missing";
  const getOutput = runCaptureOpenshell(["sandbox", "get", sandboxName], { ignoreError: true });
  const listOutput = runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
  return getSandboxStateFromOutputs(sandboxName, getOutput, listOutput);
}

function repairRecordedSandbox(sandboxName) {
  if (!sandboxName) return;
  note(`  [resume] Cleaning up recorded sandbox '${sandboxName}' before recreating it.`);
  runOpenshell(["forward", "stop", "18789"], { ignoreError: true });
  runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });
  registry.removeSandbox(sandboxName);
}

const { streamSandboxCreate } = sandboxCreateStream;

function streamGatewayStart(command, env = process.env) {
  const child = spawn("bash", ["-lc", command], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const lines = [];
  let pending = "";
  let settled = false;
  let resolvePromise;
  let lastPrintedLine = "";
  let currentPhase = "cluster";
  let lastHeartbeatBucket = -1;
  let lastOutputAt = Date.now();
  const startedAt = Date.now();

  function getDisplayWidth() {
    return Math.max(60, Number(process.stdout.columns || 100));
  }

  function trimDisplayLine(line) {
    const width = getDisplayWidth();
    const maxLen = Math.max(40, width - 4);
    if (line.length <= maxLen) return line;
    return `${line.slice(0, Math.max(0, maxLen - 3))}...`;
  }

  function printProgressLine(line) {
    const display = trimDisplayLine(line);
    if (display !== lastPrintedLine) {
      console.log(display);
      lastPrintedLine = display;
    }
  }

  function elapsedSeconds() {
    return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  }

  function setPhase(nextPhase) {
    if (!nextPhase || nextPhase === currentPhase) return;
    currentPhase = nextPhase;
    const phaseLine =
      nextPhase === "install"
        ? "  Installing OpenShell components..."
        : nextPhase === "pod"
          ? "  Starting OpenShell gateway pod..."
          : nextPhase === "health"
            ? "  Waiting for gateway health..."
            : "  Starting gateway cluster...";
    printProgressLine(phaseLine);
  }

  function classifyLine(line) {
    if (/ApplyJob|helm-install-openshell|Applying HelmChart/i.test(line)) return "install";
    if (
      /openshell-0|Observed pod startup duration|MountVolume\.MountDevice succeeded/i.test(line)
    ) {
      return "pod";
    }
    if (/Gateway .* ready\.?$/i.test(line)) return "health";
    return null;
  }

  function flushLine(rawLine) {
    const line = rawLine.replace(/\r/g, "").trimEnd();
    if (!line) return;
    lines.push(line);
    lastOutputAt = Date.now();
    const nextPhase = classifyLine(line);
    if (nextPhase) setPhase(nextPhase);
  }

  function onChunk(chunk) {
    pending += chunk.toString();
    const parts = pending.split("\n");
    pending = parts.pop();
    parts.forEach(flushLine);
  }

  function finish(result) {
    if (settled) return;
    settled = true;
    if (pending) flushLine(pending);
    clearInterval(heartbeatTimer);
    resolvePromise(result);
  }

  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);

  printProgressLine("  Starting gateway cluster...");
  const heartbeatTimer = setInterval(() => {
    if (settled) return;
    const elapsed = elapsedSeconds();
    const bucket = Math.floor(elapsed / 10);
    if (bucket === lastHeartbeatBucket) return;
    if (Date.now() - lastOutputAt < 3000 && elapsed < 10) return;
    const heartbeatLine =
      currentPhase === "install"
        ? `  Still installing OpenShell components... (${elapsed}s elapsed)`
        : currentPhase === "pod"
          ? `  Still starting OpenShell gateway pod... (${elapsed}s elapsed)`
          : currentPhase === "health"
            ? `  Still waiting for gateway health... (${elapsed}s elapsed)`
            : `  Still starting gateway cluster... (${elapsed}s elapsed)`;
    printProgressLine(heartbeatLine);
    lastHeartbeatBucket = bucket;
  }, 5000);
  heartbeatTimer.unref?.();

  return new Promise((resolve) => {
    resolvePromise = resolve;
    child.on("error", (error) => {
      const detail = error?.message || String(error);
      lines.push(detail);
      finish({ status: 1, output: lines.join("\n") });
    });
    child.on("close", (code) => {
      finish({ status: code ?? 1, output: lines.join("\n") });
    });
  });
}

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

function sandboxExistsInGateway(sandboxName) {
  const output = runCaptureOpenshell(["sandbox", "get", sandboxName], { ignoreError: true });
  return Boolean(output);
}

function pruneStaleSandboxEntry(sandboxName) {
  const existing = registry.getSandbox(sandboxName);
  const liveExists = sandboxExistsInGateway(sandboxName);
  if (existing && !liveExists) {
    registry.removeSandbox(sandboxName);
  }
  return liveExists;
}

function buildSandboxConfigSyncScript(selectionConfig) {
  // openclaw.json is immutable (root:root 444, Landlock read-only) — never
  // write to it at runtime.  Model routing is handled by the host-side
  // gateway (`openshell inference set` in Step 5), not from inside the
  // sandbox.  We only write the NemoClaw selection config (~/.nemoclaw/).
  return `
set -euo pipefail
mkdir -p ~/.nemoclaw
cat > ~/.nemoclaw/config.json <<'EOF_NEMOCLAW_CFG'
${JSON.stringify(selectionConfig, null, 2)}
EOF_NEMOCLAW_CFG
exit
`.trim();
}

function isOpenclawReady(sandboxName) {
  return Boolean(fetchGatewayAuthTokenFromSandbox(sandboxName));
}

function writeSandboxConfigSyncFile(script) {
  const scriptFile = secureTempFile("nemoclaw-sync", ".sh");
  fs.writeFileSync(scriptFile, `${script}\n`, { mode: 0o600 });
  return scriptFile;
}

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

function destroyGateway() {
  const destroyResult = runOpenshell(["gateway", "destroy", "-g", GATEWAY_NAME], {
    ignoreError: true,
  });
  // Clear the local registry so `nemoclaw list` stays consistent with OpenShell state. (#532)
  if (destroyResult.status === 0) {
    registry.clearAll();
  }
  // openshell gateway destroy doesn't remove Docker volumes, which leaves
  // corrupted cluster state that breaks the next gateway start. Clean them up.
  run(
    `docker volume ls -q --filter "name=openshell-cluster-${GATEWAY_NAME}" | grep . && docker volume ls -q --filter "name=openshell-cluster-${GATEWAY_NAME}" | xargs docker volume rm || true`,
    { ignoreError: true },
  );
}

async function ensureNamedCredential(envName, label, helpUrl = null) {
  let key = getCredential(envName);
  if (key) {
    process.env[envName] = key;
    return key;
  }
  return replaceNamedCredential(envName, label, helpUrl);
}

function waitForSandboxReady(sandboxName, attempts = 10, delaySeconds = 2) {
  for (let i = 0; i < attempts; i += 1) {
    const podPhase = runCaptureOpenshell(
      [
        "doctor",
        "exec",
        "--",
        "kubectl",
        "-n",
        "openshell",
        "get",
        "pod",
        sandboxName,
        "-o",
        "jsonpath={.status.phase}",
      ],
      { ignoreError: true },
    );
    if (podPhase === "Running") return true;
    sleep(delaySeconds);
  }
  return false;
}

// parsePolicyPresetEnv — see urlUtils import above
// isSafeModelId — see validation import above

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
    console.error("  Model values may only contain letters, numbers, '.', '_', ':', '/', and '-'.");
    process.exit(1);
  }
  return model;
}

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

async function startGatewayWithOptions(_gpu, { exitOnFailure = true } = {}) {
  step(2, 8, "Starting OpenShell gateway");

  const gatewayStatus = runCaptureOpenshell(["status"], { ignoreError: true });
  const gwInfo = runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], {
    ignoreError: true,
  });
  const activeGatewayInfo = runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
  if (isGatewayHealthy(gatewayStatus, gwInfo, activeGatewayInfo)) {
    console.log("  ✓ Reusing existing gateway");
    runOpenshell(["gateway", "select", GATEWAY_NAME], { ignoreError: true });
    process.env.OPENSHELL_GATEWAY = GATEWAY_NAME;
    return;
  }

  // When a stale gateway is detected (metadata exists but container is gone,
  // e.g. after a Docker/Colima restart), skip the destroy — `gateway start`
  // can recover the container without wiping metadata and mTLS certs.
  // The retry loop below will destroy only if start genuinely fails.
  if (hasStaleGateway(gwInfo)) {
    console.log("  Stale gateway detected — attempting restart without destroy...");
  }

  // Clear stale SSH host keys from previous gateway (fixes #768)
  try {
    const { execFileSync } = require("child_process");
    execFileSync("ssh-keygen", ["-R", `openshell-${GATEWAY_NAME}`], { stdio: "ignore" });
  } catch {
    /* ssh-keygen -R may fail if entry doesn't exist — safe to ignore */
  }
  // Also purge any known_hosts entries matching the gateway hostname pattern
  const knownHostsPath = path.join(os.homedir(), ".ssh", "known_hosts");
  if (fs.existsSync(knownHostsPath)) {
    try {
      const kh = fs.readFileSync(knownHostsPath, "utf8");
      const cleaned = pruneKnownHostsEntries(kh);
      if (cleaned !== kh) fs.writeFileSync(knownHostsPath, cleaned);
    } catch {
      /* best-effort cleanup — ignore read/write errors */
    }
  }

  const gwArgs = ["--name", GATEWAY_NAME];
  // Do NOT pass --gpu here. On DGX Spark (and most GPU hosts), inference is
  // routed through a host-side provider (Ollama, vLLM, or cloud API) — the
  // sandbox itself does not need direct GPU access. Passing --gpu causes
  // FailedPrecondition errors when the gateway's k3s device plugin cannot
  // allocate GPUs. See: https://build.nvidia.com/spark/nemoclaw/instructions
  const gatewayEnv = getGatewayStartEnv();
  if (gatewayEnv.OPENSHELL_CLUSTER_IMAGE) {
    console.log(`  Using pinned OpenShell gateway image: ${gatewayEnv.OPENSHELL_CLUSTER_IMAGE}`);
  }

  // Retry gateway start with exponential backoff. On some hosts (Horde VMs,
  // first-run environments) the embedded k3s needs more time than OpenShell's
  // internal health-check window allows. Retrying after a clean destroy lets
  // the second attempt benefit from cached images and cleaner cgroup state.
  // See: https://github.com/NVIDIA/OpenShell/issues/433
  const retries = exitOnFailure ? 2 : 0;
  try {
    await pRetry(
      async () => {
        const startResult = await streamGatewayStart(
          openshellShellCommand(["gateway", "start", ...gwArgs]),
          {
            ...process.env,
            ...gatewayEnv,
          },
        );
        if (startResult.status !== 0) {
          const output = compactText(String(startResult.output || ""));
          if (output) {
            console.log(`  Gateway start returned before healthy: ${output.slice(0, 240)}`);
          }
        }
        console.log("  Waiting for gateway health...");

        const healthPollCount = envInt("NEMOCLAW_HEALTH_POLL_COUNT", 5);
        const healthPollInterval = envInt("NEMOCLAW_HEALTH_POLL_INTERVAL", 2);
        for (let i = 0; i < healthPollCount; i++) {
          const status = runCaptureOpenshell(["status"], { ignoreError: true });
          const namedInfo = runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], {
            ignoreError: true,
          });
          const currentInfo = runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
          if (isGatewayHealthy(status, namedInfo, currentInfo)) {
            return; // success
          }
          if (i < healthPollCount - 1) sleep(healthPollInterval);
        }

        throw new Error("Gateway failed to start");
      },
      {
        retries,
        minTimeout: 10_000,
        factor: 3,
        onFailedAttempt: (err) => {
          console.log(
            `  Gateway start attempt ${err.attemptNumber} failed. ${err.retriesLeft} retries left...`,
          );
          if (err.retriesLeft > 0 && exitOnFailure) {
            destroyGateway();
          }
        },
      },
    );
  } catch {
    if (exitOnFailure) {
      console.error(`  Gateway failed to start after ${retries + 1} attempts.`);
      console.error("  Gateway state preserved for diagnostics.");
      console.error("");
      console.error("  Troubleshooting:");
      console.error("    openshell doctor logs --name nemoclaw");
      console.error("    openshell doctor check");
      process.exit(1);
    }
    throw new Error("Gateway failed to start");
  }

  console.log("  ✓ Gateway is healthy");

  // CoreDNS fix — k3s-inside-Docker has broken DNS forwarding on all platforms.
  const runtime = getContainerRuntime();
  if (shouldPatchCoredns(runtime)) {
    console.log("  Patching CoreDNS DNS forwarding...");
    run(`bash "${path.join(SCRIPTS, "fix-coredns.sh")}" ${GATEWAY_NAME} 2>&1 || true`, {
      ignoreError: true,
    });
  }
  sleep(5);
  runOpenshell(["gateway", "select", GATEWAY_NAME], { ignoreError: true });
  process.env.OPENSHELL_GATEWAY = GATEWAY_NAME;
}

async function startGateway(_gpu) {
  return startGatewayWithOptions(_gpu, { exitOnFailure: true });
}

async function startGatewayForRecovery(_gpu) {
  return startGatewayWithOptions(_gpu, { exitOnFailure: false });
}

function getGatewayStartEnv() {
  const gatewayEnv = {};
  const openshellVersion = getInstalledOpenshellVersion();
  const stableGatewayImage = openshellVersion
    ? `ghcr.io/nvidia/openshell/cluster:${openshellVersion}`
    : null;
  if (stableGatewayImage && openshellVersion) {
    gatewayEnv.OPENSHELL_CLUSTER_IMAGE = stableGatewayImage;
    gatewayEnv.IMAGE_TAG = openshellVersion;
  }
  return gatewayEnv;
}

async function recoverGatewayRuntime() {
  runOpenshell(["gateway", "select", GATEWAY_NAME], { ignoreError: true });
  let status = runCaptureOpenshell(["status"], { ignoreError: true });
  if (status.includes("Connected") && isSelectedGateway(status)) {
    process.env.OPENSHELL_GATEWAY = GATEWAY_NAME;
    return true;
  }

  const startResult = runOpenshell(["gateway", "start", "--name", GATEWAY_NAME], {
    ignoreError: true,
    env: getGatewayStartEnv(),
    suppressOutput: true,
  });
  if (startResult.status !== 0) {
    const diagnostic = compactText(
      redact(`${startResult.stderr || ""} ${startResult.stdout || ""}`),
    );
    console.error(`  Gateway restart failed (exit ${startResult.status}).`);
    if (diagnostic) {
      console.error(`  ${diagnostic.slice(0, 240)}`);
    }
  }
  runOpenshell(["gateway", "select", GATEWAY_NAME], { ignoreError: true });

  const recoveryPollCount = envInt("NEMOCLAW_HEALTH_POLL_COUNT", 10);
  const recoveryPollInterval = envInt("NEMOCLAW_HEALTH_POLL_INTERVAL", 2);
  for (let i = 0; i < recoveryPollCount; i++) {
    status = runCaptureOpenshell(["status"], { ignoreError: true });
    if (status.includes("Connected") && isSelectedGateway(status)) {
      process.env.OPENSHELL_GATEWAY = GATEWAY_NAME;
      const runtime = getContainerRuntime();
      if (shouldPatchCoredns(runtime)) {
        run(`bash "${path.join(SCRIPTS, "fix-coredns.sh")}" ${GATEWAY_NAME} 2>&1 || true`, {
          ignoreError: true,
        });
      }
      return true;
    }
    if (i < recoveryPollCount - 1) sleep(recoveryPollInterval);
  }

  return false;
}

// ── Step 3: Sandbox ──────────────────────────────────────────────

async function promptValidatedSandboxName() {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const nameAnswer = await promptOrDefault(
      "  Sandbox name (lowercase, starts with letter, hyphens ok) [my-assistant]: ",
      "NEMOCLAW_SANDBOX_NAME",
      "my-assistant",
    );
    const sandboxName = (nameAnswer || "my-assistant").trim().toLowerCase();

    // Validate: RFC 1123 subdomain — lowercase alphanumeric and hyphens,
    // must start with a letter (not a digit) to satisfy Kubernetes naming.
    if (/^[a-z]([a-z0-9-]*[a-z0-9])?$/.test(sandboxName)) {
      return sandboxName;
    }

    console.error(`  Invalid sandbox name: '${sandboxName}'`);
    if (/^[0-9]/.test(sandboxName)) {
      console.error("  Names must start with a letter, not a digit.");
    } else {
      console.error("  Names must be lowercase, contain only letters, numbers, and hyphens,");
      console.error("  must start with a letter, and end with a letter or number.");
    }

    // Non-interactive runs cannot re-prompt — abort so the caller can fix the
    // NEMOCLAW_SANDBOX_NAME env var and retry.
    if (isNonInteractive()) {
      process.exit(1);
    }

    if (attempt < MAX_ATTEMPTS - 1) {
      console.error("  Please try again.\n");
    }
  }

  console.error("  Too many invalid attempts.");
  process.exit(1);
}

// ── Step 5: Sandbox ──────────────────────────────────────────────

// eslint-disable-next-line complexity
async function createSandbox(
  gpu,
  model,
  provider,
  preferredInferenceApi = null,
  sandboxNameOverride = null,
  webSearchConfig = null,
  enabledChannels = null,
  fromDockerfile = null,
  agent = null,
  dangerouslySkipPermissions = false,
) {
  step(6, 8, "Creating sandbox");

  const sandboxName = sandboxNameOverride || (await promptValidatedSandboxName());
  const effectivePort = agent ? agent.forwardPort : CONTROL_UI_PORT;
  const chatUiUrl = process.env.CHAT_UI_URL || `http://127.0.0.1:${effectivePort}`;

  // Check whether messaging providers will be needed — this must happen before
  // the sandbox reuse decision so we can detect stale sandboxes that were created
  // without provider attachments (security: prevents legacy raw-env-var leaks).
  const getMessagingToken = (envKey) =>
    getCredential(envKey) || normalizeCredentialValue(process.env[envKey]) || null;

  // When enabledChannels is provided (from the toggle picker), only include
  // channels the user selected. When null (backward compat), include all.
  const enabledEnvKeys =
    enabledChannels != null
      ? new Set(
          MESSAGING_CHANNELS.filter((c) => enabledChannels.includes(c.name)).map((c) => c.envKey),
        )
      : null;

  const messagingTokenDefs = [
    {
      name: `${sandboxName}-discord-bridge`,
      envKey: "DISCORD_BOT_TOKEN",
      token: getMessagingToken("DISCORD_BOT_TOKEN"),
    },
    {
      name: `${sandboxName}-slack-bridge`,
      envKey: "SLACK_BOT_TOKEN",
      token: getMessagingToken("SLACK_BOT_TOKEN"),
    },
    {
      name: `${sandboxName}-telegram-bridge`,
      envKey: "TELEGRAM_BOT_TOKEN",
      token: getMessagingToken("TELEGRAM_BOT_TOKEN"),
    },
  ].filter(({ envKey }) => !enabledEnvKeys || enabledEnvKeys.has(envKey));
  const hasMessagingTokens = messagingTokenDefs.some(({ token }) => !!token);

  // Reconcile local registry state with the live OpenShell gateway state.
  const liveExists = pruneStaleSandboxEntry(sandboxName);

  if (liveExists) {
    const existingSandboxState = getSandboxReuseState(sandboxName);

    // Check whether messaging providers are missing from the gateway. Only
    // force recreation when at least one required provider doesn't exist yet —
    // this avoids destroying sandboxes already created with provider attachments.
    const needsProviderMigration =
      hasMessagingTokens &&
      messagingTokenDefs.some(({ name, token }) => token && !providerExistsInGateway(name));

    if (!isRecreateSandbox() && !needsProviderMigration) {
      if (isNonInteractive()) {
        if (existingSandboxState === "ready") {
          // Upsert messaging providers even on reuse so credential changes take
          // effect without requiring a full sandbox recreation.
          upsertMessagingProviders(messagingTokenDefs);
          note(`  [non-interactive] Sandbox '${sandboxName}' exists and is ready — reusing it`);
          note("  Pass --recreate-sandbox or set NEMOCLAW_RECREATE_SANDBOX=1 to force recreation.");
          ensureDashboardForward(sandboxName, chatUiUrl);
          return sandboxName;
        }
        console.error(`  Sandbox '${sandboxName}' already exists but is not ready.`);
        console.error("  Pass --recreate-sandbox or set NEMOCLAW_RECREATE_SANDBOX=1 to overwrite.");
        process.exit(1);
      }

      if (existingSandboxState === "ready") {
        console.log(`  Sandbox '${sandboxName}' already exists.`);
        console.log("  Choosing 'n' will delete the existing sandbox and create a new one.");
        const answer = await promptOrDefault("  Reuse existing sandbox? [Y/n]: ", null, "y");
        const normalizedAnswer = answer.trim().toLowerCase();
        if (normalizedAnswer !== "n" && normalizedAnswer !== "no") {
          upsertMessagingProviders(messagingTokenDefs);
          ensureDashboardForward(sandboxName, chatUiUrl);
          return sandboxName;
        }
      } else {
        console.log(`  Sandbox '${sandboxName}' exists but is not ready.`);
        console.log("  Selecting 'n' will abort onboarding.");
        const answer = await promptOrDefault(
          "  Delete it and create a new one? [Y/n]: ",
          null,
          "y",
        );
        const normalizedAnswer = answer.trim().toLowerCase();
        if (normalizedAnswer === "n" || normalizedAnswer === "no") {
          console.log("  Aborting onboarding.");
          process.exit(1);
        }
      }
    }

    if (needsProviderMigration) {
      console.log(`  Sandbox '${sandboxName}' exists but messaging providers are not attached.`);
      console.log("  Recreating to ensure credentials flow through the provider pipeline.");
    } else if (existingSandboxState === "ready") {
      note(`  Sandbox '${sandboxName}' exists and is ready — recreating by explicit request.`);
    } else {
      note(`  Sandbox '${sandboxName}' exists but is not ready — recreating it.`);
    }

    note(`  Deleting and recreating sandbox '${sandboxName}'...`);

    // Destroy old sandbox
    runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });
    registry.removeSandbox(sandboxName);
  }

  // Stage build context — use the custom Dockerfile path when provided,
  // otherwise use the optimised default that only sends what the build needs.
  let buildCtx, stagedDockerfile;
  if (fromDockerfile) {
    const fromResolved = path.resolve(fromDockerfile);
    if (!fs.existsSync(fromResolved)) {
      console.error(`  Custom Dockerfile not found: ${fromResolved}`);
      process.exit(1);
    }
    buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-"));
    stagedDockerfile = path.join(buildCtx, "Dockerfile");
    // Copy the entire parent directory as build context.
    fs.cpSync(path.dirname(fromResolved), buildCtx, {
      recursive: true,
      filter: (src) => {
        const base = path.basename(src);
        return !["node_modules", ".git", ".venv", "__pycache__"].includes(base);
      },
    });
    // If the caller pointed at a file not named "Dockerfile", copy it to the
    // location openshell expects (buildCtx/Dockerfile).
    if (path.basename(fromResolved) !== "Dockerfile") {
      fs.copyFileSync(fromResolved, stagedDockerfile);
    }
    console.log(`  Using custom Dockerfile: ${fromResolved}`);
  } else if (agent) {
    const agentBuild = agentOnboard.createAgentSandbox(agent);
    buildCtx = agentBuild.buildCtx;
    stagedDockerfile = agentBuild.stagedDockerfile;
  } else {
    ({ buildCtx, stagedDockerfile } = stageOptimizedSandboxBuildContext(ROOT));
  }

  // Create sandbox (use -- echo to avoid dropping into interactive shell)
  // Pass the base policy so sandbox starts in proxy mode (required for policy updates later)
  const globalPermissivePath = path.join(
    ROOT,
    "nemoclaw-blueprint",
    "policies",
    "openclaw-sandbox-permissive.yaml",
  );
  let basePolicyPath;
  if (dangerouslySkipPermissions) {
    // Permissive mode: use agent-specific permissive policy if available,
    // otherwise fall back to the global permissive policy.
    const agentPermissive = agent && agentOnboard.getAgentPermissivePolicyPath(agent);
    basePolicyPath = agentPermissive || globalPermissivePath;
  } else {
    const defaultPolicyPath = path.join(
      ROOT,
      "nemoclaw-blueprint",
      "policies",
      "openclaw-sandbox.yaml",
    );
    basePolicyPath = (agent && agentOnboard.getAgentPolicyPath(agent)) || defaultPolicyPath;
  }
  const createArgs = [
    "--from",
    `${buildCtx}/Dockerfile`,
    "--name",
    sandboxName,
    "--policy",
    basePolicyPath,
  ];
  // --gpu is intentionally omitted. See comment in startGateway().

  // Create OpenShell providers for messaging credentials so they flow through
  // the provider/placeholder system instead of raw env vars. The L7 proxy
  // rewrites Authorization headers (Bearer/Bot) and URL-path segments
  // (/bot{TOKEN}/) with real secrets at egress (OpenShell ≥ 0.0.20).
  const messagingProviders = upsertMessagingProviders(messagingTokenDefs);
  for (const p of messagingProviders) {
    createArgs.push("--provider", p);
  }

  console.log(`  Creating sandbox '${sandboxName}' (this takes a few minutes on first run)...`);
  if (webSearchConfig && !getCredential(webSearch.BRAVE_API_KEY_ENV)) {
    console.error("  Brave Search is enabled, but BRAVE_API_KEY is not available in this process.");
    console.error(
      "  Re-run with BRAVE_API_KEY set, or disable Brave Search before recreating the sandbox.",
    );
    process.exit(1);
  }
  const activeMessagingChannels = messagingTokenDefs
    .filter(({ token }) => !!token)
    .map(({ envKey }) => {
      if (envKey === "DISCORD_BOT_TOKEN") return "discord";
      if (envKey === "SLACK_BOT_TOKEN") return "slack";
      if (envKey === "TELEGRAM_BOT_TOKEN") return "telegram";
      return null;
    })
    .filter(Boolean);
  // Build allowed sender IDs map from env vars set during the messaging prompt.
  // Each channel with a userIdEnvKey in MESSAGING_CHANNELS may have a
  // comma-separated list of IDs (e.g. TELEGRAM_ALLOWED_IDS="123,456").
  const messagingAllowedIds = {};
  const enabledTokenEnvKeys = new Set(messagingTokenDefs.map(({ envKey }) => envKey));
  for (const ch of MESSAGING_CHANNELS) {
    if (
      enabledTokenEnvKeys.has(ch.envKey) &&
      ch.allowIdsMode === "dm" &&
      ch.userIdEnvKey &&
      process.env[ch.userIdEnvKey]
    ) {
      const ids = process.env[ch.userIdEnvKey]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.length > 0) messagingAllowedIds[ch.name] = ids;
    }
  }
  const discordGuilds = {};
  if (enabledTokenEnvKeys.has("DISCORD_BOT_TOKEN")) {
    const serverIds = (process.env.DISCORD_SERVER_IDS || process.env.DISCORD_SERVER_ID || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const userIds = (process.env.DISCORD_ALLOWED_IDS || process.env.DISCORD_USER_ID || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const serverId of serverIds) {
      if (!DISCORD_SNOWFLAKE_RE.test(serverId)) {
        console.warn(`  Warning: Discord server ID '${serverId}' does not look like a snowflake.`);
      }
    }
    for (const userId of userIds) {
      if (!DISCORD_SNOWFLAKE_RE.test(userId)) {
        console.warn(`  Warning: Discord user ID '${userId}' does not look like a snowflake.`);
      }
    }
    const requireMention = process.env.DISCORD_REQUIRE_MENTION !== "0";
    for (const serverId of serverIds) {
      discordGuilds[serverId] = {
        requireMention,
        ...(userIds.length > 0 ? { users: userIds } : {}),
      };
    }
  }
  patchStagedDockerfile(
    stagedDockerfile,
    model,
    chatUiUrl,
    String(Date.now()),
    provider,
    preferredInferenceApi,
    webSearchConfig,
    activeMessagingChannels,
    messagingAllowedIds,
    discordGuilds,
  );
  // Only pass non-sensitive env vars to the sandbox. Credentials flow through
  // OpenShell providers — the gateway injects them as placeholders and the L7
  // proxy rewrites Authorization headers with real secrets at egress.
  // See: crates/openshell-sandbox/src/secrets.rs (placeholder rewriting),
  //      crates/openshell-router/src/backend.rs (inference auth injection).
  const envArgs = [formatEnvAssignment("CHAT_UI_URL", chatUiUrl)];
  const blockedSandboxEnvNames = new Set([
    // Derived from REMOTE_PROVIDER_CONFIG to prevent drift
    ...Object.values(REMOTE_PROVIDER_CONFIG)
      .map((cfg) => cfg.credentialEnv)
      .filter(Boolean),
    // Additional credentials not in REMOTE_PROVIDER_CONFIG
    "BEDROCK_API_KEY",
    "DISCORD_BOT_TOKEN",
    "SLACK_BOT_TOKEN",
    "TELEGRAM_BOT_TOKEN",
  ]);
  const sandboxEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !blockedSandboxEnvNames.has(name)),
  );
  // Run without piping through awk — the pipe masked non-zero exit codes
  // from openshell because bash returns the status of the last pipeline
  // command (awk, always 0) unless pipefail is set. Removing the pipe
  // lets the real exit code flow through to run().
  const createCommand = `${openshellShellCommand([
    "sandbox",
    "create",
    ...createArgs,
    "--",
    "env",
    ...envArgs,
    "nemoclaw-start",
  ])} 2>&1`;
  const createResult = await streamSandboxCreate(createCommand, sandboxEnv, {
    readyCheck: () => {
      const list = runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
      return isSandboxReady(list, sandboxName);
    },
  });

  // Clean up build context regardless of outcome
  run(`rm -rf "${buildCtx}"`, { ignoreError: true });

  if (createResult.status !== 0) {
    const failure = classifySandboxCreateFailure(createResult.output);
    if (failure.kind === "sandbox_create_incomplete") {
      // The sandbox was created in the gateway but the create stream exited
      // with a non-zero code (e.g. SSH 255).  Fall through to the ready-wait
      // loop — the sandbox may still reach Ready on its own.
      console.warn("");
      console.warn(
        `  Create stream exited with code ${createResult.status} after sandbox was created.`,
      );
      console.warn("  Checking whether the sandbox reaches Ready state...");
    } else {
      console.error("");
      console.error(`  Sandbox creation failed (exit ${createResult.status}).`);
      if (createResult.output) {
        console.error("");
        console.error(createResult.output);
      }
      console.error("  Try:  openshell sandbox list        # check gateway state");
      printSandboxCreateRecoveryHints(createResult.output);
      process.exit(createResult.status || 1);
    }
  }

  // Wait for sandbox to reach Ready state in k3s before registering.
  // On WSL2 + Docker Desktop the pod can take longer to initialize;
  // without this gate, NemoClaw registers a phantom sandbox that
  // causes "sandbox not found" on every subsequent connect/status call.
  console.log("  Waiting for sandbox to become ready...");
  let ready = false;
  for (let i = 0; i < 30; i++) {
    const list = runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
    if (isSandboxReady(list, sandboxName)) {
      ready = true;
      break;
    }
    sleep(2);
  }

  if (!ready) {
    // Clean up the orphaned sandbox so the next onboard retry with the same
    // name doesn't fail on "sandbox already exists".
    const delResult = runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });
    console.error("");
    console.error(`  Sandbox '${sandboxName}' was created but did not become ready within 60s.`);
    if (delResult.status === 0) {
      console.error("  The orphaned sandbox has been removed — you can safely retry.");
    } else {
      console.error(`  Could not remove the orphaned sandbox. Manual cleanup:`);
      console.error(`    openshell sandbox delete "${sandboxName}"`);
    }
    console.error("  Retry: nemoclaw onboard");
    process.exit(1);
  }

  // Wait for NemoClaw dashboard to become fully ready (web server live)
  // This prevents port forwards from connecting to a non-existent port
  // or seeing 502/503 errors during initial load.
  console.log("  Waiting for NemoClaw dashboard to become ready...");
  for (let i = 0; i < 15; i++) {
    const readyMatch = runCapture(
      `openshell sandbox exec ${shellQuote(sandboxName)} curl -sf http://localhost:18789/ 2>/dev/null || echo "no"`,
      { ignoreError: true },
    );
    if (readyMatch && !readyMatch.includes("no")) {
      console.log("  ✓ Dashboard is live");
      break;
    }
    if (i === 14) {
      console.warn("  Dashboard taking longer than expected to start. Continuing...");
    } else {
      sleep(2);
    }
  }

  // Release any stale forward on port 18789 before claiming it for the new sandbox.
  // A previous onboard run may have left the port forwarded to a different sandbox,
  // which would silently prevent the new sandbox's dashboard from being reachable.
  ensureDashboardForward(sandboxName, chatUiUrl);

  // Register only after confirmed ready — prevents phantom entries
  registry.registerSandbox({
    name: sandboxName,
    gpuEnabled: !!gpu,
    agent: agent ? agent.name : null,
    dangerouslySkipPermissions: dangerouslySkipPermissions || undefined,
  });

  // DNS proxy — run a forwarder in the sandbox pod so the isolated
  // sandbox namespace can resolve hostnames (fixes #626).
  console.log("  Setting up sandbox DNS proxy...");
  run(
    `bash "${path.join(SCRIPTS, "setup-dns-proxy.sh")}" ${shellQuote(GATEWAY_NAME)} ${shellQuote(sandboxName)} 2>&1 || true`,
    { ignoreError: true },
  );

  // Check that messaging providers exist in the gateway (sandbox attachment
  // cannot be verified via CLI yet — only gateway-level existence is checked).
  for (const p of messagingProviders) {
    if (!providerExistsInGateway(p)) {
      console.error(`  ⚠ Messaging provider '${p}' was not found in the gateway.`);
      console.error(`    The credential may not be available inside the sandbox.`);
      console.error(
        `    To fix: openshell provider create --name ${p} --type generic --credential <KEY>`,
      );
    }
  }

  console.log(`  ✓ Sandbox '${sandboxName}' created`);
  return sandboxName;
}

// ── Step 3: Inference selection ──────────────────────────────────

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
