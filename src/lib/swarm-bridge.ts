// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Swarm bridge adapter interface — the stable contract between agent types
 * and the swarm bus.
 *
 * Each agent type implements this interface so bus messages appear as native
 * platform messages from the agent's perspective. The bus never leaks into
 * the agent's protocol — the bridge translates everything.
 */

/** A message on the swarm bus. */
export interface SwarmMessage {
  /** instanceId of the sender (e.g., "openclaw-0"). */
  from: string;
  /** instanceId of the recipient, or null for broadcast. */
  to: string | null;
  /** Message content (plain text). */
  content: string;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Always "swarm" — distinguishes bus messages from external platforms. */
  platform: "swarm";
}

/**
 * Configuration passed to a bridge adapter at start time.
 */
export interface BridgeConfig {
  /** The agent instance this bridge serves. */
  instanceId: string;
  /** Agent type (e.g., "openclaw", "hermes"). */
  agentType: string;
  /** The agent's local HTTP port inside the sandbox. */
  agentPort: number;
  /** The swarm bus base URL (e.g., "http://127.0.0.1:19100"). */
  busUrl: string;
  /** Poll interval in milliseconds for bus message polling. */
  pollIntervalMs?: number;
}

/**
 * Bridge adapter interface. Each agent type provides an implementation
 * that translates between the agent's native messaging API and the bus.
 */
export interface SwarmBridgeAdapter {
  /** Agent type this bridge supports (e.g., "openclaw", "hermes"). */
  readonly agentType: string;

  /**
   * Start the bridge — connect to the agent and begin relaying messages.
   * The bridge should:
   * 1. Register itself with the agent as a messaging platform
   * 2. Start polling the bus for inbound messages
   * 3. Forward agent responses back to the bus
   */
  start(config: BridgeConfig): Promise<void>;

  /** Stop the bridge — clean up connections and polling. */
  stop(): Promise<void>;

  /**
   * Deliver a message from the bus to this bridge's agent.
   * Called by the bus relay when a message is addressed to this agent.
   */
  deliverToAgent(message: SwarmMessage): Promise<void>;

  /**
   * Register a callback for when the agent produces a response.
   * The callback should post the message to the bus.
   */
  onAgentMessage(callback: (msg: SwarmMessage) => void): void;
}

/**
 * Helpers for interacting with the swarm bus HTTP API from inside the sandbox.
 */

/** Build a curl command to send a message to the bus. */
export function buildBusSendCommand(busPort: number, msg: { from: string; to?: string | null; content: string }): string {
  const payload = JSON.stringify({ from: msg.from, to: msg.to || null, content: msg.content });
  return `curl -sf -X POST http://127.0.0.1:${busPort}/send -H 'Content-Type: application/json' -d '${payload.replace(/'/g, "'\\''")}'`;
}

/** Build a curl command to poll messages from the bus. */
export function buildBusPollCommand(busPort: number, since?: string): string {
  const qs = since ? `?since=${encodeURIComponent(since)}` : "";
  return `curl -sf http://127.0.0.1:${busPort}/messages${qs}`;
}

/** Build a curl command to check bus health. */
export function buildBusHealthCommand(busPort: number): string {
  return `curl -sf http://127.0.0.1:${busPort}/health`;
}

/** Build a curl command to get agent health status from the bus. */
export function buildBusAgentsCommand(busPort: number): string {
  return `curl -sf http://127.0.0.1:${busPort}/agents`;
}
