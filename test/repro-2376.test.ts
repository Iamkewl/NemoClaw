// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression guard for issue #2376:
 *   Hermes Agent crashes on every keypress because HERMES_HOME is unset
 *   in interactive sandbox shells, so prompt_toolkit tries to write its
 *   history file to /sandbox/.hermes (immutable, root-owned) instead of
 *   /sandbox/.hermes-data.
 *
 * Root cause:
 *   The OpenClaw base image (Dockerfile.base) pre-creates /sandbox/.bashrc
 *   and /sandbox/.profile that source /tmp/nemoclaw-proxy-env.sh — the file
 *   the entrypoint writes with HERMES_HOME (and proxy vars) at runtime.
 *   The Hermes base image (agents/hermes/Dockerfile.base) was missing the
 *   equivalent block, so the proxy-env file existed but was never sourced.
 *
 *   The regression slipped in via #2297 which moved the proxy/HERMES_HOME
 *   exports out of an inline .bashrc append into the standalone proxy-env
 *   file — without realising the Hermes base image had no .bashrc to source it.
 *
 * Guard: assert agents/hermes/Dockerfile.base pre-creates both rc files
 * with the source line. The same guard exists implicitly for OpenClaw
 * (covered by test/e2e-gateway-isolation.sh).
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Issue #2376: Hermes base image pre-creates rc files that source HERMES_HOME", () => {
  it("agents/hermes/Dockerfile.base writes /sandbox/.bashrc that sources /tmp/nemoclaw-proxy-env.sh", () => {
    const dockerfile = path.join(import.meta.dirname, "..", "agents", "hermes", "Dockerfile.base");
    const src = fs.readFileSync(dockerfile, "utf-8");

    expect(src).toContain("[ -f /tmp/nemoclaw-proxy-env.sh ] && . /tmp/nemoclaw-proxy-env.sh");
    expect(src).toContain("> /sandbox/.bashrc");
    expect(src).toContain("> /sandbox/.profile");
    expect(src).toContain("chown sandbox:sandbox /sandbox/.bashrc /sandbox/.profile");
  });
});
