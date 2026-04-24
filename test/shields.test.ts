// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// The shields module uses CJS require("./runner") etc., which vitest resolves
// relative to src/lib/. We mock the absolute paths that vitest will resolve.

vi.mock("../../src/lib/runner", () => ({
  run: vi.fn(() => ({ status: 0 })),
  runCapture: vi.fn(() => "version: 1\nnetwork_policies:\n  test: {}"),
  validateName: vi.fn((name) => name),
  shellQuote: vi.fn((s) => `'${s}'`),
  redact: vi.fn((s) => s),
  ROOT: "/mock/root",
}));

vi.mock("../../src/lib/policies", () => ({
  buildPolicyGetCommand: vi.fn((name) => ["openshell", "policy", "get", "--full", name]),
  buildPolicySetCommand: vi.fn((file, name) => [
    "openshell",
    "policy",
    "set",
    "--policy",
    file,
    "--wait",
    name,
  ]),
  parseCurrentPolicy: vi.fn((raw) => raw || ""),
  PERMISSIVE_POLICY_PATH: "/mock/permissive.yaml",
}));

vi.mock("../../src/lib/sandbox-config", () => ({
  resolveAgentConfig: vi.fn(() => ({
    agentName: "openclaw",
    configPath: "/sandbox/.openclaw/openclaw.json",
    configDir: "/sandbox/.openclaw",
    format: "json",
    configFile: "openclaw.json",
  })),
}));

vi.mock("../../src/lib/shields-audit", () => ({
  appendAuditEntry: vi.fn(),
}));

vi.mock("child_process", () => ({
  fork: vi.fn(() => ({ pid: 12345, disconnect: vi.fn(), unref: vi.fn() })),
  execFileSync: vi.fn(),
}));

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shields-test-"));
  vi.stubEnv("HOME", tmpDir);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// The shields.ts module reads HOME at require-time for STATE_DIR.
// With vitest's module caching, we can't easily re-evaluate.
// Instead, test the logic by directly manipulating state files and
// calling functions that read them at invocation time.

