// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sessionDistPath = require.resolve("../dist/lib/onboard-session");
const policiesDistPath = require.resolve("../dist/lib/policies");
const registryDistPath = require.resolve("../dist/lib/registry");
const originalHome = process.env.HOME;
let session: any;
let policies: any;
let registry: any;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-presets-"));
  process.env.HOME = tmpDir;
  delete require.cache[sessionDistPath];
  delete require.cache[policiesDistPath];
  delete require.cache[registryDistPath];
  session = require("../dist/lib/onboard-session");
  policies = require("../dist/lib/policies");
  registry = require("../dist/lib/registry");
  session.clearSession();
  session.releaseOnboardLock();
});

afterEach(() => {
  delete require.cache[sessionDistPath];
  delete require.cache[policiesDistPath];
  delete require.cache[registryDistPath];
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  vi.restoreAllMocks();
});

/**
 * These tests exercise the production `mergePresetsIntoSession()` helper
 * exported from `src/lib/policies.ts`, which is the same function called
 * by `sandboxRebuild()`. We set up registry sandbox entries so that
 * `getAppliedPresets` (called internally) reads real data.
 */
describe("rebuild preserves policy presets added after onboard", () => {
  it("merges applied presets into session presets with deduplication", () => {
    session.saveSession(session.createSession());
    session.updateSession((s) => {
      s.policyPresets = ["web-search"];
      return s;
    });

    registry.registerSandbox({ name: "test-sandbox", policies: ["web-search", "telegram"] });

    policies.mergePresetsIntoSession("test-sandbox", session);

    const updated = session.loadSession();
    expect(updated.policyPresets).toEqual(["web-search", "telegram"]);
  });

  it("handles session with no prior policyPresets", () => {
    session.saveSession(session.createSession());

    registry.registerSandbox({ name: "test-sandbox", policies: ["slack", "discord"] });

    policies.mergePresetsIntoSession("test-sandbox", session);

    const updated = session.loadSession();
    expect(updated.policyPresets).toEqual(["slack", "discord"]);
  });

  it("skips update when no presets are applied", () => {
    session.saveSession(session.createSession());
    session.updateSession((s) => {
      s.policyPresets = ["web-search"];
      return s;
    });

    registry.registerSandbox({ name: "test-sandbox", policies: [] });

    policies.mergePresetsIntoSession("test-sandbox", session);

    const updated = session.loadSession();
    expect(updated.policyPresets).toEqual(["web-search"]);
  });

  it("continues with session presets when getAppliedPresets throws (degraded sandbox)", () => {
    session.saveSession(session.createSession());
    session.updateSession((s) => {
      s.policyPresets = ["web-search"];
      return s;
    });

    // Make the registry file unreadable to trigger a ConfigPermissionError
    registry.registerSandbox({ name: "test-sandbox", policies: ["telegram"] });
    const registryPath = path.join(tmpDir, ".nemoclaw", "sandboxes.json");
    fs.chmodSync(registryPath, 0o000);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    policies.mergePresetsIntoSession("test-sandbox", session);

    // Restore permissions for cleanup
    fs.chmodSync(path.join(tmpDir, ".nemoclaw", "sandboxes.json"), 0o644);

    const updated = session.loadSession();
    expect(updated.policyPresets).toEqual(["web-search"]);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("could not read applied presets"),
    );
  });

  it("does not duplicate presets that exist in both session and applied", () => {
    session.saveSession(session.createSession());
    session.updateSession((s) => {
      s.policyPresets = ["web-search", "npm"];
      return s;
    });

    registry.registerSandbox({ name: "test-sandbox", policies: ["web-search", "npm", "telegram"] });

    policies.mergePresetsIntoSession("test-sandbox", session);

    const updated = session.loadSession();
    expect(updated.policyPresets).toEqual(["web-search", "npm", "telegram"]);
  });
});
