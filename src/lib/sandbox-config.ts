// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Host-side sandbox configuration management.
//
// config get:          Read-only inspection with credential redaction.
// config set:          Host-initiated config mutation with validation.
// config rotate-token: Credential rotation via stdin or env var.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { run, runCapture, runArrayCmd, validateName, shellQuote } = require("./runner");
const { stripCredentials } = require("./credential-filter");
const { appendAuditEntry } = require("./shields-audit");
const {
  runOpenshellCommand,
  captureOpenshellCommand,
} = require("./openshell");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getOpenshellBinary(): string {
  return process.env.NEMOCLAW_OPENSHELL_BIN || "openshell";
}

function getOpenshellCommand(): string {
  const binary = process.env.NEMOCLAW_OPENSHELL_BIN;
  if (!binary) return "openshell";
  return shellQuote(binary);
}

function extractDotpath(obj: unknown, dotpath: string): unknown {
  const keys = dotpath.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function setDotpath(obj: Record<string, unknown>, dotpath: string, value: unknown): void {
  const keys = dotpath.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current[key] == null || typeof current[key] !== "object" || Array.isArray(current[key])) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

/**
 * Read the raw openclaw.json from a running sandbox.
 * Returns the parsed config object or exits on failure.
 */
function readSandboxConfig(sandboxName: string): Record<string, unknown> {
  const openshell = getOpenshellCommand();
  const cmd = `${openshell} sandbox exec ${shellQuote(sandboxName)} cat /sandbox/.openclaw/openclaw.json 2>/dev/null`;

  let raw: string;
  try {
    raw = runCapture(cmd, { ignoreError: true });
  } catch {
    raw = "";
  }

  if (!raw || !raw.trim()) {
    console.error("  Cannot read sandbox config. Is the sandbox running?");
    process.exit(1);
  }

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  Failed to parse sandbox config: ${message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// URL validation (lightweight SSRF check for config set)
// ---------------------------------------------------------------------------

const PRIVATE_IP_PREFIXES = [
  "127.", "10.", "0.", "169.254.",
  "192.168.",
];

const PRIVATE_IP_172_RE = /^172\.(1[6-9]|2[0-9]|3[01])\./;

function isPrivateIp(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  for (const prefix of PRIVATE_IP_PREFIXES) {
    if (hostname.startsWith(prefix)) return true;
  }
  if (PRIVATE_IP_172_RE.test(hostname)) return true;
  return false;
}

function validateUrlValue(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return; // Not a URL — skip validation
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`URL scheme "${parsed.protocol}" is not allowed. Use http: or https:.`);
  }

  if (isPrivateIp(parsed.hostname)) {
    throw new Error(
      `URL points to private/internal address "${parsed.hostname}". ` +
      `This could expose internal services to the sandbox.`,
    );
  }
}

// ---------------------------------------------------------------------------
// config get
// ---------------------------------------------------------------------------

interface ConfigGetOpts {
  key?: string | null;
  format?: string;
}

function configGet(sandboxName: string, opts: ConfigGetOpts = {}): void {
  validateName(sandboxName, "sandbox name");

  let config: unknown = readSandboxConfig(sandboxName);

  // Strip credentials before display
  config = stripCredentials(config);

  // Remove gateway section (contains auth tokens — per migration-state.ts pattern)
  if (config && typeof config === "object" && !Array.isArray(config)) {
    delete (config as Record<string, unknown>).gateway;
  }

  // Extract dotpath if specified
  if (opts.key) {
    const value = extractDotpath(config, opts.key);
    if (value === undefined) {
      console.error(`  Key "${opts.key}" not found in sandbox config.`);
      process.exit(1);
    }
    config = value;
  }

  // Format output
  const format = opts.format || "json";
  if (format === "yaml") {
    const YAML = require("yaml");
    console.log(YAML.stringify(config));
  } else {
    console.log(JSON.stringify(config, null, 2));
  }
}

// ---------------------------------------------------------------------------
// config set
// ---------------------------------------------------------------------------

interface ConfigSetOpts {
  key?: string | null;
  value?: string | null;
  restart?: boolean;
}

function configSet(sandboxName: string, opts: ConfigSetOpts = {}): void {
  validateName(sandboxName, "sandbox name");

  if (!opts.key) {
    console.error("  --key is required.");
    console.error("  Usage: nemoclaw <name> config set --key <dotpath> --value <value>");
    process.exit(1);
  }

  if (opts.value === undefined || opts.value === null) {
    console.error("  --value is required.");
    console.error("  Usage: nemoclaw <name> config set --key <dotpath> --value <value>");
    process.exit(1);
  }

  // 1. Read current config
  console.log("  Reading current config...");
  const config = readSandboxConfig(sandboxName);

  // 2. Parse and validate value
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(opts.value);
  } catch {
    // Not valid JSON — treat as string literal
    parsedValue = opts.value;
  }

  // 3. Validate URLs for SSRF
  if (typeof parsedValue === "string" && (parsedValue.startsWith("http://") || parsedValue.startsWith("https://"))) {
    try {
      validateUrlValue(parsedValue);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  URL validation failed: ${message}`);
      process.exit(1);
    }
  }

  // 4. Check that we're not modifying the gateway section (contains auth tokens)
  if (opts.key.startsWith("gateway.") || opts.key === "gateway") {
    console.error("  Cannot modify the gateway section directly.");
    console.error("  Use `nemoclaw config rotate-token` for credential changes.");
    process.exit(1);
  }

  // 5. Show what will change
  const oldValue = extractDotpath(config, opts.key);
  console.log(`  Key:       ${opts.key}`);
  console.log(`  Old value: ${oldValue !== undefined ? JSON.stringify(oldValue) : "(not set)"}`);
  console.log(`  New value: ${JSON.stringify(parsedValue)}`);

  // 6. Apply change
  setDotpath(config, opts.key, parsedValue);

  // 7. Write to temp file
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-config-"));
  const tmpFile = path.join(tmpDir, "openclaw.json");
  fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2), { mode: 0o600 });

  // 8. Push to sandbox via openshell sandbox cp
  console.log("  Writing config to sandbox...");
  const binary = getOpenshellBinary();
  runOpenshellCommand(binary, [
    "sandbox", "cp", tmpFile, `${sandboxName}:/sandbox/.openclaw/openclaw.json`,
  ], { errorLine: console.error, exit: (code: number) => process.exit(code) });

  // 9. Fix ownership
  runOpenshellCommand(binary, [
    "sandbox", "exec", sandboxName, "chown", "sandbox:sandbox", "/sandbox/.openclaw/openclaw.json",
  ], { ignoreError: true, errorLine: console.error, exit: (code: number) => process.exit(code) });

  // 10. Cleanup temp
  try {
    fs.unlinkSync(tmpFile);
    fs.rmdirSync(tmpDir);
  } catch {
    // Best effort
  }

  // 11. Audit log
  appendAuditEntry({
    action: "shields_down", // reuse audit — we'll use a config-specific action if audit supports it
    sandbox: sandboxName,
    timestamp: new Date().toISOString(),
    reason: `config set ${opts.key}`,
  });

  console.log("  Config updated.");

  // 12. Restart if requested
  if (opts.restart) {
    console.log("  Restarting sandbox agent process...");
    const result = captureOpenshellCommand(binary, [
      "sandbox", "exec", sandboxName, "kill", "-HUP", "1",
    ], { ignoreError: true, errorLine: console.error, exit: (code: number) => process.exit(code) });

    if (result.status !== 0) {
      console.error("  Could not signal the sandbox process to reload.");
      console.error("  You may need to recreate the sandbox for this change to take effect.");
    } else {
      console.log("  Reload signal sent.");
    }
  } else {
    console.log("");
    console.log("  Note: Some config changes require a sandbox restart to take effect.");
    console.log(`  Re-run with --restart or recreate with: nemoclaw onboard --recreate-sandbox`);
  }
}

// ---------------------------------------------------------------------------
// config rotate-token
// ---------------------------------------------------------------------------

interface RotateTokenOpts {
  fromEnv?: string | null;
  fromStdin?: boolean;
}

async function configRotateToken(sandboxName: string, opts: RotateTokenOpts = {}): Promise<void> {
  validateName(sandboxName, "sandbox name");

  // 1. Determine which provider and credentialEnv the sandbox uses
  //    Load the onboard session and verify it matches this sandbox.
  const { loadSession } = require("./onboard-session");
  const session = loadSession();

  if (!session || !session.credentialEnv) {
    console.error(`  Cannot determine credential for sandbox '${sandboxName}'.`);
    console.error("  No onboard session found with a credentialEnv.");
    console.error("  Re-run: nemoclaw onboard --recreate-sandbox");
    process.exit(1);
  }

  if (session.sandboxName && session.sandboxName !== sandboxName) {
    console.error(`  Onboard session is for sandbox '${session.sandboxName}', not '${sandboxName}'.`);
    process.exit(1);
  }

  const credentialEnv: string = session.credentialEnv;
  const providerName: string = session.provider || "inference";

  console.log(`  Provider:       ${providerName}`);
  console.log(`  Credential env: ${credentialEnv}`);

  // 2. Read new token
  let newToken: string | null = null;

  if (opts.fromEnv) {
    newToken = process.env[opts.fromEnv] || null;
    if (!newToken) {
      console.error(`  Environment variable "${opts.fromEnv}" is not set or empty.`);
      process.exit(1);
    }
  } else if (opts.fromStdin) {
    // Read from stdin (piped input)
    newToken = await readStdin();
  } else {
    // Interactive prompt
    const { promptSecret } = require("./credentials");
    newToken = await promptSecret(`  New ${credentialEnv} value: `);
  }

  if (!newToken || !newToken.trim()) {
    console.error("  Token cannot be empty.");
    process.exit(1);
  }

  newToken = newToken.trim();

  // 3. Validate — no whitespace in token
  if (/\s/.test(newToken)) {
    console.error("  Token contains whitespace. This is likely a paste error.");
    process.exit(1);
  }

  // 4. Save credential locally
  const { saveCredential } = require("./credentials");
  saveCredential(credentialEnv, newToken);
  console.log("  Credential saved to ~/.nemoclaw/credentials.json");

  // 5. Update the openshell provider
  console.log("  Updating openshell provider...");
  const binary = getOpenshellBinary();
  const result = runOpenshellCommand(binary, [
    "provider", "update", providerName, "--credential", credentialEnv,
  ], {
    env: { [credentialEnv]: newToken },
    ignoreError: true,
    errorLine: console.error,
    exit: (code: number) => process.exit(code),
  });

  if (result.status !== 0) {
    // Try create if update failed (provider might not exist)
    const providerType = session.providerType || "generic";
    const createResult = runOpenshellCommand(binary, [
      "provider", "create", "--name", providerName, "--type", providerType,
      "--credential", credentialEnv,
    ], {
      env: { [credentialEnv]: newToken },
      ignoreError: true,
      errorLine: console.error,
      exit: (code: number) => process.exit(code),
    });

    if (createResult.status !== 0) {
      console.error("  Failed to update provider. You may need to re-onboard.");
      process.exit(1);
    }
  }

  // 6. Audit log
  appendAuditEntry({
    action: "shields_down", // reuse audit infrastructure
    sandbox: sandboxName,
    timestamp: new Date().toISOString(),
    reason: `rotate-token ${credentialEnv}`,
  });

  // 7. Output (redacted)
  const lastFour = newToken.length > 4 ? newToken.slice(-4) : "****";
  console.log(`  Token rotated: ****${lastFour}`);
  console.log("");
  console.log("  The new credential is active immediately for new sandbox requests.");
}

/**
 * Read all data from stdin until EOF.
 */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8").trim()));
    process.stdin.on("error", reject);
    process.stdin.resume();
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { configGet, configSet, configRotateToken, extractDotpath, setDotpath, validateUrlValue, readStdin };