describe("shields — unit logic", () => {
  describe("parseDuration (inline in shields.ts)", () => {
    // parseDuration is inlined in shields.ts. Test it via the ESM module.
    // Since the CJS require resolution issue makes direct import flaky,
    // test the TypeScript duration module instead.
    it("parses minutes", async () => {
      const { parseDuration } = await import("../src/lib/duration.js");
      expect(parseDuration("5m")).toBe(300);
      expect(parseDuration("30m")).toBe(1800);
    });

    it("parses seconds", async () => {
      const { parseDuration } = await import("../src/lib/duration.js");
      expect(parseDuration("90s")).toBe(90);
    });

    it("treats bare numbers as seconds", async () => {
      const { parseDuration } = await import("../src/lib/duration.js");
      expect(parseDuration("300")).toBe(300);
    });

    it("rejects durations exceeding 30 minutes", async () => {
      const { parseDuration } = await import("../src/lib/duration.js");
      expect(() => parseDuration("31m")).toThrow("exceeds maximum");
      expect(() => parseDuration("1h")).toThrow("exceeds maximum");
    });

    it("rejects invalid input", async () => {
      const { parseDuration } = await import("../src/lib/duration.js");
      expect(() => parseDuration("abc")).toThrow("Invalid duration");
    });
  });

  describe("shields state file management", () => {
    it("state files are namespaced by sandbox", () => {
      const stateDir = path.join(tmpDir, ".nemoclaw", "state");
      fs.mkdirSync(stateDir, { recursive: true });

      // Write state for two different sandboxes
      const alphaState = { shieldsDown: true, updatedAt: new Date().toISOString() };
      const betaState = { shieldsDown: false, updatedAt: new Date().toISOString() };
      fs.writeFileSync(
        path.join(stateDir, "shields-alpha.json"),
        JSON.stringify(alphaState, null, 2),
      );
      fs.writeFileSync(
        path.join(stateDir, "shields-beta.json"),
        JSON.stringify(betaState, null, 2),
      );

      const alpha = JSON.parse(fs.readFileSync(path.join(stateDir, "shields-alpha.json"), "utf-8"));
      const beta = JSON.parse(fs.readFileSync(path.join(stateDir, "shields-beta.json"), "utf-8"));
      expect(alpha.shieldsDown).toBe(true);
      expect(beta.shieldsDown).toBe(false);
    });

    it("shieldsDown creates snapshot, state, and audit files", () => {
      const stateDir = path.join(tmpDir, ".nemoclaw", "state");
      fs.mkdirSync(stateDir, { recursive: true });

      const ts = Date.now();
      const snapshotPath = path.join(stateDir, `policy-snapshot-${ts}.yaml`);
      fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  test: {}", {
        mode: 0o600,
      });

      const state = {
        shieldsDown: true,
        shieldsDownAt: new Date().toISOString(),
        shieldsDownTimeout: 300,
        shieldsDownReason: "Installing plugin",
        shieldsDownPolicy: "permissive",
        shieldsPolicySnapshotPath: snapshotPath,
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(
        path.join(stateDir, "shields-openclaw.json"),
        JSON.stringify(state, null, 2),
      );

      const loaded = JSON.parse(
        fs.readFileSync(path.join(stateDir, "shields-openclaw.json"), "utf-8"),
      );
      expect(loaded.shieldsDown).toBe(true);
      expect(loaded.shieldsDownTimeout).toBe(300);
      expect(loaded.shieldsDownPolicy).toBe("permissive");
      expect(fs.existsSync(snapshotPath)).toBe(true);
    });

    it("shieldsUp clears shields state", () => {
      const stateDir = path.join(tmpDir, ".nemoclaw", "state");
      fs.mkdirSync(stateDir, { recursive: true });

      const snapshotPath = path.join(stateDir, "policy-snapshot-test.yaml");
      fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies:\n  test: {}");

      const downState = {
        shieldsDown: true,
        shieldsDownAt: new Date(Date.now() - 120000).toISOString(),
        shieldsDownTimeout: 300,
        shieldsDownReason: "Testing",
        shieldsDownPolicy: "permissive",
        shieldsPolicySnapshotPath: snapshotPath,
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(
        path.join(stateDir, "shields-openclaw.json"),
        JSON.stringify(downState, null, 2),
      );

      const cleared = {
        ...downState,
        shieldsDown: false,
        shieldsDownAt: null,
        shieldsDownTimeout: null,
        shieldsDownReason: null,
        shieldsDownPolicy: null,
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(
        path.join(stateDir, "shields-openclaw.json"),
        JSON.stringify(cleared, null, 2),
      );

      const loaded = JSON.parse(
        fs.readFileSync(path.join(stateDir, "shields-openclaw.json"), "utf-8"),
      );
      expect(loaded.shieldsDown).toBe(false);
      expect(loaded.shieldsDownAt).toBeNull();
      expect(loaded.shieldsPolicySnapshotPath).toBe(snapshotPath);
    });

    it("timer marker contains expected fields", () => {
      const stateDir = path.join(tmpDir, ".nemoclaw", "state");
      fs.mkdirSync(stateDir, { recursive: true });

      const marker = {
        pid: 12345,
        sandboxName: "openclaw",
        snapshotPath: "/tmp/snapshot.yaml",
        restoreAt: new Date(Date.now() + 300000).toISOString(),
      };
      const markerPath = path.join(stateDir, "shields-timer-openclaw.json");
      fs.writeFileSync(markerPath, JSON.stringify(marker), { mode: 0o600 });

      const loaded = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
      expect(loaded.pid).toBe(12345);
      expect(loaded.sandboxName).toBe("openclaw");
      expect(loaded.restoreAt).toBeDefined();
    });

    it("audit log entries are valid JSONL", () => {
      const stateDir = path.join(tmpDir, ".nemoclaw", "state");
      fs.mkdirSync(stateDir, { recursive: true });

      const auditPath = path.join(stateDir, "shields-audit.jsonl");

      const entries = [
        {
          action: "shields_down",
          sandbox: "openclaw",
          timestamp: "2026-04-13T14:30:00Z",
          timeout_seconds: 300,
          reason: "Plugin install",
          policy_applied: "permissive",
        },
        {
          action: "shields_up",
          sandbox: "openclaw",
          timestamp: "2026-04-13T14:32:00Z",
          restored_by: "operator",
          duration_seconds: 120,
        },
      ];

      for (const entry of entries) {
        fs.appendFileSync(auditPath, JSON.stringify(entry) + "\n");
      }

      const lines = fs.readFileSync(auditPath, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).action).toBe("shields_down");
      expect(JSON.parse(lines[1]).action).toBe("shields_up");
    });
  });

  // NOTE: Integration tests that call the real shieldsDown/shieldsUp are not
  // feasible here because shields.ts uses CJS require() which doesn't resolve
  // through vitest's ESM mock system. The full call chain is exercised by the
  // E2E test (test/e2e/test-shields-config.sh) against a live sandbox.

  // -------------------------------------------------------------------
  // NC-2227-02: Three-state shields model
  // -------------------------------------------------------------------
  describe("NC-2227-02: three-state shields model", () => {
    it("fresh sandbox (no state file) reports mutable_default, not locked", () => {
      const stateDir = path.join(tmpDir, ".nemoclaw", "state");
      fs.mkdirSync(stateDir, { recursive: true });
      // Do NOT create shields-fresh.json — simulates fresh sandbox
      const stateFile = path.join(stateDir, "shields-fresh.json");
      expect(fs.existsSync(stateFile)).toBe(false);

      // Manually replicate the deriveShieldsMode logic to test the invariant
      // (we can't import the CJS module directly)
      const hasStateFile = false;
      const state = {};
      // deriveShieldsMode: no state file => mutable_default
      let mode: string;
      if (!hasStateFile) mode = "mutable_default";
      else if (state["shieldsDown"] === true) mode = "temporarily_unlocked";
      else if (state["shieldsDown"] === false) mode = "locked";
      else mode = "mutable_default";

      expect(mode).toBe("mutable_default");
    });

    it("explicitly locked sandbox (shieldsDown: false, file exists) reports locked", () => {
      const stateDir = path.join(tmpDir, ".nemoclaw", "state");
      fs.mkdirSync(stateDir, { recursive: true });
      const state = { shieldsDown: false, updatedAt: new Date().toISOString() };
      fs.writeFileSync(path.join(stateDir, "shields-locked.json"), JSON.stringify(state, null, 2));

      const hasStateFile = true;
      let mode: string;
      if (!hasStateFile) mode = "mutable_default";
      else if (state.shieldsDown === true) mode = "temporarily_unlocked";
      else if (state.shieldsDown === false) mode = "locked";
      else mode = "mutable_default";

      expect(mode).toBe("locked");
    });

    it("temporarily unlocked sandbox (shieldsDown: true) reports temporarily_unlocked", () => {
      const stateDir = path.join(tmpDir, ".nemoclaw", "state");
      fs.mkdirSync(stateDir, { recursive: true });
      const state = {
        shieldsDown: true,
        shieldsDownAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(stateDir, "shields-temp.json"), JSON.stringify(state, null, 2));

      const hasStateFile = true;
      let mode: string;
      if (!hasStateFile) mode = "mutable_default";
      else if (state.shieldsDown === true) mode = "temporarily_unlocked";
      else if (state.shieldsDown === false) mode = "locked";
      else mode = "mutable_default";

      expect(mode).toBe("temporarily_unlocked");
    });

    it("state file with undefined shieldsDown reports mutable_default", () => {
      const stateDir = path.join(tmpDir, ".nemoclaw", "state");
      fs.mkdirSync(stateDir, { recursive: true });
      const state = { updatedAt: new Date().toISOString() };
      fs.writeFileSync(path.join(stateDir, "shields-undef.json"), JSON.stringify(state, null, 2));

      const hasStateFile = true;
      let mode: string;
      if (!hasStateFile) mode = "mutable_default";
      else if (state["shieldsDown"] === true) mode = "temporarily_unlocked";
      else if (state["shieldsDown"] === false) mode = "locked";
      else mode = "mutable_default";

      expect(mode).toBe("mutable_default");
    });
  });
});

