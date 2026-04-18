// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROXY_STATE_DIR = path.join(os.homedir(), ".nemoclaw");
const PROXY_TOKEN_PATH = path.join(PROXY_STATE_DIR, "ollama-proxy-token");
const PROXY_PID_PATH = path.join(PROXY_STATE_DIR, "ollama-auth-proxy.pid");

let ollamaProxyToken: string | null = null;

export interface OllamaProxyDeps {
  runCapture: (command: string | string[], opts?: { ignoreError?: boolean }) => string;
  run: (
    command: string | string[],
    opts?: { ignoreError?: boolean; suppressOutput?: boolean },
  ) => { status: number; stdout?: string; stderr?: string };
  spawn: typeof import("node:child_process").spawn;
  sleep: (seconds: number) => void;
  scriptsDir: string;
  ollamaProxyPort: number;
  ollamaPort: number;
}

function ensureProxyStateDir(): void {
  if (!fs.existsSync(PROXY_STATE_DIR)) {
    fs.mkdirSync(PROXY_STATE_DIR, { recursive: true });
  }
}

export function persistProxyToken(token: string): void {
  ensureProxyStateDir();
  fs.writeFileSync(PROXY_TOKEN_PATH, token, { mode: 0o600 });
  // mode only applies on creation; ensure permissions on existing files too
  fs.chmodSync(PROXY_TOKEN_PATH, 0o600);
}

function loadPersistedProxyToken(): string | null {
  try {
    if (fs.existsSync(PROXY_TOKEN_PATH)) {
      const token = fs.readFileSync(PROXY_TOKEN_PATH, "utf-8").trim();
      return token || null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function persistProxyPid(pid: number | null | undefined): void {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return;
  const resolvedPid = pid;
  ensureProxyStateDir();
  fs.writeFileSync(PROXY_PID_PATH, `${resolvedPid}\n`, { mode: 0o600 });
  fs.chmodSync(PROXY_PID_PATH, 0o600);
}

function loadPersistedProxyPid(): number | null {
  try {
    if (!fs.existsSync(PROXY_PID_PATH)) return null;
    const raw = fs.readFileSync(PROXY_PID_PATH, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function clearPersistedProxyPid(): void {
  try {
    if (fs.existsSync(PROXY_PID_PATH)) {
      fs.unlinkSync(PROXY_PID_PATH);
    }
  } catch {
    /* ignore */
  }
}

function isOllamaProxyProcess(pid: number | null | undefined, deps: OllamaProxyDeps): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  const resolvedPid = pid;
  const cmdline = deps.runCapture(["ps", "-p", String(resolvedPid), "-o", "args="], {
    ignoreError: true,
  });
  return Boolean(cmdline && cmdline.includes("ollama-auth-proxy.js"));
}

function spawnOllamaAuthProxy(token: string, deps: OllamaProxyDeps): number | null {
  const child = deps.spawn(process.execPath, [path.join(deps.scriptsDir, "ollama-auth-proxy.js")], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      OLLAMA_PROXY_TOKEN: token,
      OLLAMA_PROXY_PORT: String(deps.ollamaProxyPort),
      OLLAMA_BACKEND_PORT: String(deps.ollamaPort),
    },
  });
  child.unref();
  persistProxyPid(child.pid);
  return child.pid ?? null;
}

function killStaleProxy(deps: OllamaProxyDeps): void {
  try {
    const persistedPid = loadPersistedProxyPid();
    if (isOllamaProxyProcess(persistedPid, deps)) {
      deps.run(["kill", String(persistedPid)], { ignoreError: true, suppressOutput: true });
    }
    clearPersistedProxyPid();

    // Best-effort cleanup for older proxy processes created before the PID file
    // existed. Only kill processes that are actually the auth proxy, not
    // unrelated services that happen to use the same port.
    const pidOutput = deps.runCapture(["lsof", "-ti", `:${deps.ollamaProxyPort}`], {
      ignoreError: true,
    });
    if (pidOutput && pidOutput.trim()) {
      for (const pid of pidOutput.trim().split(/\s+/)) {
        if (isOllamaProxyProcess(Number.parseInt(pid, 10), deps)) {
          deps.run(["kill", pid], { ignoreError: true, suppressOutput: true });
        }
      }
      deps.sleep(1);
    }
  } catch {
    /* ignore */
  }
}

export function startOllamaAuthProxy(deps: OllamaProxyDeps): void {
  const crypto = require("crypto");
  killStaleProxy(deps);

  ollamaProxyToken = crypto.randomBytes(24).toString("hex");
  // Don't persist yet — wait until provider is confirmed in setupInference.
  // If the user backs out to a different provider, the token stays in memory
  // only and is discarded.
  const pid = spawnOllamaAuthProxy(ollamaProxyToken as string, deps);
  deps.sleep(1);
  if (!isOllamaProxyProcess(pid, deps)) {
    console.error(`  Warning: Ollama auth proxy did not start on :${deps.ollamaProxyPort}`);
  }
}

/**
 * Ensure the auth proxy is running — called on sandbox connect to recover
 * from host reboots where the background proxy process was lost.
 */
export function ensureOllamaAuthProxy(deps: OllamaProxyDeps): void {
  // Try to load persisted token first — if none, this isn't an Ollama setup.
  const token = loadPersistedProxyToken();
  if (!token) return;

  const pid = loadPersistedProxyPid();
  if (isOllamaProxyProcess(pid, deps)) {
    ollamaProxyToken = token;
    return;
  }

  // Proxy not running — restart it with the persisted token.
  killStaleProxy(deps);
  ollamaProxyToken = token;
  spawnOllamaAuthProxy(token, deps);
  deps.sleep(1);
}

export function getOllamaProxyToken(): string | null {
  if (ollamaProxyToken) return ollamaProxyToken;
  // Fall back to persisted token (resume / reconnect scenario)
  ollamaProxyToken = loadPersistedProxyToken();
  return ollamaProxyToken;
}
