// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Add an agent instance to a running sandbox.
 *
 * Orchestrates the full lifecycle: binary check, port allocation, config
 * directory setup, config generation, messaging providers, policy merge,
 * agent process launch, port forward, and health probe.
 */

import type { AgentInstance } from "./registry";
import type { MessagingTokens } from "./swarm-config";

const fs = require("fs");
const { run, runCapture, shellQuote } = require("./runner");
const registry = require("./registry");
const { loadAgent, listAgents } = require("./agent-defs");
const { allocatePort, usedPortsFromInstances, SWARM_BUS_PORT } = require("./swarm-ports");
const { buildInstanceSetupScript } = require("./swarm-config");
const {
  toManifestAgent,
  createManifest,
  buildWriteManifestScript,
  buildReadManifestCommand,
  parseManifest,
  SWARM_MANIFEST_PATH,
} = require("./swarm-manifest");
const { createInstanceMessagingProviders, parseMessagingFlags } = require("./swarm-messaging");
const { mergeAgentPolicyAdditions } = require("./policies");

export interface AddAgentOptions {
  sandboxName: string;
  agentType?: string;
  messagingTokens?: MessagingTokens;
  args?: string[];
}

function getOpenshellCommand(): string {
  const binary = process.env.NEMOCLAW_OPENSHELL_BIN;
  if (!binary) return "openshell";
  return shellQuote(binary);
}

/**
 * Execute a command inside the sandbox. Multi-line scripts are base64-encoded
 * to avoid the "command argument contains newline" gRPC error from openshell.
 */
function sandboxExec(sandboxName: string, cmd: string, opts: Record<string, unknown> = {}): unknown {
  const openshell = getOpenshellCommand();
  const encoded = Buffer.from(cmd).toString("base64");
  return run(
    `${openshell} sandbox exec ${shellQuote(sandboxName)} bash -c ${shellQuote(`echo ${encoded} | base64 -d | bash`)}`,
    { ignoreError: true, ...opts },
  );
}

function sandboxExecCapture(sandboxName: string, cmd: string): string {
  const openshell = getOpenshellCommand();
  const encoded = Buffer.from(cmd).toString("base64");
  return runCapture(
    `${openshell} sandbox exec ${shellQuote(sandboxName)} bash -c ${shellQuote(`echo ${encoded} | base64 -d | bash`)}`,
    { ignoreError: true },
  );
}

