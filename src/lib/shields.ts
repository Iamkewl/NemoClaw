// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Host-side shields management: down, up, status.
//
// Shields provide time-bounded policy relaxation with automatic restore.
// The sandbox cannot lower or raise its own shields — all mutations are
// host-initiated (security invariant).

const fs = require("fs");
const path = require("path");
const { fork } = require("child_process");
const { run, runCapture, validateName, shellQuote } = require("./runner");
const {
  buildPolicyGetCommand,
  buildPolicySetCommand,
  parseCurrentPolicy,
  PERMISSIVE_POLICY_PATH,
} = require("./policies");

const STATE_DIR = path.join(process.env.HOME ?? "/tmp", ".nemoclaw", "state");

// ---------------------------------------------------------------------------
// Duration parsing (inline to avoid cross-module import complexity in CJS)
// ---------------------------------------------------------------------------

const MAX_TIMEOUT_SECONDS = 1800; // 30 minutes — security invariant
const DEFAULT_TIMEOUT_SECONDS = 300; // 5 minutes
const DURATION_RE = /^(\d+)\s*(s|m|h)?$/i;
const MULTIPLIERS = { s: 1, m: 60, h: 3600 };

function parseDuration(input) {
  const trimmed = (input || "").trim();
  if (!trimmed) return DEFAULT_TIMEOUT_SECONDS;

  const match = DURATION_RE.exec(trimmed);
  if (!match) {
    throw new Error(
      `Invalid duration "${trimmed}". Use a number with optional suffix: 300, 5m, 30m`,
    );
  }

  const value = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  const seconds = value * (MULTIPLIERS[unit] ?? 1);

  if (seconds <= 0) throw new Error("Duration must be greater than zero");
  if (seconds > MAX_TIMEOUT_SECONDS) {
    throw new Error(
      `Duration ${seconds}s exceeds maximum of ${MAX_TIMEOUT_SECONDS}s (${MAX_TIMEOUT_SECONDS / 60} minutes)`,
    );
  }
  return seconds;
}

// ---------------------------------------------------------------------------
// Audit logging (inline for CJS compatibility)
// ---------------------------------------------------------------------------

const AUDIT_FILE = path.join(STATE_DIR, "shields-audit.jsonl");

function appendAudit(entry) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + "\n", { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// State helpers — read/write shields state from ~/.nemoclaw/state/nemoclaw.json
// ---------------------------------------------------------------------------

const STATE_FILE = path.join(STATE_DIR, "nemoclaw.json");

function loadShieldsState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveShieldsState(patch) {
  const current = loadShieldsState();
  const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(STATE_FILE, JSON.stringify(updated, null, 2), { mode: 0o600 });
  return updated;
}

// ---------------------------------------------------------------------------
// Timer marker — tracks the detached auto-restore process
// ---------------------------------------------------------------------------

function timerMarkerPath(sandboxName) {
  return path.join(STATE_DIR, `shields-timer-${sandboxName}.json`);
}

function readTimerMarker(sandboxName) {
  const p = timerMarkerPath(sandboxName);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

function killTimer(sandboxName) {
  const marker = readTimerMarker(sandboxName);
  if (!marker) return;
  try {
    process.kill(marker.pid, "SIGTERM");
  } catch {
    // Process already exited — fine
  }
  try {
    fs.unlinkSync(timerMarkerPath(sandboxName));
  } catch {
    // Best effort
  }
}

// ---------------------------------------------------------------------------
// shields down
// ---------------------------------------------------------------------------

function shieldsDown(sandboxName, opts = {}) {
  validateName(sandboxName, "sandbox name");

  const state = loadShieldsState();
  if (state.shieldsDown) {
    console.error(
      `  Shields are already DOWN for ${sandboxName} (since ${state.shieldsDownAt}).`,
    );
    console.error("  Run `nemoclaw shields up` first, or use --extend (not yet implemented).");
    process.exit(1);
  }

  const timeoutSeconds = parseDuration(opts.timeout || `${DEFAULT_TIMEOUT_SECONDS}`);
  const reason = opts.reason || null;
  const policyName = opts.policy || "permissive";

  // 1. Capture current policy snapshot
  console.log("  Capturing current policy snapshot...");
  let rawPolicy;
  try {
    rawPolicy = runCapture(buildPolicyGetCommand(sandboxName), { ignoreError: true });
  } catch {
    rawPolicy = "";
  }

  if (!rawPolicy || !rawPolicy.trim()) {
    console.error("  Cannot capture current policy. Is the sandbox running?");
    process.exit(1);
  }

  const ts = Date.now();
  const snapshotPath = path.join(STATE_DIR, `policy-snapshot-${ts}.yaml`);
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(snapshotPath, rawPolicy, { mode: 0o600 });
  console.log(`  Saved: ${snapshotPath}`);

  // 2. Determine and apply relaxed policy
  let policyFile;
  if (policyName === "permissive") {
    policyFile = PERMISSIVE_POLICY_PATH;
  } else if (fs.existsSync(policyName)) {
    policyFile = path.resolve(policyName);
  } else {
    console.error(`  Unknown policy "${policyName}". Use "permissive" or a path to a YAML file.`);
    process.exit(1);
  }

  console.log(`  Applying ${policyName} policy...`);
  run(buildPolicySetCommand(policyFile, sandboxName));

  // 3. Update state
  const now = new Date().toISOString();
  saveShieldsState({
    shieldsDown: true,
    shieldsDownAt: now,
    shieldsDownTimeout: timeoutSeconds,
    shieldsDownReason: reason,
    shieldsDownPolicy: policyName,
    shieldsPolicySnapshotPath: snapshotPath,
  });

  // 4. Start auto-restore timer (detached child process)
  const timerScript = path.join(__dirname, "shields-timer.ts");
  // The timer script might be compiled to .js in dist/
  const timerScriptJs = timerScript.replace(/\.ts$/, ".js");
  const actualScript = fs.existsSync(timerScriptJs) ? timerScriptJs : timerScript;

  try {
    const child = fork(actualScript, [sandboxName, snapshotPath, String(timeoutSeconds)], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    // Write timer marker
    const markerPath = timerMarkerPath(sandboxName);
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        pid: child.pid,
        sandboxName,
        snapshotPath,
        restoreAt: new Date(Date.now() + timeoutSeconds * 1000).toISOString(),
      }),
      { mode: 0o600 },
    );
  } catch (err) {
    console.error(`  Warning: Could not start auto-restore timer: ${err.message}`);
    console.error("  You MUST manually run `nemoclaw shields up` when done.");
  }

  // 5. Audit log
  appendAudit({
    action: "shields_down",
    sandbox: sandboxName,
    timestamp: now,
    timeout_seconds: timeoutSeconds,
    reason,
    policy_applied: policyName,
    policy_snapshot: snapshotPath,
  });

  // 6. Output
  const mins = Math.floor(timeoutSeconds / 60);
  const secs = timeoutSeconds % 60;
  console.log(`  Shields DOWN for ${sandboxName} (timeout: ${mins}m${secs ? ` ${secs}s` : ""})`);
  console.log("");
  console.log("  Warning: Sandbox security is relaxed.");
  console.log(`  Run \`nemoclaw ${sandboxName} shields up\` when done.`);
}

