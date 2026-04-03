// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Policy preset management — list, load, merge, and apply presets.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import YAML from "yaml";

// CJS deps that aren't yet migrated or must stay CJS
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ROOT, run, runCapture, shellQuote } = require("../../bin/lib/runner");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const registry = require("../../bin/lib/registry");

export const PRESETS_DIR = path.join(ROOT, "nemoclaw-blueprint", "policies", "presets");

function getOpenshellCommand(): string {
  const binary = process.env.NEMOCLAW_OPENSHELL_BIN;
  if (!binary) return "openshell";
  return shellQuote(binary);
}

export interface PresetInfo {
  file: string;
  name: string;
  description: string;
}

export function listPresets(): PresetInfo[] {
  if (!fs.existsSync(PRESETS_DIR)) return [];
  return fs
    .readdirSync(PRESETS_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => {
      const content = fs.readFileSync(path.join(PRESETS_DIR, f), "utf-8");
      const nameMatch = content.match(/^\s*name:\s*(.+)$/m);
      const descMatch = content.match(/^\s*description:\s*"?([^"]*)"?$/m);
      return {
        file: f,
        name: nameMatch ? nameMatch[1].trim() : f.replace(".yaml", ""),
        description: descMatch ? descMatch[1].trim() : "",
      };
    });
}

export function loadPreset(name: string): string | null {
  const file = path.resolve(PRESETS_DIR, `${name}.yaml`);
  if (!file.startsWith(PRESETS_DIR + path.sep) && file !== PRESETS_DIR) {
    console.error(`  Invalid preset name: ${name}`);
    return null;
  }
  if (!fs.existsSync(file)) {
    console.error(`  Preset not found: ${name}`);
    return null;
  }
  return fs.readFileSync(file, "utf-8");
}

export function getPresetEndpoints(content: string): string[] {
  const hosts: string[] = [];
  const regex = /host:\s*([^\s,}]+)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    hosts.push(match[1]);
  }
  return hosts;
}

export function validatePreset(presetContent: string, presetName: string): boolean {
  if (!presetContent.includes("binaries:")) {
    console.warn(
      `  Warning: preset '${presetName}' has no binaries section — ` +
        `this will cause 403 errors in the sandbox (ref: #676)`,
    );
    return false;
  }
  return true;
}

export function extractPresetEntries(presetContent: string): string | null {
  if (!presetContent) return null;
  const npMatch = presetContent.match(/^network_policies:\n([\s\S]*)$/m);
  if (!npMatch) return null;
  return npMatch[1].trimEnd();
}

export function parseCurrentPolicy(raw: string): string {
  if (!raw) return "";
  const sep = raw.indexOf("---");
  const candidate = (sep === -1 ? raw : raw.slice(sep + 3)).trim();
  if (!candidate) return "";
  if (/^(error|failed|invalid|warning|status)\b/i.test(candidate)) {
    return "";
  }
  if (!/^[a-z_][a-z0-9_]*\s*:/m.test(candidate)) {
    return "";
  }
  try {
    const parsed = YAML.parse(candidate);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "";
    }
  } catch {
    return "";
  }
  return candidate;
}

export function buildPolicySetCommand(policyFile: string, sandboxName: string): string {
  return `${getOpenshellCommand()} policy set --policy ${shellQuote(policyFile)} --wait ${shellQuote(sandboxName)}`;
}

export function buildPolicyGetCommand(sandboxName: string): string {
  return `${getOpenshellCommand()} policy get --full ${shellQuote(sandboxName)} 2>/dev/null`;
}

function textBasedMerge(currentPolicy: string, presetEntries: string): string {
  if (!currentPolicy) {
    return "version: 1\n\nnetwork_policies:\n" + presetEntries;
  }
  let merged;
  if (/^network_policies\s*:/m.test(currentPolicy)) {
    const lines = currentPolicy.split("\n");
    const result: string[] = [];
    let inNp = false;
    let inserted = false;
    for (const line of lines) {
      if (/^network_policies\s*:/.test(line)) {
        inNp = true;
        result.push(line);
        continue;
      }
      if (inNp && /^\S.*:/.test(line) && !inserted) {
        result.push(presetEntries);
        inserted = true;
        inNp = false;
      }
      result.push(line);
    }
    if (inNp && !inserted) result.push(presetEntries);
    merged = result.join("\n");
  } else {
    merged = currentPolicy.trimEnd() + "\n\nnetwork_policies:\n" + presetEntries;
  }
  if (!merged.trimStart().startsWith("version:")) merged = "version: 1\n\n" + merged;
  return merged;
}

