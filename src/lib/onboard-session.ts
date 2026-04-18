// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Onboard session management — create, load, save, and update the
 * onboarding session file (~/.nemoclaw/onboard-session.json) with
 * step-level progress tracking and file-based locking.
 */

import fs from "node:fs";
import path from "node:path";

import {
  createEmptyStepLedger,
  isOnboardStepName,
  type OnboardMode,
  type OnboardRunStatus,
  type OnboardStepLedger,
  type OnboardStepName,
  type OnboardStepState,
  type OnboardStepStatus,
} from "./onboard-fsm";
import type { WebSearchConfig } from "./web-search";

const LEGACY_SESSION_VERSION = 1;
export const SESSION_VERSION = 2;
export const SESSION_DIR = path.join(process.env.HOME || "/tmp", ".nemoclaw");
export const SESSION_FILE = path.join(SESSION_DIR, "onboard-session.json");
export const LOCK_FILE = path.join(SESSION_DIR, "onboard.lock");
const VALID_STEP_STATES = new Set<OnboardStepStatus>([
  "pending",
  "in_progress",
  "complete",
  "failed",
  "skipped",
]);

// ── Types ────────────────────────────────────────────────────────

export type StepState = OnboardStepState;

export interface SessionFailure {
  step: OnboardStepName | null;
  message: string | null;
  recordedAt: string;
}

export interface SessionMetadata {
  gatewayName: string;
  fromDockerfile: string | null;
}

export interface Session {
  version: number;
  sessionId: string;
  resumable: boolean;
  status: OnboardRunStatus;
  mode: OnboardMode;
  startedAt: string;
  updatedAt: string;
  lastStepStarted: OnboardStepName | null;
  lastCompletedStep: OnboardStepName | null;
  failure: SessionFailure | null;
  agent: string | null;
  sandboxName: string | null;
  provider: string | null;
  model: string | null;
  endpointUrl: string | null;
  credentialEnv: string | null;
  preferredInferenceApi: string | null;
  nimContainer: string | null;
  webSearchConfig: WebSearchConfig | null;
  messagingChannels: string[] | null;
  policyPresets: string[] | null;
  metadata: SessionMetadata;
  steps: OnboardStepLedger;
}

export interface LockInfo {
  pid: number;
  startedAt: string | null;
  command: string | null;
}

export interface LockResult {
  acquired: boolean;
  lockFile: string;
  stale: boolean;
  holderPid?: number;
  holderStartedAt?: string | null;
  holderCommand?: string | null;
}

export interface SessionUpdates {
  sandboxName?: string;
  provider?: string;
  model?: string;
  endpointUrl?: string;
  credentialEnv?: string;
  preferredInferenceApi?: string;
  nimContainer?: string;
  webSearchConfig?: WebSearchConfig | null;
  messagingChannels?: string[] | null;
  policyPresets?: string[];
  metadata?: { gatewayName?: string; fromDockerfile?: string | null };
}

// ── Helpers ──────────────────────────────────────────────────────

function ensureSessionDir(): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
}

export function sessionPath(): string {
  return SESSION_FILE;
}

export function lockPath(): string {
  return LOCK_FILE;
}

function defaultSteps(): OnboardStepLedger {
  return createEmptyStepLedger();
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function redactSensitiveText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value
    .replace(
      /(NVIDIA_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|COMPATIBLE_API_KEY|COMPATIBLE_ANTHROPIC_API_KEY|BRAVE_API_KEY)=\S+/gi,
      "$1=<REDACTED>",
    )
    .replace(/Bearer\s+\S+/gi, "Bearer <REDACTED>")
    .replace(/nvapi-[A-Za-z0-9_-]{10,}/g, "<REDACTED>")
    .replace(/ghp_[A-Za-z0-9]{20,}/g, "<REDACTED>")
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "<REDACTED>")
    .slice(0, 240);
}

export function sanitizeFailure(
  input: { step?: unknown; message?: unknown; recordedAt?: unknown } | null | undefined,
): SessionFailure | null {
  if (!input) return null;
  const step = isOnboardStepName(input.step) ? input.step : null;
  const message = redactSensitiveText(input.message);
  const recordedAt =
    typeof input.recordedAt === "string" ? input.recordedAt : new Date().toISOString();
  return step || message ? { step, message, recordedAt } : null;
}

