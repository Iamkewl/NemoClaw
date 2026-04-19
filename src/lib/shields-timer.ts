// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Auto-restore timer for shields-down. Runs as a detached child process
// forked by shields.ts. Sleeps until the absolute restore time, then
// restores the captured policy snapshot.
//
// Usage (internal — called by shields.ts via fork()):
//   node shields-timer.js <sandbox-name> <snapshot-path> <restore-at-iso> <config-path> <config-dir>

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { run } = require("./runner");
const { buildPolicySetCommand } = require("./policies");

const STATE_DIR = path.join(process.env.HOME ?? "/tmp", ".nemoclaw", "state");
const AUDIT_FILE = path.join(STATE_DIR, "shields-audit.jsonl");
const K3S_CONTAINER = "openshell-cluster-nemoclaw";

const [sandboxName, snapshotPath, restoreAtIso, configPath, configDir] = process.argv.slice(2);
const STATE_FILE = path.join(STATE_DIR, `shields-${sandboxName}.json`);
const restoreAtMs = new Date(restoreAtIso).getTime();
const delayMs = Math.max(0, restoreAtMs - Date.now());

if (!sandboxName || !snapshotPath || !restoreAtIso || isNaN(restoreAtMs)) {
  process.exit(1);
}

function kubectlExec(cmd) {
  execFileSync("docker", [
    "exec", K3S_CONTAINER,
    "kubectl", "exec", "-n", "openshell", sandboxName, "-c", "agent", "--",
    ...cmd,
  ], { stdio: ["ignore", "pipe", "pipe"], timeout: 15000 });
}

function appendAudit(entry) {
  try {
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + "\n", { mode: 0o600 });
  } catch {
    // Best effort — don't crash the timer
  }
}

function updateState(patch) {
  try {
    let current = {};
    if (fs.existsSync(STATE_FILE)) {
      current = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    }
    const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
    fs.writeFileSync(STATE_FILE, JSON.stringify(updated, null, 2), { mode: 0o600 });
  } catch {
    // Best effort
  }
}

function cleanupMarker() {
  try {
    const markerPath = path.join(STATE_DIR, `shields-timer-${sandboxName}.json`);
    if (fs.existsSync(markerPath)) {
      fs.unlinkSync(markerPath);
    }
  } catch {
    // Best effort
  }
}

setTimeout(() => {
  const now = new Date().toISOString();

  try {
    // Verify snapshot still exists
    if (!fs.existsSync(snapshotPath)) {
      appendAudit({
        action: "shields_up_failed",
        sandbox: sandboxName,
        timestamp: now,
        restored_by: "auto_timer",
        error: "Policy snapshot file missing",
      });
      cleanupMarker();
      process.exit(1);
    }

    // Restore policy (slow — openshell policy set --wait blocks)
    const result = run(buildPolicySetCommand(snapshotPath, sandboxName), { ignoreError: true });

    if (result.status !== 0) {
      appendAudit({
        action: "shields_up_failed",
        sandbox: sandboxName,
        timestamp: now,
        restored_by: "auto_timer",
        error: `Policy restore exited with status ${result.status}`,
      });
      cleanupMarker();
      process.exit(1);
    }

    // Re-lock config file (each operation independent).
    // See lockAgentConfig in shields.ts for the full rationale on chattr.
    let lockVerified = true;
    if (configPath) {
      const lockErrors = [];
      try { kubectlExec(["chmod", "444", configPath]); } catch { lockErrors.push("chmod 444"); }
      try { kubectlExec(["chown", "root:root", configPath]); } catch { lockErrors.push("chown file"); }
      if (configDir) {
        try { kubectlExec(["chmod", "755", configDir]); } catch { lockErrors.push("chmod dir"); }
        try { kubectlExec(["chown", "root:root", configDir]); } catch { lockErrors.push("chown dir"); }
      }
      // Best-effort: config file was never chattr +i'd by entrypoint
      let chattrSucceeded = true;
      try { kubectlExec(["chattr", "+i", configPath]); } catch { chattrSucceeded = false; }

      // Verify mode + ownership (mandatory). Immutable bit only if chattr worked.
      const issues = [];
      try {
        const perms = execFileSync("docker", [
          "exec", K3S_CONTAINER,
          "kubectl", "exec", "-n", "openshell", sandboxName, "-c", "agent", "--",
          "stat", "-c", "%a %U:%G", configPath,
        ], { stdio: ["ignore", "pipe", "pipe"], timeout: 15000 }).toString().trim();
        const [mode, owner] = perms.split(" ");
        if (!/^4[0-4][0-4]$/.test(mode)) issues.push(`file mode=${mode}`);
        if (owner !== "root:root") issues.push(`file owner=${owner}`);
      } catch {
        issues.push("file stat failed");
      }

      if (configDir) {
        try {
          const dirPerms = execFileSync("docker", [
            "exec", K3S_CONTAINER,
            "kubectl", "exec", "-n", "openshell", sandboxName, "-c", "agent", "--",
            "stat", "-c", "%a %U:%G", configDir,
          ], { stdio: ["ignore", "pipe", "pipe"], timeout: 15000 }).toString().trim();
          const [dirMode, dirOwner] = dirPerms.split(" ");
          if (dirMode !== "755") issues.push(`dir mode=${dirMode}`);
          if (dirOwner !== "root:root") issues.push(`dir owner=${dirOwner}`);
        } catch {
          issues.push("dir stat failed");
        }
      }

      if (chattrSucceeded) {
        try {
          const attrs = execFileSync("docker", [
            "exec", K3S_CONTAINER,
            "kubectl", "exec", "-n", "openshell", sandboxName, "-c", "agent", "--",
            "lsattr", "-d", configPath,
          ], { stdio: ["ignore", "pipe", "pipe"], timeout: 15000 }).toString().trim();
          const [flags] = attrs.split(/\s+/, 1);
          if (!flags.includes("i")) issues.push("immutable bit not set");
        } catch {
          // lsattr may not be available — skip
        }
      }

      if (issues.length > 0 || lockErrors.length > 0) {
        lockVerified = issues.length === 0;
        appendAudit({
          action: "shields_auto_restore_lock_warning",
          sandbox: sandboxName,
          timestamp: now,
          restored_by: "auto_timer",
          warning: `Lock issues: ${[...lockErrors, ...issues].join(", ")}`,
          lock_verified: lockVerified,
        });
      }
    }

    // Only mark shields as UP if the lock was verified (or no config path)
    if (lockVerified) {
      updateState({
        shieldsDown: false,
        shieldsDownAt: null,
        shieldsDownTimeout: null,
        shieldsDownReason: null,
        shieldsDownPolicy: null,
      });

      appendAudit({
        action: "shields_auto_restore",
        sandbox: sandboxName,
        timestamp: now,
        restored_by: "auto_timer",
        policy_snapshot: snapshotPath,
      });
    } else {
      appendAudit({
        action: "shields_up_failed",
        sandbox: sandboxName,
        timestamp: now,
        restored_by: "auto_timer",
        error: "Config re-lock verification failed — shields remain DOWN",
      });
      cleanupMarker();
      process.exit(1);
    }
  } catch (err) {
    appendAudit({
      action: "shields_up_failed",
      sandbox: sandboxName,
      timestamp: now,
      restored_by: "auto_timer",
      error: err?.message ?? String(err),
    });
    cleanupMarker();
    process.exit(1);
  } finally {
    cleanupMarker();
    process.exit(0);
  }
}, delayMs);
