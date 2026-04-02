// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface VersionInfo {
  /** Semver from package.json (e.g. "0.1.0"). */
  version: string;
  /** Git describe tag, or null if not in a git repo / git unavailable. */
  gitDescribe: string | null;
  /** Display string: version + git describe suffix when available. */
  display: string;
}

export interface VersionOptions {
  /** Override the directory containing package.json. */
  packageDir?: string;
  /** Mock git describe output (undefined = run real command). */
  gitDescribeResult?: string | null;
}

/**
 * Read the CLI version from package.json and optionally enrich with
 * `git describe --tags --always --dirty` for dev builds.
 */
export function getVersion(opts: VersionOptions = {}): VersionInfo {
  // Compiled location: nemoclaw/dist/lib/version.js → repo root is 3 levels up
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const packageDir = opts.packageDir ?? join(thisDir, "..", "..", "..");
  const raw = readFileSync(join(packageDir, "package.json"), "utf-8");
  const pkg = JSON.parse(raw) as { version: string };
  const version = pkg.version;

  let gitDescribe: string | null = null;
  if (opts.gitDescribeResult !== undefined) {
    gitDescribe = opts.gitDescribeResult;
  } else {
    try {
      gitDescribe = execSync("git describe --tags --always --dirty", {
        encoding: "utf-8",
        cwd: packageDir,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      /* not in a git repo or git unavailable */
    }
  }

  const display = gitDescribe ? `${version} (${gitDescribe})` : version;

  return { version, gitDescribe, display };
}