// ---------------------------------------------------------------------------
// shields up
// ---------------------------------------------------------------------------

function shieldsUp(sandboxName) {
  validateName(sandboxName, "sandbox name");

  const state = loadShieldsState();
  if (!state.shieldsDown) {
    console.log("  Shields are already UP.");
    return;
  }

  const snapshotPath = state.shieldsPolicySnapshotPath;
  if (!snapshotPath || !fs.existsSync(snapshotPath)) {
    console.error("  No policy snapshot found. Cannot restore — manual intervention required.");
    console.error("  Apply your intended policy with: openshell policy set --policy <file>");
    process.exit(1);
  }

  // 1. Kill auto-restore timer if running
  killTimer(sandboxName);

  // 2. Restore policy from snapshot
  console.log("  Restoring policy from snapshot...");
  run(buildPolicySetCommand(snapshotPath, sandboxName));

  // 3. Calculate duration
  const downAt = state.shieldsDownAt ? new Date(state.shieldsDownAt) : new Date();
  const now = new Date();
  const durationSeconds = Math.floor((now.getTime() - downAt.getTime()) / 1000);

  // 4. Update state
  saveShieldsState({
    shieldsDown: false,
    shieldsDownAt: null,
    shieldsDownTimeout: null,
    shieldsDownReason: null,
    shieldsDownPolicy: null,
    // Keep snapshotPath for forensics — don't clear it
  });

  // 5. Audit log
  appendAudit({
    action: "shields_up",
    sandbox: sandboxName,
    timestamp: now.toISOString(),
    restored_by: "operator",
    duration_seconds: durationSeconds,
    policy_snapshot: snapshotPath,
    reason: state.shieldsDownReason,
  });

  // 6. Output
  const mins = Math.floor(durationSeconds / 60);
  const secs = durationSeconds % 60;
  console.log(`  Shields UP for ${sandboxName}`);
  console.log(`  Duration: ${mins}m ${secs}s | Reason: ${state.shieldsDownReason ?? "not specified"}`);
}

// ---------------------------------------------------------------------------
// shields status
// ---------------------------------------------------------------------------

function shieldsStatus(sandboxName) {
  validateName(sandboxName, "sandbox name");

  const state = loadShieldsState();

  if (!state.shieldsDown) {
    console.log("  Shields: UP");
    console.log(`  Policy:  default${state.shieldsPolicySnapshotPath ? " (last snapshot preserved)" : ""}`);
    if (state.shieldsDownAt) {
      console.log(`  Last lowered: ${state.shieldsDownAt}`);
    }
    return;
  }

  const downSince = state.shieldsDownAt ? new Date(state.shieldsDownAt) : null;
  const elapsed = downSince ? Math.floor((Date.now() - downSince.getTime()) / 1000) : 0;
  const remaining =
    state.shieldsDownTimeout != null
      ? Math.max(0, state.shieldsDownTimeout - elapsed)
      : null;

  console.log("  Shields: DOWN");
  console.log(`  Since:   ${state.shieldsDownAt ?? "unknown"}`);
  if (remaining !== null) {
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    console.log(`  Timeout: ${mins}m ${secs}s remaining`);
  }
  console.log(`  Reason:  ${state.shieldsDownReason ?? "not specified"}`);
  console.log(`  Policy:  ${state.shieldsDownPolicy ?? "permissive"}`);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  shieldsDown,
  shieldsUp,
  shieldsStatus,
  parseDuration,
  MAX_TIMEOUT_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
};
