// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("fetch-guard patch regression guard", () => {
  it("Dockerfile upgrades stale OpenClaw in base image before patching", () => {
    const dockerfile = path.join(import.meta.dirname, "..", "Dockerfile");
    const src = fs.readFileSync(dockerfile, "utf-8");

    // Must read min version from blueprint
    expect(src).toContain("min_openclaw_version");
    // Must check installed version against minimum
    expect(src).toContain("openclaw --version");
    // Must upgrade when stale (any npm flags between `-g` and the target
    // are fine — we've needed to add --no-audit/--no-fund/--no-progress
    // for memory/IO reasons and may need more).
    expect(src).toMatch(/npm install -g .*"openclaw@\$\{MIN_VER\}"/);
    // The "current" branch must fire when MIN_VER is the smallest (= not !=)
    expect(src).toContain('| sort -V | head -n1)" = "$MIN_VER" ]; then');
  });

  it("Patch 1 rewrites withStrictGuardedFetchMode export with fail-close", () => {
    const dockerfile = path.join(import.meta.dirname, "..", "Dockerfile");
    const src = fs.readFileSync(dockerfile, "utf-8");

    expect(src).toContain("withStrictGuardedFetchMode as [a-z]");
    expect(src).toContain("withTrustedEnvProxyGuardedFetchMode");
    expect(src).toContain("Patch 1 left strict-mode export alias");
  });

  it("Patch 2 injects env-gated bypass for assertExplicitProxyAllowed", () => {
    const dockerfile = path.join(import.meta.dirname, "..", "Dockerfile");
    const src = fs.readFileSync(dockerfile, "utf-8");

    expect(src).toContain("assertExplicitProxyAllowed");
    expect(src).toContain('OPENSHELL_SANDBOX === "1"');
  });
});
