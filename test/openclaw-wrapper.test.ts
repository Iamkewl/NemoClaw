// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WRAPPER = path.join(import.meta.dirname, "..", "scripts", "openclaw-wrapper.sh");
const DOCKERFILE = path.join(import.meta.dirname, "..", "Dockerfile");

describe("openclaw sandbox wrapper", () => {
  it("blocks config-mutating commands with actionable guidance", () => {
    const src = fs.readFileSync(WRAPPER, "utf-8");

    expect(src).toContain("openclaw configure");
    expect(src).toContain("nemoclaw onboard --resume");
    expect(src).toContain("openclaw agents add");
    expect(src).toContain("not currently supported");
    expect(src).toContain('exec "$REAL_OPENCLAW" "$@"');
  });

  it("is installed as the runtime openclaw binary in the sandbox image", () => {
    const src = fs.readFileSync(DOCKERFILE, "utf-8");

    expect(src).toContain("COPY scripts/openclaw-wrapper.sh /usr/local/lib/nemoclaw/openclaw-wrapper.sh");
    expect(src).toContain('OPENCLAW_BIN="$(command -v openclaw)"');
    expect(src).toContain('mv "$OPENCLAW_BIN" /usr/local/bin/openclaw-real');
    expect(src).toContain("install -m 755 /usr/local/lib/nemoclaw/openclaw-wrapper.sh /usr/local/bin/openclaw");
  });
});