export function validateStep(step: unknown): step is OnboardStepState {
  if (!isObject(step)) return false;
  if (!VALID_STEP_STATES.has(step.status as OnboardStepStatus)) return false;
  return true;
}

function isOnboardMode(value: unknown): value is OnboardMode {
  return value === "interactive" || value === "non-interactive";
}

function isOnboardRunStatus(value: unknown): value is OnboardRunStatus {
  return value === "in_progress" || value === "complete" || value === "failed";
}

function normalizeStepName(value: unknown): OnboardStepName | null {
  return isOnboardStepName(value) ? value : null;
}

function cloneStepState(step: OnboardStepState): OnboardStepState {
  return {
    status: step.status,
    startedAt: step.startedAt,
    completedAt: step.completedAt,
    error: step.error,
  };
}

function pickAggregateStepState(states: readonly OnboardStepState[]): OnboardStepState {
  const failed = states.find((state) => state.status === "failed");
  if (failed) return cloneStepState(failed);

  const inProgress = states.find((state) => state.status === "in_progress");
  if (inProgress) return cloneStepState(inProgress);

  const complete = states.find((state) => state.status === "complete");
  if (complete) return cloneStepState(complete);

  if (states.every((state) => state.status === "skipped")) {
    return cloneStepState(states[0]);
  }

  const skipped = states.find((state) => state.status === "skipped");
  if (skipped) return cloneStepState(skipped);

  return cloneStepState(states[0]);
}

function synchronizeRuntimeSteps(session: Session): void {
  const runtimeStates = [
    session.steps.runtime_setup,
    session.steps.openclaw,
    session.steps.agent_setup,
  ] as const;
  session.steps.runtime_setup = pickAggregateStepState(runtimeStates);

  if (session.steps.runtime_setup.status === "pending") {
    return;
  }

  const selectedLegacyStep = session.agent ? "agent_setup" : "openclaw";
  const siblingLegacyStep = session.agent ? "openclaw" : "agent_setup";

  if (session.steps[selectedLegacyStep].status === "pending") {
    session.steps[selectedLegacyStep] = cloneStepState(session.steps.runtime_setup);
  }

  if (
    session.steps.runtime_setup.status === "complete" &&
    session.steps[siblingLegacyStep].status === "pending"
  ) {
    session.steps[siblingLegacyStep] = {
      status: "skipped",
      startedAt: null,
      completedAt: null,
      error: null,
    };
  }
}

export function redactUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
    }
    for (const key of [...url.searchParams.keys()]) {
      if (/(^|[-_])(?:signature|sig|token|auth|access_token)$/i.test(key)) {
        url.searchParams.set(key, "<REDACTED>");
      }
    }
    url.hash = "";
    return url.toString();
  } catch {
    return redactSensitiveText(value);
  }
}

// ── Session CRUD ─────────────────────────────────────────────────

export function createSession(overrides: Partial<Session> = {}): Session {
  const now = new Date().toISOString();
  const session: Session = {
    version: SESSION_VERSION,
    sessionId: overrides.sessionId || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    resumable: true,
    status: overrides.status && isOnboardRunStatus(overrides.status) ? overrides.status : "in_progress",
    mode: overrides.mode && isOnboardMode(overrides.mode) ? overrides.mode : "interactive",
    startedAt: overrides.startedAt || now,
    updatedAt: overrides.updatedAt || now,
    lastStepStarted: overrides.lastStepStarted || null,
    lastCompletedStep: overrides.lastCompletedStep || null,
    failure: overrides.failure || null,
    agent: overrides.agent || null,
    sandboxName: overrides.sandboxName || null,
    provider: overrides.provider || null,
    model: overrides.model || null,
    endpointUrl: overrides.endpointUrl || null,
    credentialEnv: overrides.credentialEnv || null,
    preferredInferenceApi: overrides.preferredInferenceApi || null,
    nimContainer: overrides.nimContainer || null,
    webSearchConfig:
      overrides.webSearchConfig && overrides.webSearchConfig.fetchEnabled === true
        ? { fetchEnabled: true }
        : null,
    messagingChannels: Array.isArray(overrides.messagingChannels)
      ? overrides.messagingChannels.filter((value) => typeof value === "string")
      : null,
    policyPresets: Array.isArray(overrides.policyPresets)
      ? overrides.policyPresets.filter((value) => typeof value === "string")
      : null,
    metadata: {
      gatewayName: overrides.metadata?.gatewayName || "nemoclaw",
      fromDockerfile: overrides.metadata?.fromDockerfile || null,
    },
    steps: {
      ...defaultSteps(),
      ...(overrides.steps || {}),
    },
  };
  synchronizeRuntimeSteps(session);
  return session;
}

