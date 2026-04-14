// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Manifest-driven sandbox state backup and restore.
//
// Handles the sandbox→host direction for rebuild (reverse of migration-state.ts
// which handles host→sandbox for onboarding). Uses agent manifest state_dirs
// and configPaths to know what to back up, so it works for any agent type.
//
// Credentials are stripped from backups using shared credential-filter.ts.

import { spawnSync } from "child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import * as registry from "./registry.js";
import { loadAgent } from "./agent-defs.js";
import { resolveOpenshell } from "./resolve-openshell.js";
import { captureOpenshellCommand } from "./openshell.js";
import { sanitizeConfigFile, isSensitiveFile } from "./credential-filter.js";

const REBUILD_BACKUPS_DIR = path.join(
  process.env.HOME || "/tmp",
  ".nemoclaw",
  "rebuild-backups",
);

const MANIFEST_VERSION = 1;

// ── Types ──────────────────────────────────────────────────────────

export interface RebuildManifest {
  version: number;
  sandboxName: string;
  timestamp: string;
  agentType: string;
  agentVersion: string | null;
  expectedVersion: string | null;
  stateDirs: string[];
  writableDir: string;
  backupPath: string;
  blueprintDigest: string | null;
  instances?: InstanceBackup[];
}

export interface InstanceBackup {
  instanceId: string;
  agentType: string;
  dataDir: string;
  stateDirs: string[];
  backedUpDirs: string[];
}

export interface BackupResult {
  success: boolean;
  manifest: RebuildManifest;
  backedUpDirs: string[];
  failedDirs: string[];
}

export interface RestoreResult {
  success: boolean;
  restoredDirs: string[];
  failedDirs: string[];
}

// ── Helpers ────────────────────────────────────────────────────────

function getSshConfig(sandboxName: string): string | null {
  const openshellBinary = resolveOpenshell();
  if (!openshellBinary) return null;

  const result = captureOpenshellCommand(
    openshellBinary,
    ["sandbox", "ssh-config", sandboxName],
    { ignoreError: true },
  );
  if (result.status !== 0) return null;
  return result.output;
}

function writeTempSshConfig(sshConfig: string): string {
  const tmpFile = path.join(os.tmpdir(), `nemoclaw-state-${process.pid}-${Date.now()}.conf`);
  writeFileSync(tmpFile, sshConfig, { mode: 0o600 });
  return tmpFile;
}

function sshArgs(configFile: string, sandboxName: string): string[] {
  return [
    "-F", configFile,
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "ConnectTimeout=10",
    "-o", "LogLevel=ERROR",
    `openshell-${sandboxName}`,
  ];
}

function computeBlueprintDigest(): string | null {
  // Look for blueprint.yaml relative to the agent-defs ROOT
  const candidates = [
    path.join(process.env.HOME || "/tmp", ".nemoclaw", "blueprints", "0.1.0", "blueprint.yaml"),
    path.join(__dirname, "..", "..", "nemoclaw-blueprint", "blueprint.yaml"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  }
  return null;
}

/**
 * Walk a local directory and sanitize any JSON config files found.
 * Also removes files that match CREDENTIAL_SENSITIVE_BASENAMES.
 */
function sanitizeBackupDirectory(dirPath: string): void {
  if (!existsSync(dirPath)) return;

  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        if (isSensitiveFile(entry.name)) {
          try { require("node:fs").unlinkSync(fullPath); } catch { /* best effort */ }
        } else if (entry.name.endsWith(".json")) {
          sanitizeConfigFile(fullPath);
        }
      }
    }
  };
  walk(dirPath);
}

// ── Backup ─────────────────────────────────────────────────────────

/**
 * Back up all state directories from a running sandbox.
 * Uses the agent manifest to determine which directories contain state.
 */
