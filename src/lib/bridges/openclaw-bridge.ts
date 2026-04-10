// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenClaw bridge adapter — makes the swarm bus appear as a native messaging
 * platform to OpenClaw instances.
 *
 * Strategy:
 * - Sends messages to OpenClaw via its gateway POST /api/message endpoint,
 *   using platform:"swarm" so the agent sees inter-agent messages as a
 *   distinct channel alongside telegram/discord/slack.
 * - Polls the bus for messages addressed to this instance (or broadcast).
 * - Captures OpenClaw's response from the POST reply and forwards it to the bus.
 *
 * This runs as a host-side process that bridges between the bus (inside sandbox)
 * and the OpenClaw gateway (inside sandbox, port-forwarded to host).
 */

import type { SwarmBridgeAdapter, BridgeConfig, SwarmMessage } from "../swarm-bridge";

const DEFAULT_POLL_INTERVAL_MS = 2000;

export class OpenClawBridge implements SwarmBridgeAdapter {
  readonly agentType = "openclaw";

  private config: BridgeConfig | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeenTimestamp: string = "";
  private messageCallback: ((msg: SwarmMessage) => void) | null = null;
  private running = false;

  async start(config: BridgeConfig): Promise<void> {
    this.config = config;
    this.running = true;

    const pollInterval = config.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;

    // Start polling the bus for inbound messages
    this.pollTimer = setInterval(() => {
      if (this.running) {
        this._pollBus().catch((err) => {
          console.error(`[openclaw-bridge:${config.instanceId}] poll error:`, err.message);
        });
      }
    }, pollInterval);

    console.log(`[openclaw-bridge:${config.instanceId}] started (poll every ${pollInterval}ms)`);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    console.log(`[openclaw-bridge:${this.config?.instanceId}] stopped`);
  }

  async deliverToAgent(message: SwarmMessage): Promise<void> {
    if (!this.config) throw new Error("Bridge not started");

    // POST to OpenClaw's gateway message endpoint
    // OpenClaw accepts messages via POST /api/message with platform + sender info
    const url = `http://127.0.0.1:${this.config.agentPort}/api/message`;
    const body = JSON.stringify({
      platform: "swarm",
      sender: message.from,
      content: message.content,
      timestamp: message.timestamp,
    });

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(10000),
      });

      if (resp.ok) {
        // OpenClaw returns its response in the reply body
        const data = await resp.json() as Record<string, unknown>;
        if (data.response && this.messageCallback) {
          const reply: SwarmMessage = {
            from: this.config.instanceId,
            to: message.from, // reply to sender
            content: data.response as string,
            timestamp: new Date().toISOString(),
            platform: "swarm",
          };
          this.messageCallback(reply);
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[openclaw-bridge:${this.config.instanceId}] deliver error: ${errMsg}`);
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
