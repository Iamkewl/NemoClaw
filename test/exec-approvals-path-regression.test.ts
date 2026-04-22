// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("exec approvals path regression guard", () => {
  it("Dockerfile.base installs OpenClaw and validates version against blueprint minimum", () => {
    const dockerfileBase = path.join(import.meta.dirname, "..", "Dockerfile.base");
    const src = fs.readFileSync(dockerfileBase, "utf-8");

    expect(src).toContain("OPENCLAW_VERSION");
    expect(src).toContain("min_openclaw_version");
    expect(src).toContain('npm install -g "openclaw@${OPENCLAW_VERSION}"');
  });

  it("Dockerfile sets mutable-default permissions on .openclaw", () => {
    const dockerfile = path.join(import.meta.dirname, "..", "Dockerfile");
    const src = fs.readFileSync(dockerfile, "utf-8");

    expect(src).toContain("mkdir -p /sandbox/.openclaw");
    expect(src).toContain("chown -R sandbox:sandbox /sandbox/.openclaw");
    expect(src).toContain("chmod 700 /sandbox/.openclaw");
    expect(src).toContain("chmod 600 /sandbox/.openclaw/openclaw.json");
  });
});
