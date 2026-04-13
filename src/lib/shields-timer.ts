// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Auto-restore timer for shields-down. Runs as a detached child process
// forked by shields.ts. Sleeps for the specified timeout, then restores
// the captured policy snapshot.
//
// Usage (internal — called by shields.ts via fork()):
//   node shields-timer.js <sandbox-name> <snapshot-path> <timeout-seconds>

const fs = require("fs");
const path = require("path");
const { run } = require("./runner");
const { buildPolicySetCommand } = require("./policies");

const STATE_DIR = path.join(process.env.HOME ?? "/tmp", ".nemoclaw", "state");
const STATE_FILE = path.join(STATE_DIR, "nemoclaw.json");
const AUDIT_FILE = path.join(STATE_DIR, "shields-audit.jsonl");

const [sandboxName, snapshotPath, timeoutStr] = process.argv.slice(2);
const timeoutMs = Number(timeoutStr) * 1000;

if (!sandboxName || !snapshotPath || !timeoutMs || isNaN(timeoutMs)) {
  process.exit(1);
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

    // Restore policy
    run(buildPolicySetCommand(snapshotPath, sandboxName), { ignoreError: true });

    // Update state
    updateState({
      shieldsDown: false,
      shieldsDownAt: null,
      shieldsDownTimeout: null,
      shieldsDownReason: null,
      shieldsDownPolicy: null,
    });

    // Audit
    appendAudit({
      action: "shields_auto_restore",
      sandbox: sandboxName,
      timestamp: now,
      restored_by: "auto_timer",
      duration_seconds: Number(timeoutStr),
      policy_snapshot: snapshotPath,
    });
  } catch (err) {
    appendAudit({
      action: "shields_up_failed",
      sandbox: sandboxName,
      timestamp: now,
      restored_by: "auto_timer",
      error: err?.message ?? String(err),
    });
  } finally {
    cleanupMarker();
    process.exit(0);
  }
}, timeoutMs);
