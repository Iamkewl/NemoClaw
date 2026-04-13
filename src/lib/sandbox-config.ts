// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Host-side sandbox configuration inspection.
//
// Reads the sandbox's openclaw.json via `openshell sandbox exec` and
// displays it with credential values redacted. Read-only — config
// mutations are handled by `nemoclaw config set` (Phase 2).

const { runCapture, validateName, shellQuote } = require("./runner");

// ---------------------------------------------------------------------------
// Credential stripping (inline for CJS compat — canonical copy in
// credential-strip.ts for the plugin ESM side)
// ---------------------------------------------------------------------------

const CREDENTIAL_FIELDS = new Set([
  "apiKey",
  "api_key",
  "token",
  "secret",
  "password",
  "resolvedKey",
]);

const CREDENTIAL_FIELD_PATTERN =
  /(?:access|refresh|client|bearer|auth|api|private|public|signing|session)(?:Token|Key|Secret|Password)$/;

function isCredentialField(key) {
  return CREDENTIAL_FIELDS.has(key) || CREDENTIAL_FIELD_PATTERN.test(key);
}

function stripCredentials(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(stripCredentials);

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isCredentialField(key)) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = stripCredentials(value);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Dotpath extraction
// ---------------------------------------------------------------------------

function extractDotpath(obj, dotpath) {
  const keys = dotpath.split(".");
  let current = obj;
  for (const key of keys) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

// ---------------------------------------------------------------------------
// config get
// ---------------------------------------------------------------------------

function getOpenshellCommand() {
  const binary = process.env.NEMOCLAW_OPENSHELL_BIN;
  if (!binary) return "openshell";
  return shellQuote(binary);
}

function configGet(sandboxName, opts = {}) {
  validateName(sandboxName, "sandbox name");

  const openshell = getOpenshellCommand();
  const cmd = `${openshell} sandbox exec ${shellQuote(sandboxName)} cat /sandbox/.openclaw/openclaw.json 2>/dev/null`;

  let raw;
  try {
    raw = runCapture(cmd, { ignoreError: true });
  } catch {
    raw = "";
  }

  if (!raw || !raw.trim()) {
    console.error("  Cannot read sandbox config. Is the sandbox running?");
    process.exit(1);
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    console.error(`  Failed to parse sandbox config: ${err.message}`);
    process.exit(1);
  }

  // Strip credentials before display
  config = stripCredentials(config);

  // Remove gateway section (contains auth tokens — per migration-state.ts pattern)
  delete config.gateway;

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
    // Lazy require — YAML is available in the project
    const YAML = require("yaml");
    console.log(YAML.stringify(config));
  } else {
    console.log(JSON.stringify(config, null, 2));
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { configGet, stripCredentials, extractDotpath };
