// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Agent-specific runtime logic — called from nemoclaw.js when the active
// sandbox uses a non-OpenClaw agent. Reads the agent from the onboard session
// and provides agent-aware health probes, recovery scripts, and display names.
// When the session agent is openclaw (or absent), all functions return
// defaults that match the hardcoded OpenClaw values on main.

const registry = require("./registry");
const onboardSession = require("./onboard-session");
const { loadAgent } = require("./agent-defs");

/**
 * Resolve the agent for a sandbox. Checks the per-sandbox registry first
 * (so status/connect/recovery use the right agent even when multiple
 * sandboxes exist), then falls back to the global onboard session.
 * Returns the loaded agent definition for non-OpenClaw agents, or null.
 *
 * @param {string} [sandboxName] - sandbox to look up (omit for session fallback)
 */
function getSessionAgent(sandboxName) {
  try {
    // Per-sandbox registry (preferred — survives across multiple onboards)
    if (sandboxName) {
      const sb = registry.getSandbox(sandboxName);
      if (sb?.agent && sb.agent !== "openclaw") {
        return loadAgent(sb.agent);
      }
      if (sb?.agent === "openclaw" || (sb && !sb.agent)) {
        return null;
      }
    }
    // Fallback: global onboard session (for sandboxes created before this change)
    const session = onboardSession.loadSession();
    const name = session?.agent || "openclaw";
    if (name === "openclaw") return null;
    return loadAgent(name);
  } catch {
    return null;
  }
}

/**
 * Get the health probe URL for the agent.
 * Returns the agent's configured probe URL, or the OpenClaw default.
 */
function getHealthProbeUrl(agent) {
  if (!agent) return "http://127.0.0.1:18789/";
  return agent.healthProbe?.url || "http://127.0.0.1:18789/";
}

/**
 * Build the recovery shell script for a non-OpenClaw agent.
 * Returns the script string, or null if agent is null (use existing inline
 * OpenClaw script instead).
 */
function buildRecoveryScript(agent) {
  if (!agent) return null;

  const probeUrl = getHealthProbeUrl(agent);
  const binaryPath = agent.binary_path || "/usr/local/bin/openclaw";
  const gatewayCmd = agent.gateway_command || "openclaw gateway run";
  const isHermes = agent.name === "hermes";
  const hermesHome = isHermes ? "export HERMES_HOME=/sandbox/.hermes-data; " : "";

  return [
    "[ -f ~/.bashrc ] && . ~/.bashrc 2>/dev/null;",
    hermesHome,
    `if curl -sf --max-time 3 ${probeUrl} > /dev/null 2>&1; then echo ALREADY_RUNNING; exit 0; fi;`,
    "rm -f /tmp/gateway.log;",
    "touch /tmp/gateway.log; chmod 600 /tmp/gateway.log;",
    `AGENT_BIN="$(command -v ${binaryPath.split("/").pop()})";`,
    'if [ -z "$AGENT_BIN" ]; then echo AGENT_MISSING; exit 1; fi;',
    `nohup ${gatewayCmd} > /tmp/gateway.log 2>&1 &`,
    "GPID=$!; sleep 2;",
    'if kill -0 "$GPID" 2>/dev/null; then echo "GATEWAY_PID=$GPID"; else echo GATEWAY_FAILED; cat /tmp/gateway.log 2>/dev/null | tail -5; fi',
  ].join(" ");
}

/**
 * Get the display name for the current agent.
 */
function getAgentDisplayName(agent) {
  return agent ? agent.displayName : "OpenClaw";
}

/**
 * Get the gateway command for the current agent.
 */
function getGatewayCommand(agent) {
  return agent ? agent.gateway_command || "openclaw gateway run" : "openclaw gateway run";
}

module.exports = {
  getSessionAgent,
  getHealthProbeUrl,
  buildRecoveryScript,
  getAgentDisplayName,
  getGatewayCommand,
};