export async function addAgent(opts: AddAgentOptions): Promise<AgentInstance | null> {
  const { sandboxName, args = [] } = opts;
  let agentType: string | undefined = opts.agentType;
  let { messagingTokens } = opts;

  // Parse messaging tokens from CLI args if not provided directly
  if (!messagingTokens) {
    messagingTokens = parseMessagingFlags(args);
  }

  // ── Step 1: Validate sandbox ───────────────────────────────────
  const sandbox = registry.getSandbox(sandboxName);
  if (!sandbox) {
    console.error(`\n  Sandbox '${sandboxName}' not found in registry.`);
    return null;
  }

  // Default agent type to the sandbox's primary agent
  if (!agentType) {
    agentType = sandbox.agent || "openclaw";
  }
  // agentType is now guaranteed to be a string
  // (TypeScript can't narrow through reassignment in the if block above)

  // ── Step 2: Load agent manifest ────────────────────────────────
  const available = listAgents();
  if (!available.includes(agentType)) {
    console.error(`\n  Unknown agent type: '${agentType}'`);
    console.error(`  Available: ${available.join(", ")}`);
    return null;
  }
  const agentDef = loadAgent(agentType);

  // ── Step 3: Verify binary in sandbox ───────────────────────────
  // If adding the same agent type that the sandbox was onboarded with, skip
  // the check — the binary is already running the gateway. The exec PATH
  // inside the sandbox may not match the entrypoint PATH (npm global prefix,
  // nvm shims, etc.), so probing from outside is unreliable for the primary
  // agent type. Only check for a DIFFERENT agent type.
  const primaryAgentType = sandbox.agent || "openclaw";
  if (agentType !== primaryAgentType) {
    const binaryName = agentType;
    const binaryCheck = sandboxExecCapture(sandboxName, `command -v ${binaryName} 2>/dev/null && echo found`);
    if (!binaryCheck || !binaryCheck.includes("found")) {
      console.error(`\n  ${agentDef.displayName} binary not found in sandbox '${sandboxName}'.`);
      console.error(`  The sandbox image does not contain '${binaryName}' on PATH.`);
      console.error(`  To use ${agentDef.displayName}, rebuild with a multi-agent image.`);
      return null;
    }
  }

  // ── Step 4: Bootstrap swarm manifest ────────────────────────────
  // Must happen BEFORE port allocation so nextInstanceIndex sees instance-0.
  const rawManifest = sandboxExecCapture(sandboxName, buildReadManifestCommand());
  let manifest = parseManifest(rawManifest);
  if (!manifest) {
    // Retroactively register the primary agent
    const primaryAgent = sandbox.agent || "openclaw";
    const primaryDef = loadAgent(primaryAgent);
    const primaryPort = primaryDef.healthProbe?.port || primaryDef.forwardPort || 18789;
    const primaryHealthUrl = (primaryDef.healthProbe?.url || `http://localhost:${primaryPort}/`);
    const primaryInstance: AgentInstance = {
      instanceId: `${primaryAgent}-0`,
      agentType: primaryAgent,
      port: primaryPort,
      configDir: primaryDef.configPaths.immutableDir,
      dataDir: primaryDef.configPaths.writableDir,
      addedAt: sandbox.createdAt || new Date().toISOString(),
      primary: true,
    };
    const manifestAgent = toManifestAgent(primaryInstance, primaryHealthUrl);
    manifest = createManifest(manifestAgent, SWARM_BUS_PORT);

    // Write manifest into sandbox
    const writeScript = buildWriteManifestScript(manifest);
    sandboxExec(sandboxName, writeScript);

    // Register instance-0 in host registry
    registry.addAgentInstance(sandboxName, primaryInstance);

    console.log(`  Bootstrapped swarm manifest (registered ${primaryAgent}-0 as primary)`);
  }

  // ── Step 5: Allocate port and compute instance ID ──────────────
  const instanceIndex = registry.nextInstanceIndex(sandboxName, agentType);
  const instanceId = `${agentType}-${instanceIndex}`;
  const existingInstances = registry.getAgentInstances(sandboxName);
  const usedPorts = usedPortsFromInstances(existingInstances);
  const basePort = agentDef.healthProbe?.port || agentDef.forwardPort || 18789;
  const port = allocatePort(basePort, instanceIndex, usedPorts);

  console.log(`\n  Adding ${agentDef.displayName} instance: ${instanceId} on port ${port}`);

  // ── Step 6: Create config/data directories ─────────────────────
  const configDir = instanceIndex === 0 && agentType === (sandbox.agent || "openclaw")
    ? agentDef.configPaths.immutableDir
    : `/sandbox/.${agentType}-${instanceIndex}`;
  const dataDir = instanceIndex === 0 && agentType === (sandbox.agent || "openclaw")
    ? agentDef.configPaths.writableDir
    : `/sandbox/.${agentType}-${instanceIndex}-data`;

  // ── Step 7: Generate and deploy config ─────────────────────────
  // Read the sandbox's inference endpoint from the nemoclaw config
  const inferenceEndpoint = "https://inference.local/v1";
  const model = sandbox.model || "nvidia/nemotron-3-super-120b-a12b";

  const { setupScript } = buildInstanceSetupScript({
    instanceId,
    agentDef,
    configDir,
    dataDir,
    port,
    inferenceEndpoint,
    model,
    messagingTokens,
  });

  const setupResult = sandboxExec(sandboxName, setupScript);
  if (setupResult && (setupResult as { status?: number }).status !== 0) {
    console.error(`\n  Failed to set up config directories for ${instanceId}`);
    return null;
  }
  console.log(`  Config deployed to ${configDir}`);

  // ── Step 8: Messaging providers ────────────────────────────────
  let messagingProviders: string[] = [];
  let messagingChannels: string[] = [];
  if (messagingTokens && Object.values(messagingTokens).some(Boolean)) {
    const result = createInstanceMessagingProviders(sandboxName, instanceId, messagingTokens);
    messagingProviders = result.providers;
    messagingChannels = result.channels;
    if (messagingChannels.length > 0) {
      console.log(`  Messaging: ${messagingChannels.join(", ")}`);
    }
  }

  // ── Step 9: Merge agent-specific policy additions ──────────────
  mergeAgentPolicyAdditions(sandboxName, agentDef);

  // ── Step 10: Start support processes (Hermes-specific) ─────────
  if (agentType === "hermes") {
    // Hermes needs a decode proxy and socat for port binding
    const decodeProxyPort = 3129 + instanceIndex;
    // Start decode proxy if available in the image
    sandboxExec(sandboxName, [
      `if [ -f /usr/local/lib/nemoclaw/decode-proxy.py ]; then`,
      `  nohup python3 /usr/local/lib/nemoclaw/decode-proxy.py ${decodeProxyPort} > /tmp/decode-proxy-${instanceId}.log 2>&1 &`,
      `fi`,
    ].join("\n"));
  }

  // ── Step 11: Launch agent process ──────────────────────────────
  const gatewayCmd = agentDef.gateway_command || `${agentType} gateway run`;
  // Build launch command with port and config overrides
  let launchCmd: string;
  if (agentType === "openclaw") {
    launchCmd = `cd ${configDir} && nohup ${gatewayCmd} --port ${port} > /tmp/${instanceId}.log 2>&1 &`;
  } else if (agentType === "hermes") {
    const decodeProxyPort = 3129 + instanceIndex;
    launchCmd = [
      `export HERMES_HOME=${configDir}`,
      `export HERMES_DATA=${dataDir}`,
      `export API_SERVER_PORT=${port}`,
      `export HTTP_PROXY=http://localhost:${decodeProxyPort}`,
      `export HTTPS_PROXY=http://localhost:${decodeProxyPort}`,
      `nohup ${gatewayCmd} > /tmp/${instanceId}.log 2>&1 &`,
    ].join(" && ");
  } else {
    launchCmd = `nohup ${gatewayCmd} --port ${port} --config ${configDir}/config.json > /tmp/${instanceId}.log 2>&1 &`;
  }

  sandboxExec(sandboxName, launchCmd);
  console.log(`  Launched ${instanceId}`);

  // ── Step 12: Port forward ──────────────────────────────────────
  const openshell = getOpenshellCommand();
  run(
    `${openshell} forward start --background ${port} ${shellQuote(sandboxName)}`,
    { ignoreError: true, stdio: ["ignore", "ignore", "ignore"] },
  );
  console.log(`  Port forward: localhost:${port} → sandbox`);

  // ── Step 13: Health probe ──────────────────────────────────────
  const healthUrl = agentDef.healthProbe?.url
    ? agentDef.healthProbe.url.replace(`:${basePort}`, `:${port}`)
    : `http://localhost:${port}/`;
  const timeout = agentDef.healthProbe?.timeout_seconds || 30;
  const maxAttempts = Math.ceil(timeout / 3);

  let healthy = false;
  for (let i = 0; i < maxAttempts; i++) {
    const probe = sandboxExecCapture(
      sandboxName,
      `curl -sf ${healthUrl} 2>/dev/null | head -c 100`,
    );
    if (probe && probe.trim()) {
      healthy = true;
      break;
    }
    // Sleep 3s between attempts
    sandboxExec(sandboxName, "sleep 3", { suppressOutput: true });
  }

  if (healthy) {
    console.log(`  Health probe passed: ${healthUrl}`);
  } else {
    console.log(`  Warning: health probe timed out after ${timeout}s (agent may still be starting)`);
  }

  // ── Step 14: Update swarm manifest ─────────────────────────────
  const instance: AgentInstance = {
    instanceId,
    agentType: agentType!,
    port,
    configDir,
    dataDir,
    addedAt: new Date().toISOString(),
    primary: false,
    forwardPort: port,
    messagingProviders: messagingProviders.length > 0 ? messagingProviders : undefined,
    messagingChannels: messagingChannels.length > 0 ? messagingChannels : undefined,
  };

  const newManifestAgent = toManifestAgent(instance, healthUrl);
  manifest.agents.push(newManifestAgent);
  const writeScript = buildWriteManifestScript(manifest);
  sandboxExec(sandboxName, writeScript);

  // ── Step 15: Update host registry ──────────────────────────────
  registry.addAgentInstance(sandboxName, instance);

  // ── Step 16: Print summary ─────────────────────────────────────
  console.log("");
  console.log(`  ✓ Added ${agentDef.displayName} instance: ${instanceId}`);
  console.log(`    Port: ${port}`);
  console.log(`    Web UI: http://localhost:${port}`);
  if (messagingChannels.length > 0) {
    console.log(`    Messaging: ${messagingChannels.join(", ")}`);
  }
  console.log(`    Health: ${healthy ? "passing" : "pending"}`);
  console.log("");

  return instance;
}