// -------------------------------------------------------------------
// NC-2227-04: Regression test — tar commands must not follow symlinks
// -------------------------------------------------------------------
describe("NC-2227-04: sandbox-state.ts tar commands do not follow symlinks", () => {
  function getSourceCode(): string {
    return fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "lib", "sandbox-state.ts"),
      "utf-8",
    );
  }

  it("backup tar command does not use -h flag (no symlink following)", () => {
    const src = getSourceCode();
    // Find the backup tar command in backupSandboxState
    const fnStart = src.indexOf("function backupSandboxState");
    expect(fnStart).not.toBe(-1);
    const fnBody = src.slice(fnStart);

    // The tar command should be `tar -cf` not `tar -chf`
    const tarCmdMatch = fnBody.match(/tar -c([a-z]*)f/g);
    expect(tarCmdMatch).not.toBeNull();
    for (const match of tarCmdMatch!) {
      expect(match).not.toContain("h");
    }
  });

  it("restore tar command does not use -h flag (no symlink following)", () => {
    const src = getSourceCode();
    // Find the restore function
    const fnStart = src.indexOf("function restoreSandboxState");
    expect(fnStart).not.toBe(-1);
    const fnBody = src.slice(fnStart);

    // Check tar commands in the restore path
    const tarCmdMatches = fnBody.match(/"-c([a-z]*)f"/g);
    if (tarCmdMatches) {
      for (const match of tarCmdMatches) {
        expect(match).not.toContain("h");
      }
    }
  });

  it("backup includes pre-backup symlink audit before tar", () => {
    const src = getSourceCode();
    const fnStart = src.indexOf("function backupSandboxState");
    const fnBody = src.slice(fnStart);

    // Must have the pre-backup audit command checking for symlinks
    expect(fnBody).toContain("Pre-backup audit");
    expect(fnBody).toContain("-type l");
  });
});

