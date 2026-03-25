// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Runtime config overrides for sandboxed OpenClaw instances.
// Reads/writes the config-overrides.json5 file in the sandbox's writable
// partition.  Changes trigger OpenClaw's config file watcher for hot-reload.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { runCapture, shellQuote } = require("./runner");

const OVERRIDES_PATH = "/sandbox/.openclaw-data/config-overrides.json5";

/**
 * Run a script inside the sandbox via `sandbox connect` with stdin piping.
 */
function sandboxRun(sandboxName, script) {
  const tmpFile = path.join(os.tmpdir(), `nemoclaw-cfg-${Date.now()}.sh`);
  fs.writeFileSync(tmpFile, script + "\nexit\n", { mode: 0o600 });
  try {
    return runCapture(
      `openshell sandbox connect ${shellQuote(sandboxName)} < ${shellQuote(tmpFile)} 2>&1`,
      { ignoreError: true }
    );
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

/**
 * Read the current overrides file from inside the sandbox.
 */
function readOverrides(sandboxName) {
  const raw = sandboxRun(sandboxName, `cat ${OVERRIDES_PATH} 2>/dev/null`);
  if (!raw || raw.trim() === "") return {};
  // sandbox connect may include shell prompt noise — extract the JSON
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return {};
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return {};
  }
}

/**
 * Write the overrides object back into the sandbox.
 */
function writeOverrides(sandboxName, overrides) {
  const json = JSON.stringify(overrides, null, 2);
  const script = `cat > ${OVERRIDES_PATH} <<'EOF_OV'\n${json}\nEOF_OV`;
  return sandboxRun(sandboxName, script);
}

/**
 * Set a value at a dotted path in a nested object.
 */
function setNestedValue(obj, dottedPath, value) {
  const parts = dottedPath.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current) || typeof current[parts[i]] !== "object") {
      current[parts[i]] = {};
    }
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}

/**
 * Get a value at a dotted path from a nested object.
 */
function getNestedValue(obj, dottedPath) {
  const parts = dottedPath.split(".");
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Parse a string value into the appropriate JS type.
 */
function parseValue(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (!isNaN(raw) && raw !== "") return Number(raw);
  // Try JSON (for arrays/objects)
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object") return parsed;
  } catch { /* not JSON, treat as string */ }
  return raw;
}

/**
 * nemoclaw <sandbox> config-set --key <path> --value <value>
 */
function configSet(sandboxName, args) {
  let key = null;
  let value = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--key" && i + 1 < args.length) {
      key = args[++i];
    } else if (args[i] === "--value" && i + 1 < args.length) {
      value = args[++i];
    }
  }

  if (!key || value === null) {
    console.error("  Usage: nemoclaw <sandbox> config-set --key <path> --value <value>");
    console.error("  Example: nemoclaw my-assistant config-set --key channels.telegram.token --value '<token>'");
    process.exit(1);
  }

  // Security: block gateway.* regardless of anything else
  if (key.startsWith("gateway.") || key === "gateway") {
    console.error(`  Refused: gateway.* fields are immutable (security-enforced).`);
    process.exit(1);
  }

  const overrides = readOverrides(sandboxName);
  const parsedValue = parseValue(value);
  setNestedValue(overrides, key, parsedValue);
  writeOverrides(sandboxName, overrides);

  console.log(`  Set ${key} = ${JSON.stringify(parsedValue)}`);
  console.log(`  OpenClaw will hot-reload the change automatically.`);
}

/**
 * nemoclaw <sandbox> config-get [--key <path>]
 */
function configGet(sandboxName, args) {
  let key = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--key" && i + 1 < args.length) {
      key = args[++i];
    }
  }

  const overrides = readOverrides(sandboxName);

  if (key) {
    const val = getNestedValue(overrides, key);
    if (val === undefined) {
      console.log(`  ${key}: (not set — using frozen config default)`);
    } else {
      console.log(`  ${key}: ${JSON.stringify(val)}`);
    }
  } else {
    // Show all overrides
    if (Object.keys(overrides).length === 0) {
      console.log("  No runtime config overrides active.");
      console.log("  All values are from the frozen openclaw.json defaults.");
    } else {
      console.log("  Active runtime config overrides:");
      console.log(JSON.stringify(overrides, null, 2).split("\n").map(l => `  ${l}`).join("\n"));
    }
  }
}

module.exports = { configSet, configGet, OVERRIDES_PATH };
