// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

export interface OpenshellCompatOptions {
  /** Override the repo root directory. */
  rootDir?: string;
}

export function parseOpenshellVersion(text = ""): string | null {
  const match = String(text).match(/\bopenshell\s+([0-9]+\.[0-9]+\.[0-9]+)/i);
  return match ? match[1] : null;
}

export function compareVersions(left = "0.0.0", right = "0.0.0"): number {
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
    if (a > b) return 1;
    if (a < b) return -1;
  }

  return 0;
}

export function versionGte(left = "0.0.0", right = "0.0.0"): boolean {
  return compareVersions(left, right) >= 0;
}

export function getBlueprintMinOpenshellVersion(opts: OpenshellCompatOptions = {}): string {
  // Compiled location: dist/lib/openshell-compat.js -> repo root is 2 levels up
  const root = opts.rootDir ?? join(__dirname, "..", "..");
  const blueprintPath = join(root, "nemoclaw-blueprint", "blueprint.yaml");
  const raw = readFileSync(blueprintPath, "utf-8");
  const parsed = YAML.parse(raw) as { min_openshell_version?: unknown } | null;
  const minVersion = typeof parsed?.min_openshell_version === "string" ? parsed.min_openshell_version : "";

  if (!minVersion) {
    throw new Error(`Missing min_openshell_version in ${blueprintPath}`);
  }

  return minVersion;
}
