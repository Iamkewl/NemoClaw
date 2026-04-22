// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Host-side shields management: down, up, status.
//
// Config starts mutable (the default state). Shields provide opt-in
// lockdown: `shields up` locks config + applies a restrictive network
// policy, `shields down` returns to the default (mutable) state.
// Time-bounded shields-down has automatic restore via a detached timer.
// The sandbox cannot lower or raise its own shields — all mutations are
// host-initiated (security invariant).

const fs = require("fs");
const path = require("path");
const { fork, execFileSync } = require("child_process");
const { run, runCapture, validateName, shellQuote } = require("./runner");
const {
  buildPolicyGetCommand,
  buildPolicySetCommand,
  parseCurrentPolicy,
  PERMISSIVE_POLICY_PATH,
} = require("./policies");
const { parseDuration, MAX_SECONDS, DEFAULT_SECONDS } = require("./duration");
const { appendAuditEntry } = require("./shields-audit");
const { resolveAgentConfig } = require("./sandbox-config");

const STATE_DIR = path.join(process.env.HOME ?? "/tmp", ".nemoclaw", "state");

// ---------------------------------------------------------------------------
// kubectl exec — bypasses the sandbox's Landlock context
//
// openshell sandbox exec runs commands INSIDE the Landlock domain, so it
// can't modify read_only paths or change chattr flags. kubectl exec starts
// a new process in the pod that does NOT inherit the Landlock ruleset.
// We reach kubectl via the K3s container: docker exec <k3s> kubectl exec ...
// ---------------------------------------------------------------------------

const K3S_CONTAINER = "openshell-cluster-nemoclaw";

function kubectlExec(sandboxName: string, cmd: string[]): void {
  execFileSync(
    "docker",
    [
      "exec",
      K3S_CONTAINER,
      "kubectl",
      "exec",
      "-n",
      "openshell",
      sandboxName,
      "-c",
      "agent",
      "--",
      ...cmd,
    ],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 15000 },
  );
}

function kubectlExecCapture(sandboxName: string, cmd: string[]): string {
  return execFileSync(
    "docker",
    [
      "exec",
      K3S_CONTAINER,
      "kubectl",
      "exec",
      "-n",
      "openshell",
      sandboxName,
      "-c",
      "agent",
      "--",
      ...cmd,
    ],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 15000 },
  )
    .toString()
    .trim();
}

// Re-export for tests and external consumers
const MAX_TIMEOUT_SECONDS = MAX_SECONDS;
const DEFAULT_TIMEOUT_SECONDS = DEFAULT_SECONDS;

// ---------------------------------------------------------------------------
// State helpers — read/write shields state per sandbox
// ---------------------------------------------------------------------------

function stateFilePath(sandboxName: string): string {
  return path.join(STATE_DIR, `shields-${sandboxName}.json`);
}

interface ShieldsState {
  shieldsDown?: boolean;
  shieldsDownAt?: string | null;
  shieldsDownTimeout?: number | null;
  shieldsDownReason?: string | null;
  shieldsDownPolicy?: string | null;
  shieldsPolicySnapshotPath?: string | null;
  updatedAt?: string;
}

function loadShieldsState(sandboxName: string): ShieldsState {
  const filePath = stateFilePath(sandboxName);
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as ShieldsState;
  } catch {
    return {};
  }
}

function saveShieldsState(sandboxName: string, patch: ShieldsState): ShieldsState {
  const current = loadShieldsState(sandboxName);
  const updated: ShieldsState = { ...current, ...patch, updatedAt: new Date().toISOString() };
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(stateFilePath(sandboxName), JSON.stringify(updated, null, 2), { mode: 0o600 });
  return updated;
}

// ---------------------------------------------------------------------------
// Timer marker — tracks the detached auto-restore process
// ---------------------------------------------------------------------------

interface TimerMarker {
  pid: number;
  sandboxName: string;
  snapshotPath: string;
  restoreAt: string;
}

function timerMarkerPath(sandboxName: string): string {
  return path.join(STATE_DIR, `shields-timer-${sandboxName}.json`);
}