// eslint-disable-next-line complexity
export function normalizeSession(data: unknown): Session | null {
  if (!isObject(data)) return null;
  const d = data as Record<string, unknown>;
  if (d.version !== SESSION_VERSION && d.version !== LEGACY_SESSION_VERSION) {
    return null;
  }

  const normalized = createSession({
    sessionId: typeof d.sessionId === "string" ? d.sessionId : undefined,
    mode: isOnboardMode(d.mode) ? d.mode : undefined,
    status: isOnboardRunStatus(d.status) ? d.status : undefined,
    startedAt: typeof d.startedAt === "string" ? d.startedAt : undefined,
    updatedAt: typeof d.updatedAt === "string" ? d.updatedAt : undefined,
    agent: typeof d.agent === "string" ? d.agent : null,
    sandboxName: typeof d.sandboxName === "string" ? d.sandboxName : null,
    provider: typeof d.provider === "string" ? d.provider : null,
    model: typeof d.model === "string" ? d.model : null,
    endpointUrl: typeof d.endpointUrl === "string" ? redactUrl(d.endpointUrl) : null,
    credentialEnv: typeof d.credentialEnv === "string" ? d.credentialEnv : null,
    preferredInferenceApi:
      typeof d.preferredInferenceApi === "string" ? d.preferredInferenceApi : null,
    nimContainer: typeof d.nimContainer === "string" ? d.nimContainer : null,
    webSearchConfig:
      isObject(d.webSearchConfig) &&
      (d.webSearchConfig as Record<string, unknown>).fetchEnabled === true
        ? { fetchEnabled: true }
        : null,
    messagingChannels: Array.isArray(d.messagingChannels)
      ? (d.messagingChannels as unknown[]).filter((value) => typeof value === "string") as string[]
      : null,
    policyPresets: Array.isArray(d.policyPresets)
      ? (d.policyPresets as unknown[]).filter((value) => typeof value === "string") as string[]
      : null,
    lastStepStarted: normalizeStepName(d.lastStepStarted),
    lastCompletedStep: normalizeStepName(d.lastCompletedStep),
    failure: sanitizeFailure(d.failure as Record<string, unknown> | null),
    metadata: isObject(d.metadata)
      ? ({
          gatewayName: (d.metadata as Record<string, unknown>).gatewayName,
          fromDockerfile: (d.metadata as Record<string, unknown>).fromDockerfile || null,
        } as SessionMetadata)
      : undefined,
  } as Partial<Session>);
  normalized.resumable = d.resumable !== false;
  normalized.version = SESSION_VERSION;

  if (isObject(d.steps)) {
    for (const [rawName, step] of Object.entries(d.steps as Record<string, unknown>)) {
      const name = normalizeStepName(rawName);
      if (!name || !validateStep(step)) {
        continue;
      }
      normalized.steps[name] = {
        status: step.status,
        startedAt: typeof step.startedAt === "string" ? step.startedAt : null,
        completedAt: typeof step.completedAt === "string" ? step.completedAt : null,
        error: redactSensitiveText(step.error),
      };
    }
  }

  synchronizeRuntimeSteps(normalized);
  return normalized;
}