export function backupSandboxState(sandboxName: string): BackupResult {
  const sb = registry.getSandbox(sandboxName);
  const agentName = sb?.agent || "openclaw";
  const agent = loadAgent(agentName);
  const writableDir = agent.configPaths.writableDir;
  const stateDirs = agent.stateDirs;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(REBUILD_BACKUPS_DIR, sandboxName, timestamp);
  mkdirSync(backupPath, { recursive: true, mode: 0o700 });

  const manifest: RebuildManifest = {
    version: MANIFEST_VERSION,
    sandboxName,
    timestamp,
    agentType: agentName,
    agentVersion: sb?.agentVersion || null,
    expectedVersion: agent.expectedVersion,
    stateDirs,
    writableDir,
    backupPath,
    blueprintDigest: computeBlueprintDigest(),
  };

  const backedUpDirs: string[] = [];
  const failedDirs: string[] = [];

  if (stateDirs.length === 0) {
    writeManifest(backupPath, manifest);
    return { success: true, manifest, backedUpDirs, failedDirs };
  }

  // SSH+tar single-roundtrip download
  const sshConfig = getSshConfig(sandboxName);
  if (!sshConfig) {
    return { success: false, manifest, backedUpDirs, failedDirs: [...stateDirs] };
  }

  const configFile = writeTempSshConfig(sshConfig);
  try {
    // Build tar command that only includes existing directories
    // First, check which state dirs actually exist in the sandbox
    const existCheckCmd = stateDirs
      .map((d) => `[ -d "${writableDir}/${d}" ] && echo "${d}"`)
      .join("; ");
    const existResult = spawnSync(
      "ssh",
      [...sshArgs(configFile, sandboxName), existCheckCmd],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 },
    );
    const existingDirs = (existResult.stdout || "")
      .trim()
      .split("\n")
      .filter((d) => d.length > 0);

    if (existingDirs.length === 0) {
      writeManifest(backupPath, manifest);
      return { success: true, manifest, backedUpDirs, failedDirs };
    }

    // Download via SSH+tar
    const tarCmd = `tar -cf - -C ${writableDir} ${existingDirs.join(" ")}`;
    const result = spawnSync(
      "ssh",
      [...sshArgs(configFile, sandboxName), tarCmd],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 120000, maxBuffer: 256 * 1024 * 1024 },
    );

    if (result.status === 0 && result.stdout && result.stdout.length > 0) {
      // Extract tar locally
      const extractResult = spawnSync(
        "tar",
        ["-xf", "-", "-C", backupPath],
        { input: result.stdout, stdio: ["pipe", "pipe", "pipe"], timeout: 60000 },
      );
      if (extractResult.status === 0) {
        backedUpDirs.push(...existingDirs);
      } else {
        failedDirs.push(...existingDirs);
      }
    } else {
      failedDirs.push(...existingDirs);
    }
  } finally {
    try { require("node:fs").unlinkSync(configFile); } catch { /* ignore */ }
  }

  // SECURITY: Strip credentials from the local backup
  sanitizeBackupDirectory(backupPath);

  writeManifest(backupPath, manifest);
  manifest.backupPath = backupPath;

  return {
    success: failedDirs.length === 0,
    manifest,
    backedUpDirs,
    failedDirs,
  };
}

// ── Restore ────────────────────────────────────────────────────────

/**
 * Restore state directories into a sandbox from a prior backup.
 */
export function restoreSandboxState(
  sandboxName: string,
  backupPath: string,
): RestoreResult {
  const manifest = readManifest(backupPath);
  if (!manifest) {
    return { success: false, restoredDirs: [], failedDirs: ["manifest"] };
  }

  const writableDir = manifest.writableDir;
  const restoredDirs: string[] = [];
  const failedDirs: string[] = [];

  // Find which backed-up directories actually exist locally
  const localDirs = manifest.stateDirs.filter((d) =>
    existsSync(path.join(backupPath, d)),
  );

  if (localDirs.length === 0) {
    return { success: true, restoredDirs, failedDirs };
  }

  const sshConfig = getSshConfig(sandboxName);
  if (!sshConfig) {
    return { success: false, restoredDirs, failedDirs: [...localDirs] };
  }

  const configFile = writeTempSshConfig(sshConfig);
  try {
    // Upload via tar pipe
    const tarResult = spawnSync(
      "tar",
      ["-cf", "-", "-C", backupPath, ...localDirs],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 60000, maxBuffer: 256 * 1024 * 1024 },
    );

    if (tarResult.status !== 0 || !tarResult.stdout) {
      return { success: false, restoredDirs, failedDirs: [...localDirs] };
    }

    const extractCmd = `tar -xf - -C ${writableDir}`;
    const sshResult = spawnSync(
      "ssh",
      [...sshArgs(configFile, sandboxName), extractCmd],
      { input: tarResult.stdout, stdio: ["pipe", "pipe", "pipe"], timeout: 120000 },
    );

    if (sshResult.status === 0) {
      restoredDirs.push(...localDirs);

      // Fix ownership
      const openshellBinary = resolveOpenshell();
      if (openshellBinary) {
        spawnSync(openshellBinary, [
          "sandbox", "exec", sandboxName, "--",
          "chown", "-R", "sandbox:sandbox", writableDir,
        ], { stdio: "ignore", timeout: 30000 });
      }
    } else {
      failedDirs.push(...localDirs);
    }
  } finally {
    try { require("node:fs").unlinkSync(configFile); } catch { /* ignore */ }
  }

  return {
    success: failedDirs.length === 0,
    restoredDirs,
    failedDirs,
  };
}

// ── Manifest ───────────────────────────────────────────────────────

function writeManifest(backupPath: string, manifest: RebuildManifest): void {
  const manifestPath = path.join(backupPath, "rebuild-manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  chmodSync(manifestPath, 0o600);
}

function readManifest(backupPath: string): RebuildManifest | null {
  const manifestPath = path.join(backupPath, "rebuild-manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf-8")) as RebuildManifest;
  } catch {
    return null;
  }
}

// ── Listing ────────────────────────────────────────────────────────

/**
 * List available backups for a sandbox, newest first.
 */
export function listBackups(sandboxName: string): RebuildManifest[] {
  const dir = path.join(REBUILD_BACKUPS_DIR, sandboxName);
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .sort((a, b) => b.name.localeCompare(a.name));

  const manifests: RebuildManifest[] = [];
  for (const entry of entries) {
    const m = readManifest(path.join(dir, entry.name));
    if (m) manifests.push(m);
  }
  return manifests;
}

/**
 * Get the most recent backup for a sandbox, or null.
 */
export function getLatestBackup(sandboxName: string): RebuildManifest | null {
  const backups = listBackups(sandboxName);
  return backups[0] || null;
}
