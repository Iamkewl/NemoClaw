// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { OVERRIDES_PATH } = require("../bin/lib/config-set");

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("config-set", () => {
  describe("OVERRIDES_PATH", () => {
    it("points to writable partition", () => {
      expect(OVERRIDES_PATH).toMatch(/^\/sandbox\/\.openclaw-data\//);
    });

    it("is a json5 file", () => {
      expect(OVERRIDES_PATH).toMatch(/\.json5$/);
    });
  });

  describe("security invariants", () => {
    it("gateway.* keys are blocked by configSet", () => {
      const src = readFileSync(
        join(__dirname, "..", "bin", "lib", "config-set.js"),
        "utf-8"
      );
      expect(src).toContain('key.startsWith("gateway.")');
      expect(src).toContain('key === "gateway"');
    });

    it("patch excludes gateway from overrides", () => {
      const patch = readFileSync(
        join(__dirname, "..", "patches", "openclaw-config-overrides.patch"),
        "utf-8"
      );
      expect(patch).toContain("delete _ov.gateway");
    });
  });
});
