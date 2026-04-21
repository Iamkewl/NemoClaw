// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Rejects .agents/skills/*/evals/evals.json files that are still scaffold stubs.
// A stub is identified by either:
//   1. A top-level "$instructions" key (present only in generated scaffolds), or
//   2. Any string value beginning with "TODO:" (placeholder markers).
// Run as a pre-push hook so scaffolds can't land as real evals.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const TODO_PREFIX = "TODO:";
const SCAFFOLD_KEY = "$instructions";

type Finding = { path: string; reason: string };

function findStubMarkers(value: unknown, trail: string[]): string[] {
  const reasons: string[] = [];
  if (typeof value === "string") {
    if (value.trimStart().startsWith(TODO_PREFIX)) {
      reasons.push(`${trail.join(".") || "<root>"} starts with "${TODO_PREFIX}"`);
    }
    return reasons;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      reasons.push(...findStubMarkers(item, [...trail, `[${i}]`]));
    });
    return reasons;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (trail.length === 0 && k === SCAFFOLD_KEY) {
        reasons.push(`top-level "${SCAFFOLD_KEY}" key present (scaffold stub)`);
        continue;
      }
      reasons.push(...findStubMarkers(v, [...trail, k]));
    }
  }
  return reasons;
}

function auditFile(path: string): Finding[] {
  const absolute = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch (err) {
    return [
      {
        path,
        reason: `failed to parse JSON: ${(err as Error).message}`,
      },
    ];
  }
  return findStubMarkers(parsed, []).map((reason) => ({ path, reason }));
}

function main(): number {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    return 0;
  }
  const findings = files.flatMap(auditFile);
  if (findings.length === 0) {
    return 0;
  }
  console.error("Skills eval stubs must be authored before push:");
  for (const { path, reason } of findings) {
    console.error(`  ${path}: ${reason}`);
  }
  console.error(
    "\nSee .agents/skills/EVALS.md for the authoring rubric. Remove the " +
      '"$instructions" key and replace all "TODO:" placeholders with real ' +
      "scenario content, or delete the evals/ directory if this skill is " +
      "not ready to be evaluated yet.",
  );
  return 1;
}

process.exit(main());
