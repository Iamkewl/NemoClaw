// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Central port configuration — override any port via environment variables.
 * TypeScript counterpart of bin/lib/ports.js.
 */

/**
 * Read an environment variable as a port number, falling back to a default.
 * Validates that the value is a valid non-privileged port (1024-65535).
 */
export function parsePort(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (raw === undefined || raw === "") return fallback;
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid port: ${envVar}="${raw}" — must be an integer between 1024 and 65535`,
    );
  }
  const parsed = Number(trimmed);
  if (parsed < 1024 || parsed > 65535) {
    throw new Error(
      `Invalid port: ${envVar}="${raw}" — must be an integer between 1024 and 65535`,
    );
  }
  return parsed;
}

/** OpenShell gateway port (default 8080, override via NEMOCLAW_GATEWAY_PORT). */
export const GATEWAY_PORT = parsePort("NEMOCLAW_GATEWAY_PORT", 8080);
/**
 * The default port the OpenClaw dashboard listens on inside the sandbox.
 * The sandbox image is built with CHAT_UI_URL=http://127.0.0.1:SANDBOX_DASHBOARD_PORT
 * (patched by patchStagedDockerfile), so the gateway starts on whichever port was
 * configured via NEMOCLAW_DASHBOARD_PORT at onboard time. This constant represents
 * the hardcoded default when no override is set.
 */
const SANDBOX_DASHBOARD_PORT = 18789;
/** Dashboard UI port (default SANDBOX_DASHBOARD_PORT, override via NEMOCLAW_DASHBOARD_PORT). This is the host-side port. */
export const DASHBOARD_PORT = parsePort("NEMOCLAW_DASHBOARD_PORT", SANDBOX_DASHBOARD_PORT);
/** vLLM / NIM inference port (default 8000, override via NEMOCLAW_VLLM_PORT). */
export const VLLM_PORT = parsePort("NEMOCLAW_VLLM_PORT", 8000);
/** Ollama inference port (default 11434, override via NEMOCLAW_OLLAMA_PORT). */
export const OLLAMA_PORT = parsePort("NEMOCLAW_OLLAMA_PORT", 11434);
/** Ollama auth proxy port (default 11435, override via NEMOCLAW_OLLAMA_PROXY_PORT). */
export const OLLAMA_PROXY_PORT = parsePort("NEMOCLAW_OLLAMA_PROXY_PORT", 11435);

/**
 * Injectable probes so tests can drive `findFreeDashboardPort` without touching
 * real openshell or real sockets.
 */
export interface PortProbe {
  listForwardPorts: () => number[];
  probePortFree: (port: number) => boolean;
}

/**
 * Try up to 10 ports starting at the preferred port before giving up.
 * Anything beyond that and the operator has bigger problems; fail loudly.
 */
const PORT_WINDOW = 10;

/**
 * Find a free dashboard port, preferring `preferred` and walking upward.
 * Skips ports already claimed by openshell forwards and ports bound by
 * other host processes. Returns null if the 10-port window is exhausted.
 */
export function findFreeDashboardPort(
  preferred: number,
  options: { probe?: PortProbe } = {},
): number | null {
  const probe = options.probe;
  const held = new Set(probe?.listForwardPorts() ?? []);
  const isFree = probe?.probePortFree ?? (() => true);
  for (let offset = 0; offset < PORT_WINDOW; offset++) {
    const port = preferred + offset;
    if (!held.has(port) && isFree(port)) return port;
  }
  return null;
}