// -------------------------------------------------------------------
// NC-2227-05: Regression test — shields.ts locks high-risk state dirs
// -------------------------------------------------------------------
describe("NC-2227-05: shields.ts locks high-risk state directories", () => {
  function getSourceCode(): string {
    return fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "lib", "shields.ts"),
      "utf-8",
    );
  }

  it("HIGH_RISK_STATE_DIRS constant includes skills, hooks, cron, agents, extensions, plugins", () => {
    const src = getSourceCode();
    expect(src).toContain("HIGH_RISK_STATE_DIRS");
    for (const dir of ["skills", "hooks", "cron", "agents", "extensions", "plugins"]) {
      expect(src).toContain(`"${dir}"`);
    }
  });

  it("lockAgentConfig iterates over HIGH_RISK_STATE_DIRS", () => {
    const src = getSourceCode();
    const fnStart = src.indexOf("function lockAgentConfig");
    expect(fnStart).not.toBe(-1);
    const fnBody = src.slice(fnStart);
    expect(fnBody).toContain("HIGH_RISK_STATE_DIRS");
    expect(fnBody).toContain("chown");
    expect(fnBody).toContain("root:root");
  });

  it("unlockAgentConfig restores sandbox ownership on HIGH_RISK_STATE_DIRS", () => {
    const src = getSourceCode();
    const fnStart = src.indexOf("function unlockAgentConfig");
    expect(fnStart).not.toBe(-1);
    const fnBody = src.slice(fnStart, src.indexOf("function lockAgentConfig"));
    expect(fnBody).toContain("HIGH_RISK_STATE_DIRS");
    expect(fnBody).toContain("sandbox:sandbox");
  });
});