export function loadSession(): Session | null {
  try {
    if (!fs.existsSync(SESSION_FILE)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
    return normalizeSession(parsed);
  } catch {
    return null;
  }
}

export function saveSession(session: Session): Session {
  const normalized = normalizeSession(session) || createSession();
  normalized.updatedAt = new Date().toISOString();
  ensureSessionDir();
  const tmpFile = path.join(
    SESSION_DIR,
    `.onboard-session.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  fs.writeFileSync(tmpFile, JSON.stringify(normalized, null, 2), { mode: 0o600 });
  fs.renameSync(tmpFile, SESSION_FILE);
  return normalized;
}

export function clearSession(): void {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      fs.unlinkSync(SESSION_FILE);
    }
  } catch {
    return;
  }
}

// ── Locking ──────────────────────────────────────────────────────

function parseLockFile(contents: string): LockInfo | null {
  try {
    const parsed = JSON.parse(contents);
    if (typeof parsed?.pid !== "number") return null;
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : null,
      command: typeof parsed.command === "string" ? parsed.command : null,
    };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

// File descriptor we hold across the lifetime of an acquired lock. On
// release, fstat(fd).ino vs stat(path).ino confirms the on-disk path
// still resolves to the file we created — closing the residual TOCTOU
// window in the inode-only check by tying ownership to a live
// descriptor rather than a value re-read from disk. See #1281.
let heldLockFd: number | null = null;

export function acquireOnboardLock(command: string | null = null): LockResult {
  ensureSessionDir();
  const payload = JSON.stringify(
    {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      command: typeof command === "string" ? command : null,
    },
    null,
    2,
  );

  // The retry budget here used to be 2, which is the bare minimum needed
  // for "see-stale → cleanup → reclaim". With the inode-verified cleanup
  // below it can take a few additional spins under contention because
  // multiple concurrent stale-cleaners can race and lose to each other
  // before one reclaims, so give the loop a little more room.
  // See issue #1281.
  const MAX_ATTEMPTS = 5;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let fd: number;
    try {
      // openSync(..., "wx", mode) is the atomic create-or-fail
      // primitive. We hold the resulting fd at module scope so
      // releaseOnboardLock() can later confirm the on-disk path still
      // resolves to the same file we created (fstat ino vs stat ino).
      fd = fs.openSync(LOCK_FILE, "wx", 0o600);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
        throw error;
      }

      // Capture both the parsed lock and the inode so we can verify the
      // file we're about to unlink is STILL the same stale file we read.
      // Without the inode check, two concurrent processes can both read
      // the same stale lock, and the slower one will unlink the fresh
      // lock the faster one just claimed, breaking mutual exclusion.
      // See issue #1281.
      let existing: LockInfo | null;
      let staleInode: bigint | null;
      try {
        const stat = fs.statSync(LOCK_FILE, { bigint: true });
        staleInode = stat.ino;
        existing = parseLockFile(fs.readFileSync(LOCK_FILE, "utf8"));
      } catch (readError: unknown) {
        if ((readError as NodeJS.ErrnoException)?.code === "ENOENT") {
          continue;
        }
        throw readError;
      }
      if (!existing) {
        // Malformed lock file — leave it on disk (a human or another
        // process may be mid-write) and retry. Pre-#1281 behavior
        // preserved: never unlink a malformed lock automatically.
        continue;
      }
      if (isProcessAlive(existing.pid)) {
        return {
          acquired: false,
          lockFile: LOCK_FILE,
          stale: false,
          holderPid: existing.pid,
          holderStartedAt: existing.startedAt,
          holderCommand: existing.command,
        };
      }

      // Stale: unlink ONLY if the file on disk is still the same inode
      // we just read. If a concurrent process already cleaned up and
      // claimed the lock, the inode will have changed and we'll fall
      // through to the next iteration where openSync(wx) will either
      // succeed (we win) or fail EEXIST against the new holder (and we
      // re-read it).
      unlinkIfInodeMatches(LOCK_FILE, staleInode);
      continue;
    }

    // Atomic create succeeded — write the payload and keep the fd open
    // for the lifetime of the lock so releaseOnboardLock() can verify
    // ownership via the live descriptor.
    try {
      fs.writeSync(fd, payload);
    } catch (writeError) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
      throw writeError;
    }
    heldLockFd = fd;
    return { acquired: true, lockFile: LOCK_FILE, stale: false };
  }

  return { acquired: false, lockFile: LOCK_FILE, stale: true };
}

/**
 * Unlink LOCK_FILE only if its current inode equals `expectedInode`.
 * The dual stat-then-unlink is the only portable POSIX primitive Node
 * exposes for this — there's no atomic "unlink-if-inode" syscall — so
 * a sufficiently unlucky race can still slip through. The window is
 * orders of magnitude smaller than the unconditional unlink it
 * replaces, and the outer loop will detect a wrong unlink on its next
 * `writeFileSync(wx)` attempt because either we re-create the file
 * or we observe the new lock with a different inode.
 */
function unlinkIfInodeMatches(filePath: string, expectedInode: bigint | null): void {
  if (expectedInode === null) {
    return;
  }
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    if (stat.ino !== expectedInode) {
      // Someone else replaced the file. Leave it alone.
      return;
    }
  } catch (statError: unknown) {
    if ((statError as NodeJS.ErrnoException)?.code === "ENOENT") {
      return;
    }
    throw statError;
  }
  try {
    fs.unlinkSync(filePath);
  } catch (unlinkError: unknown) {
    if ((unlinkError as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw unlinkError;
    }
  }
}

export function releaseOnboardLock(): void {
  // Preferred path: we hold the fd from a successful acquireOnboardLock.
  // Verify the on-disk path still resolves to the same file (fstat ino
  // == stat ino) before unlinking. If they disagree, another process
  // has already replaced the lock and we must NOT touch their file.
  if (heldLockFd !== null) {
    const fd = heldLockFd;
    heldLockFd = null;
    try {
      const fdStat = fs.fstatSync(fd, { bigint: true });
      let pathInode: bigint | null = null;
      try {
        const pathStat = fs.statSync(LOCK_FILE, { bigint: true });
        pathInode = pathStat.ino;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
          // Unexpected — fall through to closing the fd.
        }
      }
      if (pathInode !== null && pathInode === fdStat.ino) {
        try {
          fs.unlinkSync(LOCK_FILE);
        } catch (unlinkError: unknown) {
          if ((unlinkError as NodeJS.ErrnoException)?.code !== "ENOENT") {
            // Best effort — surfacing this would mask the real error.
          }
        }
      }
    } catch {
      // fstat can fail if the fd was already closed somehow; nothing
      // safe to do beyond closing it below.
    } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    return;
  }

  // Fallback (no fd held — e.g., a test wrote the lock file directly,
  // or a previous release already ran): preserve the legacy pid-based
  // behavior so we never unlink a malformed lock and never unlink a
  // lock owned by another pid.
  try {
    if (!fs.existsSync(LOCK_FILE)) return;
    let existing: LockInfo | null = null;
    try {
      existing = parseLockFile(fs.readFileSync(LOCK_FILE, "utf8"));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
      throw error;
    }
    if (!existing) return;
    if (existing.pid !== process.pid) return;
    fs.unlinkSync(LOCK_FILE);
  } catch {
    return;
  }
}

// ── Step management ──────────────────────────────────────────────

export function filterSafeUpdates(updates: SessionUpdates): Partial<Session> {
  const safe: Partial<Session> = {};
  if (!isObject(updates)) return safe;
  if (typeof updates.sandboxName === "string") safe.sandboxName = updates.sandboxName;
  if (typeof updates.provider === "string") safe.provider = updates.provider;
  if (typeof updates.model === "string") safe.model = updates.model;
  if (typeof updates.endpointUrl === "string") safe.endpointUrl = redactUrl(updates.endpointUrl);
  if (typeof updates.credentialEnv === "string") safe.credentialEnv = updates.credentialEnv;
  if (typeof updates.preferredInferenceApi === "string")
    safe.preferredInferenceApi = updates.preferredInferenceApi;
  if (typeof updates.nimContainer === "string") safe.nimContainer = updates.nimContainer;
  if (isObject(updates.webSearchConfig) && updates.webSearchConfig.fetchEnabled === true) {
    safe.webSearchConfig = { fetchEnabled: true };
  } else if (updates.webSearchConfig === null) {
    safe.webSearchConfig = null;
  }
  if (Array.isArray(updates.messagingChannels)) {
    safe.messagingChannels = updates.messagingChannels.filter((value) => typeof value === "string");
  } else if (updates.messagingChannels === null) {
    safe.messagingChannels = null;
  }
  if (Array.isArray(updates.policyPresets)) {
    safe.policyPresets = updates.policyPresets.filter((value) => typeof value === "string");
  }
  if (isObject(updates.metadata) && typeof updates.metadata.gatewayName === "string") {
    safe.metadata = {
      gatewayName: updates.metadata.gatewayName,
      fromDockerfile: (typeof updates.metadata.fromDockerfile === "string" ? updates.metadata.fromDockerfile : null),
    };
  }
  return safe;
}

export function updateSession(mutator: (session: Session) => Session | void): Session {
  const current = loadSession() || createSession();
  const next = typeof mutator === "function" ? mutator(current) || current : current;
  return saveSession(next);
}

export function applyStepStarted(session: Session, stepName: OnboardStepName): Session {
  const step = session.steps[stepName];
  if (!step) return session;
  step.status = "in_progress";
  step.startedAt = new Date().toISOString();
  step.completedAt = null;
  step.error = null;
  session.lastStepStarted = stepName;
  session.failure = null;
  session.status = "in_progress";
  synchronizeRuntimeSteps(session);
  return session;
}

export function applyStepComplete(
  session: Session,
  stepName: OnboardStepName,
  updates: SessionUpdates = {},
): Session {
  const step = session.steps[stepName];
  if (!step) return session;
  step.status = "complete";
  step.completedAt = new Date().toISOString();
  step.error = null;
  session.lastCompletedStep = stepName;
  session.failure = null;
  Object.assign(session, filterSafeUpdates(updates));
  synchronizeRuntimeSteps(session);
  return session;
}

export function applyStepSkipped(session: Session, stepName: OnboardStepName): Session {
  const step = session.steps[stepName];
  if (!step) return session;
  if (step.status === "complete" || step.status === "failed") return session;
  step.status = "skipped";
  step.startedAt = null;
  step.completedAt = null;
  step.error = null;
  synchronizeRuntimeSteps(session);
  return session;
}

export function applyStepFailed(
  session: Session,
  stepName: OnboardStepName,
  message: string | null = null,
): Session {
  const step = session.steps[stepName];
  if (!step) return session;
  step.status = "failed";
  step.completedAt = null;
  step.error = redactSensitiveText(message);
  session.failure = sanitizeFailure({
    step: stepName,
    message,
    recordedAt: new Date().toISOString(),
  });
  session.status = "failed";
  synchronizeRuntimeSteps(session);
  return session;
}

export function applySessionComplete(session: Session, updates: SessionUpdates = {}): Session {
  Object.assign(session, filterSafeUpdates(updates));
  session.status = "complete";
  session.resumable = false;
  session.failure = null;
  synchronizeRuntimeSteps(session);
  return session;
}

export function markStepStarted(stepName: OnboardStepName): Session {
  return updateSession((session) => applyStepStarted(session, stepName));
}

export function markStepComplete(stepName: OnboardStepName, updates: SessionUpdates = {}): Session {
  return updateSession((session) => applyStepComplete(session, stepName, updates));
}

export function markStepSkipped(stepName: OnboardStepName): Session {
  return updateSession((session) => applyStepSkipped(session, stepName));
}

export function markStepFailed(stepName: OnboardStepName, message: string | null = null): Session {
  return updateSession((session) => applyStepFailed(session, stepName, message));
}

export function completeSession(updates: SessionUpdates = {}): Session {
  return updateSession((session) => applySessionComplete(session, updates));
}

export function summarizeForDebug(session: Session | null = loadSession()): Record<
  string,
  unknown
> | null {
  if (!session) return null;
  return {
    version: session.version,
    sessionId: session.sessionId,
    status: session.status,
    resumable: session.resumable,
    mode: session.mode,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    sandboxName: session.sandboxName,
    provider: session.provider,
    model: session.model,
    endpointUrl: redactUrl(session.endpointUrl),
    credentialEnv: session.credentialEnv,
    preferredInferenceApi: session.preferredInferenceApi,
    nimContainer: session.nimContainer,
    messagingChannels: session.messagingChannels,
    policyPresets: session.policyPresets,
    lastStepStarted: session.lastStepStarted,
    lastCompletedStep: session.lastCompletedStep,
    failure: session.failure,
    steps: Object.fromEntries(
      Object.entries(session.steps).map(([name, step]) => [
        name,
        {
          status: step.status,
          startedAt: step.startedAt,
          completedAt: step.completedAt,
          error: step.error,
        },
      ]),
    ),
  };
}