export function mergePresetIntoPolicy(currentPolicy: string, presetEntries: string): string {
  const normalizedCurrentPolicy = parseCurrentPolicy(currentPolicy);
  if (!presetEntries) {
    return normalizedCurrentPolicy || "version: 1\n\nnetwork_policies:\n";
  }

  let presetPolicies: Record<string, unknown> | null;
  try {
    const wrapped = "network_policies:\n" + presetEntries;
    const parsed = YAML.parse(wrapped) as { network_policies?: unknown };
    presetPolicies = parsed?.network_policies as Record<string, unknown> | null;
  } catch {
    presetPolicies = null;
  }

  if (!presetPolicies || typeof presetPolicies !== "object" || Array.isArray(presetPolicies)) {
    return textBasedMerge(normalizedCurrentPolicy, presetEntries);
  }

  if (!normalizedCurrentPolicy) {
    return YAML.stringify({ version: 1, network_policies: presetPolicies });
  }

  let current: Record<string, unknown>;
  try {
    current = YAML.parse(normalizedCurrentPolicy) as Record<string, unknown>;
  } catch {
    return textBasedMerge(normalizedCurrentPolicy, presetEntries);
  }

  if (!current || typeof current !== "object") current = {};

  const existingNp = current.network_policies;
  let mergedNp: Record<string, unknown>;
  if (existingNp && typeof existingNp === "object" && !Array.isArray(existingNp)) {
    mergedNp = { ...(existingNp as Record<string, unknown>), ...presetPolicies };
  } else {
    mergedNp = presetPolicies;
  }

  const output: Record<string, unknown> = { version: (current.version as number) || 1 };
  for (const [key, val] of Object.entries(current)) {
    if (key !== "version" && key !== "network_policies") output[key] = val;
  }
  output.network_policies = mergedNp;

  return YAML.stringify(output);
}

export function applyPreset(sandboxName: string, presetName: string): boolean {
  const isRfc1123Label = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(sandboxName);
  if (!sandboxName || sandboxName.length > 63 || !isRfc1123Label) {
    throw new Error(
      `Invalid or truncated sandbox name: '${sandboxName}'. ` +
        `Names must be 1-63 chars, lowercase alphanumeric, with optional internal hyphens.`,
    );
  }

  const presetContent = loadPreset(presetName);
  if (!presetContent) {
    console.error(`  Cannot load preset: ${presetName}`);
    return false;
  }

  validatePreset(presetContent, presetName);

  const presetEntries = extractPresetEntries(presetContent);
  if (!presetEntries) {
    console.error(`  Preset ${presetName} has no network_policies section.`);
    return false;
  }

  let rawPolicy = "";
  try {
    rawPolicy = runCapture(buildPolicyGetCommand(sandboxName), { ignoreError: true });
  } catch {
    /* ignored */
  }

  const currentPolicy = parseCurrentPolicy(rawPolicy);
  const merged = mergePresetIntoPolicy(currentPolicy, presetEntries);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-"));
  const tmpFile = path.join(tmpDir, "policy.yaml");
  fs.writeFileSync(tmpFile, merged, { encoding: "utf-8", mode: 0o600 });

  try {
    run(buildPolicySetCommand(tmpFile, sandboxName));
    console.log(`  Applied preset: ${presetName}`);
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignored */
    }
    try {
      fs.rmdirSync(tmpDir);
    } catch {
      /* ignored */
    }
  }

  const sandbox = registry.getSandbox(sandboxName);
  if (sandbox) {
    const pols = sandbox.policies || [];
    if (!pols.includes(presetName)) {
      pols.push(presetName);
    }
    registry.updateSandbox(sandboxName, { policies: pols });
  }

  return true;
}

export function getAppliedPresets(sandboxName: string): string[] {
  const sandbox = registry.getSandbox(sandboxName);
  return sandbox ? sandbox.policies || [] : [];
}

export interface SelectFromListOptions {
  applied?: string[];
}

export function selectFromList(
  items: Array<{ name: string; description?: string }>,
  { applied = [] }: SelectFromListOptions = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    process.stderr.write("\n  Available presets:\n");
    items.forEach((item, i) => {
      const marker = applied.includes(item.name) ? "●" : "○";
      const description = item.description ? ` — ${item.description}` : "";
      process.stderr.write(`    ${i + 1}) ${marker} ${item.name}${description}\n`);
    });
    process.stderr.write("\n  ● applied, ○ not applied\n\n");
    const defaultIdx = items.findIndex((item) => !applied.includes(item.name));
    const defaultNum = defaultIdx >= 0 ? defaultIdx + 1 : null;
    const question = defaultNum ? `  Choose preset [${defaultNum}]: ` : "  Choose preset: ";
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      if (!process.stdin.isTTY) {
        if (typeof process.stdin.pause === "function") process.stdin.pause();
        if (typeof process.stdin.unref === "function") process.stdin.unref();
      }
      const trimmed = answer.trim();
      const effectiveInput = trimmed || (defaultNum ? String(defaultNum) : "");
      if (!effectiveInput) {
        resolve(null);
        return;
      }
      if (!/^\d+$/.test(effectiveInput)) {
        process.stderr.write("\n  Invalid preset number.\n");
        resolve(null);
        return;
      }
      const num = Number(effectiveInput);
      const item = items[num - 1];
      if (!item) {
        process.stderr.write("\n  Invalid preset number.\n");
        resolve(null);
        return;
      }
      if (applied.includes(item.name)) {
        process.stderr.write(`\n  Preset '${item.name}' is already applied.\n`);
        resolve(null);
        return;
      }
      resolve(item.name);
    });
  });
}