function readTimerMarker(sandboxName: string): TimerMarker | null {
  const p = timerMarkerPath(sandboxName);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as TimerMarker;
  } catch {
    return null;
  }
}

function killTimer(sandboxName: string): void {
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
// Config unlock — returns config to the default (mutable) state
//
// Sets permissions to sandbox:sandbox 0600/0700, matching what OpenClaw
// writes natively (mode 384 = 0o600). This keeps `openclaw doctor` happy.
//
// Note on chattr: best-effort — it may silently fail if kubectl exec
// lacks CAP_LINUX_IMMUTABLE or if the file was never immutable. That's fine:
// the file becomes writable through the permissive policy (disables Landlock
// read_only) + chown/chmod below.
// ---------------------------------------------------------------------------

function unlockAgentConfig(
  sandboxName: string,
  target: { configPath: string; configDir: string; sensitiveFiles?: string[] },
): void {
  const errors: string[] = [];
  const filesToUnlock = [target.configPath, ...(target.sensitiveFiles || [])];
  for (const f of filesToUnlock) {
    try {
      kubectlExec(sandboxName, ["chattr", "-i", f]);
    } catch {
      errors.push(`chattr -i ${f}`);
    }
    try {
      kubectlExec(sandboxName, ["chown", "sandbox:sandbox", f]);
    } catch {
      errors.push(`chown ${f}`);
    }
    try {
      kubectlExec(sandboxName, ["chmod", "600", f]);
    } catch {
      errors.push(`chmod 600 ${f}`);
    }
  }
  try {
    kubectlExec(sandboxName, ["chown", "sandbox:sandbox", target.configDir]);
  } catch {
    errors.push("chown config dir");
  }
  try {
    kubectlExec(sandboxName, ["chmod", "700", target.configDir]);
  } catch {
    errors.push("chmod 700 config dir");
  }
  if (errors.length > 0) {
    console.error(
      `  Warning: Some unlock operations failed: ${errors.join(", ")}. Config may remain read-only.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Config lock — used by shields-up (opt-in lockdown), auto-restore timer,
// and rollback
//
// Each operation runs independently so a single failure does not skip the
// rest. After all attempts, we verify the actual on-disk state and throw
// if the config is not properly locked.
//
// The config file's protection comes from three layers:
//   1. Landlock read_only path — kernel-level, restored by policy snapshot
//   2. UNIX permissions — 444 root:root (mandatory, verified here)
//   3. chattr +i immutable bit — defense-in-depth (best-effort)
//
// Layer 3 is best-effort because kubectl exec may lack
// CAP_LINUX_IMMUTABLE. Layers 1+2 are sufficient. We still attempt it
// in case the runtime environment supports it.
// ---------------------------------------------------------------------------

function lockAgentConfig(
  sandboxName: string,
  target: { configPath: string; configDir: string; sensitiveFiles?: string[] },
): void {
  const errors: string[] = [];
  const filesToLock = [target.configPath, ...(target.sensitiveFiles || [])];

  for (const f of filesToLock) {
    try {
      kubectlExec(sandboxName, ["chmod", "444", f]);
    } catch {
      errors.push(`chmod 444 ${f}`);
    }
    try {
      kubectlExec(sandboxName, ["chown", "root:root", f]);
    } catch {
      errors.push(`chown root:root ${f}`);
    }
  }

  try {
    kubectlExec(sandboxName, ["chmod", "755", target.configDir]);
  } catch {
    errors.push("chmod 755 config dir");
  }

  try {
    kubectlExec(sandboxName, ["chown", "root:root", target.configDir]);
  } catch {
    errors.push("chown root:root config dir");
  }

  // Best-effort: kubectl exec may lack CAP_LINUX_IMMUTABLE. Track the
  // result so verification doesn't require something that was never there.
  let chattrSucceeded = true;
  for (const f of filesToLock) {
    try {
      kubectlExec(sandboxName, ["chattr", "+i", f]);
    } catch {
      chattrSucceeded = false;
    }
  }

  if (errors.length > 0) {
    console.error(`  Some lock operations failed: ${errors.join(", ")}`);
  }

  // Verify the lock actually took effect.
  // Mode + ownership are mandatory (layers 1+2 depend on them).
  // Immutable bit is only verified if chattr succeeded above.
  const issues: string[] = [];
  try {
    const perms = kubectlExecCapture(sandboxName, ["stat", "-c", "%a %U:%G", target.configPath]);
    const [mode, owner] = perms.split(" ");
    if (!/^4[0-4][0-4]$/.test(mode)) issues.push(`file mode=${mode} (expected 444)`);
    if (owner !== "root:root") issues.push(`file owner=${owner} (expected root:root)`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    issues.push(`file stat failed: ${msg}`);
  }

  try {
    const dirPerms = kubectlExecCapture(sandboxName, ["stat", "-c", "%a %U:%G", target.configDir]);
    const [dirMode, dirOwner] = dirPerms.split(" ");
    if (dirMode !== "755") issues.push(`dir mode=${dirMode} (expected 755)`);
    if (dirOwner !== "root:root") issues.push(`dir owner=${dirOwner} (expected root:root)`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    issues.push(`dir stat failed: ${msg}`);
  }

  if (chattrSucceeded) {
    try {
      const attrs = kubectlExecCapture(sandboxName, ["lsattr", "-d", target.configPath]);
      // lsattr format: "----i---------e----- /path/to/file"
      // First whitespace-delimited token is the flags field.
      const [flags] = attrs.trim().split(/\s+/, 1);
      if (!flags.includes("i")) issues.push("immutable bit not set");
    } catch {
      // lsattr may not be available on all images — skip
    }
  }

  if (issues.length > 0) {
    throw new Error(`Config not locked: ${issues.join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
// shields down — return to default (mutable) state
//
// Unlocks config + applies permissive network policy. This is the default
// operating mode; shields-down undoes a previous shields-up lockdown.
// ---------------------------------------------------------------------------

interface ShieldsDownOpts {
  timeout?: string | null;
  reason?: string | null;
  policy?: string;
}

function shieldsDown(sandboxName: string, opts: ShieldsDownOpts = {}): void {
  validateName(sandboxName, "sandbox name");

  // Kill any stale timer from a previous cycle
  killTimer(sandboxName);

  const state = loadShieldsState(sandboxName);
  if (state.shieldsDown) {
    console.error(
      `  Config is already unlocked for ${sandboxName} (since ${state.shieldsDownAt}).`,
    );
    console.error("  Run `nemoclaw shields up` first, or use --extend (not yet implemented).");
    process.exit(1);
  }

  const timeoutSeconds = parseDuration(opts.timeout || `${DEFAULT_TIMEOUT_SECONDS}`);
  const reason = opts.reason || null;
  const policyName = opts.policy || "permissive";

  // 1. Capture current policy snapshot
  console.log("  Capturing current policy snapshot...");
  let rawPolicy: string;
  try {
    rawPolicy = runCapture(buildPolicyGetCommand(sandboxName), { ignoreError: true });
  } catch {
    rawPolicy = "";
  }

  const policyYaml = parseCurrentPolicy(rawPolicy);
  if (!policyYaml) {
    console.error("  Cannot capture current policy. Is the sandbox running?");
    process.exit(1);
  }

  const ts = Date.now();
  const snapshotPath = path.join(STATE_DIR, `policy-snapshot-${ts}.yaml`);
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(snapshotPath, policyYaml, { mode: 0o600 });
  console.log(`  Saved: ${snapshotPath}`);

  // 2. Determine and apply relaxed policy
  let policyFile: string;
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

  // 2b. Return config to default mutable state.
  //     Permissions are set to sandbox:sandbox 0600/0700 to match what
  //     OpenClaw natively creates (mode 384 = 0o600) so `openclaw doctor`
  //     sees the expected owner and mode without recommending fixes.
  const target = resolveAgentConfig(sandboxName);
  console.log(`  Unlocking ${target.agentName} config (${target.configPath})...`);
  unlockAgentConfig(sandboxName, target);

  // 3. Update state
  const now = new Date().toISOString();
  saveShieldsState(sandboxName, {
    shieldsDown: true,
    shieldsDownAt: now,
    shieldsDownTimeout: timeoutSeconds,
    shieldsDownReason: reason,
    shieldsDownPolicy: policyName,
    shieldsPolicySnapshotPath: snapshotPath,
  });

  // 4. Start auto-restore timer (detached child process)
  //    Pass the absolute restore time, not a relative timeout. Steps 1-2b
  //    can take minutes (policy apply + kubectl chmod), so a relative timeout
  //    passed at fork time would fire too early.
  const restoreAt = new Date(Date.now() + timeoutSeconds * 1000);
  const timerScript = path.join(__dirname, "shields-timer.ts");
  const timerScriptJs = timerScript.replace(/\.ts$/, ".js");
  const actualScript = fs.existsSync(timerScriptJs) ? timerScriptJs : timerScript;

  try {
    const child = fork(
      actualScript,
      [sandboxName, snapshotPath, restoreAt.toISOString(), target.configPath, target.configDir],
      {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    child.disconnect();
    child.unref();

    // Write timer marker
    const markerPath = timerMarkerPath(sandboxName);
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        pid: child.pid,
        sandboxName,
        snapshotPath,
        restoreAt: restoreAt.toISOString(),
      }),
      { mode: 0o600 },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  Cannot start auto-restore timer: ${message}`);
    console.error("  Rolling back — restoring policy from snapshot...");
    const rollbackResult = run(buildPolicySetCommand(snapshotPath, sandboxName), {
      ignoreError: true,
    });
    let rollbackLocked = false;
    if (rollbackResult.status === 0) {
      try {
        lockAgentConfig(sandboxName, target);
        rollbackLocked = true;
      } catch {
        console.error("  Warning: Rollback re-lock could not be verified. Check config manually.");
      }
    } else {
      console.error("  Warning: Policy restore failed during rollback.");
    }
    if (rollbackLocked) {
      saveShieldsState(sandboxName, {
        shieldsDown: false,
        shieldsDownAt: null,
        shieldsDownTimeout: null,
        shieldsDownReason: null,
        shieldsDownPolicy: null,
      });
      console.error("  Lockdown restored. Config was never left unguarded.");
    } else {
      // Leave state as shieldsDown: true — don't lie about protection level
      console.error("  Config remains unlocked — manual intervention required.");
      console.error(
        `  Re-lock manually via kubectl exec, then run: nemoclaw ${sandboxName} shields up`,
      );
    }
    process.exit(1);
  }

  // 5. Audit log
  appendAuditEntry({
    action: "shields_down",
    sandbox: sandboxName,
    timestamp: now,
    timeout_seconds: timeoutSeconds,
    reason: reason ?? undefined,
    policy_applied: policyName,
    policy_snapshot: snapshotPath,
  });

  // 6. Output
  const mins = Math.floor(timeoutSeconds / 60);
  const secs = timeoutSeconds % 60;
  console.log(
    `  Config unlocked for ${sandboxName} (auto-lockdown in: ${mins}m${secs ? ` ${secs}s` : ""})`,
  );
  console.log("");
  console.log("  Sandbox is in default (mutable) state.");
  console.log(`  Run \`nemoclaw ${sandboxName} shields up\` to opt into lockdown.`);
}

// ---------------------------------------------------------------------------
// shields up — opt into lockdown
//
// Locks config + applies restrictive network policy. This is an opt-in
// hardening step that restricts the sandbox beyond its default state.
// ---------------------------------------------------------------------------

function shieldsUp(sandboxName: string): void {
  validateName(sandboxName, "sandbox name");

  const state = loadShieldsState(sandboxName);
  // shieldsDown === false means explicitly locked by a previous shields-up.
  // undefined (no state file) means fresh sandbox — mutable default, allow shields-up.
  if (state.shieldsDown === false) {
    console.log("  Lockdown is already active.");
    return;
  }

  // 1. Kill auto-restore timer if running
  killTimer(sandboxName);

  // 2. If coming from shields-down, restore the saved policy snapshot.
  //    If first shields-up on a fresh sandbox (no prior shields-down),
  //    the current policy is already the restrictive baseline — skip restore.
  const snapshotPath = state.shieldsDown ? state.shieldsPolicySnapshotPath : undefined;
  if (snapshotPath && fs.existsSync(snapshotPath)) {
    console.log("  Restoring restrictive policy from snapshot...");
    run(buildPolicySetCommand(snapshotPath, sandboxName));
  }

  // 2b. Lock config file to read-only.
  //     Uses kubectl exec to bypass Landlock (same as shields down).
  //     Each operation runs independently and the result is verified.
  //     If verification fails, config remains unlocked — we do not lie about state.
  const target = resolveAgentConfig(sandboxName);
  console.log(`  Locking ${target.agentName} config (${target.configPath})...`);
  try {
    lockAgentConfig(sandboxName, target);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ERROR: ${message}`);
    console.error("  Config remains unlocked — manual intervention required.");
    console.error(
      `  Re-lock manually via kubectl exec, then run: nemoclaw ${sandboxName} shields up`,
    );
    process.exit(1);
  }

  // 3. Calculate duration
  const downAt = state.shieldsDownAt ? new Date(state.shieldsDownAt) : new Date();
  const now = new Date();
  const durationSeconds = Math.floor((now.getTime() - downAt.getTime()) / 1000);

  // 4. Update state
  saveShieldsState(sandboxName, {
    shieldsDown: false,
    shieldsDownAt: null,
    shieldsDownTimeout: null,
    shieldsDownReason: null,
    shieldsDownPolicy: null,
    // Keep snapshotPath for forensics — don't clear it
  });

  // 5. Audit log
  appendAuditEntry({
    action: "shields_up",
    sandbox: sandboxName,
    timestamp: now.toISOString(),
    restored_by: "operator",
    duration_seconds: durationSeconds,
    policy_snapshot: snapshotPath,
    reason: state.shieldsDownReason ?? undefined,
  });

  // 6. Output
  const mins = Math.floor(durationSeconds / 60);
  const secs = durationSeconds % 60;
  console.log(`  Lockdown active for ${sandboxName}`);
  console.log(
    `  Duration unlocked: ${mins}m ${secs}s | Reason: ${state.shieldsDownReason ?? "not specified"}`,
  );
}

// ---------------------------------------------------------------------------
// shields status
// ---------------------------------------------------------------------------

function shieldsStatus(sandboxName: string): void {
  validateName(sandboxName, "sandbox name");

  const state = loadShieldsState(sandboxName);

  if (!state.shieldsDown) {
    console.log("  Shields: UP (lockdown active)");
    console.log(
      `  Policy:  restrictive${state.shieldsPolicySnapshotPath ? " (snapshot preserved)" : ""}`,
    );
    if (state.shieldsDownAt) {
      console.log(`  Last unlocked: ${state.shieldsDownAt}`);
    }
    return;
  }

  const downSince = state.shieldsDownAt ? new Date(state.shieldsDownAt) : null;
  const elapsed = downSince ? Math.floor((Date.now() - downSince.getTime()) / 1000) : 0;
  const remaining =
    state.shieldsDownTimeout != null ? Math.max(0, state.shieldsDownTimeout - elapsed) : null;

  console.log("  Shields: DOWN (default mutable state)");
  console.log(`  Since:   ${state.shieldsDownAt ?? "unknown"}`);
  if (remaining !== null) {
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    console.log(`  Auto-lockdown in: ${mins}m ${secs}s`);
  }
  console.log(`  Reason:  ${state.shieldsDownReason ?? "not specified"}`);
  console.log(`  Policy:  ${state.shieldsDownPolicy ?? "permissive"}`);
}

// ---------------------------------------------------------------------------
// Query — check whether shields are currently down
// ---------------------------------------------------------------------------

function isShieldsDown(sandboxName: string): boolean {
  return loadShieldsState(sandboxName).shieldsDown === true;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  shieldsDown,
  shieldsUp,
  shieldsStatus,
  isShieldsDown,
  parseDuration,
  lockAgentConfig,
  MAX_TIMEOUT_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
};
