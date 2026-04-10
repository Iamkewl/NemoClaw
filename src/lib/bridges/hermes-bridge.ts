// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Hermes bridge adapter — makes the swarm bus appear as a native messaging
 * platform to Hermes agent instances.
 *
 * Strategy:
 * - Connects via Hermes's OpenAI-compatible chat completions endpoint
 *   (POST /v1/chat/completions on the agent's port).
 * - Injects bus messages as user messages in a dedicated "swarm" session.
 * - Captures Hermes's response and posts it back to the bus.
 * - Polls the bus for messages addressed to this instance (or broadcast).
 *
 * Hermes exposes an OpenAI-compatible API, so we use the standard chat
 * completions format with a system message establishing the swarm context.
 */

import type { SwarmBridgeAdapter, BridgeConfig, SwarmMessage } from "../swarm-bridge";

const DEFAULT_POLL_INTERVAL_MS = 2000;

const SWARM_SYSTEM_PROMPT = [
  "You are participating in a multi-agent swarm.",
  "Messages you receive come from other agents in the same sandbox.",
  'The "swarm" platform is an internal communication channel between agents.',
  "Respond concisely and focus on the task or question from the other agent.",
].join(" ");

export class HermesBridge implements SwarmBridgeAdapter {
  readonly agentType = "hermes";

  private config: BridgeConfig | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeenTimestamp: string = "";
  private messageCallback: ((msg: SwarmMessage) => void) | null = null;
  private running = false;

  // Maintain a conversation history per swarm session so Hermes has context
  private conversationHistory: Array<{ role: string; content: string }> = [];

  async start(config: BridgeConfig): Promise<void> {
    this.config = config;
    this.running = true;
    this.conversationHistory = [{ role: "system", content: SWARM_SYSTEM_PROMPT }];

    const pollInterval = config.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;

    this.pollTimer = setInterval(() => {
      if (this.running) {
        this._pollBus().catch((err) => {
          console.error(`[hermes-bridge:${config.instanceId}] poll error:`, err.message);
        });
      }
    }, pollInterval);

    console.log(`[hermes-bridge:${config.instanceId}] started (poll every ${pollInterval}ms)`);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    console.log(`[hermes-bridge:${this.config?.instanceId}] stopped`);
  }

  async deliverToAgent(message: SwarmMessage): Promise<void> {
    if (!this.config) throw new Error("Bridge not started");

    // Format as a user message with sender context
    const userMsg = `[from: ${message.from}] ${message.content}`;
    this.conversationHistory.push({ role: "user", content: userMsg });

    // Trim conversation to keep it manageable (last 20 messages + system)
    if (this.conversationHistory.length > 21) {
      this.conversationHistory = [
        this.conversationHistory[0], // system prompt
        ...this.conversationHistory.slice(-20),
      ];
    }

    // POST to Hermes's OpenAI-compatible chat completions endpoint
    const url = `http://127.0.0.1:${this.config.agentPort}/v1/chat/completions`;
    const body = JSON.stringify({
      model: "default",
      messages: this.conversationHistory,
      max_tokens: 1024,
    });

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(30000), // Hermes can be slow on first response
      });

      if (resp.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = await resp.json() as any;
        const choice = data.choices?.[0];
        const responseContent = choice?.message?.content as string | undefined;

        if (responseContent && this.messageCallback) {
          // Track the assistant response in conversation history
          this.conversationHistory.push({ role: "assistant", content: responseContent });

          const reply: SwarmMessage = {
            from: this.config.instanceId,
            to: message.from, // reply to sender
            content: responseContent,
            timestamp: new Date().toISOString(),
            platform: "swarm",
          };
          this.messageCallback(reply);
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[hermes-bridge:${this.config.instanceId}] deliver error: ${errMsg}`);
    }
  }

  onAgentMessage(callback: (msg: SwarmMessage) => void): void {
    this.messageCallback = callback;
  }

  /** Poll the bus for new messages addressed to this instance or broadcast. */
  private async _pollBus(): Promise<void> {
    if (!this.config) return;

    const qs = this.lastSeenTimestamp
      ? `?since=${encodeURIComponent(this.lastSeenTimestamp)}`
      : "";
    const url = `${this.config.busUrl}/messages${qs}`;

    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) return;

      const data = await resp.json() as Record<string, unknown>;
      const messages: SwarmMessage[] = (data.messages as SwarmMessage[]) || [];

      for (const msg of messages) {
        // Skip our own messages
        if (msg.from === this.config.instanceId) continue;

        // Accept messages addressed to us or broadcast (to: null)
        if (msg.to !== null && msg.to !== this.config.instanceId) continue;

        this.lastSeenTimestamp = msg.timestamp;
        await this.deliverToAgent(msg);
      }
    } catch {
      // Network errors during polling are expected (sandbox restart, etc.)
    }
  }
}
