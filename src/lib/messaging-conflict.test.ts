// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "./registry";
import {
  backfillMessagingChannels,
  findAllOverlaps,
  findChannelConflicts,
} from "./messaging-conflict";

function makeRegistry(sandboxes: SandboxEntry[]) {
  const store = new Map(sandboxes.map((s) => [s.name, { ...s }]));
  return {
    listSandboxes: () => ({
      sandboxes: Array.from(store.values()),
      defaultSandbox: sandboxes[0]?.name ?? null,
    }),
    updateSandbox: vi.fn((name: string, updates: Partial<SandboxEntry>) => {
      const entry = store.get(name);
      if (!entry) return false;
      Object.assign(entry, updates);
      return true;
    }),
  };
}

describe("findChannelConflicts", () => {
  it("returns conflicts when another sandbox already has the channel", () => {
    const registry = makeRegistry([
      { name: "alice", messagingChannels: ["telegram"] },
      { name: "bob", messagingChannels: [] },
    ]);
    expect(findChannelConflicts("bob", ["telegram"], registry)).toEqual([
      { channel: "telegram", sandbox: "alice" },
    ]);
  });

  it("excludes the current sandbox from its own conflicts", () => {
    const registry = makeRegistry([{ name: "alice", messagingChannels: ["telegram"] }]);
    expect(findChannelConflicts("alice", ["telegram"], registry)).toEqual([]);
  });

  it("skips entries with no messagingChannels field (pre-backfill)", () => {
    const registry = makeRegistry([{ name: "alice" }, { name: "bob", messagingChannels: [] }]);
    expect(findChannelConflicts("bob", ["telegram"], registry)).toEqual([]);
  });

  it("returns empty when no channels are enabled", () => {
    const registry = makeRegistry([{ name: "alice", messagingChannels: ["telegram"] }]);
    expect(findChannelConflicts("bob", [], registry)).toEqual([]);
  });
});

describe("findAllOverlaps", () => {
  it("reports each overlapping pair once", () => {
    const registry = makeRegistry([
      { name: "alice", messagingChannels: ["telegram"] },
      { name: "bob", messagingChannels: ["telegram"] },
      { name: "carol", messagingChannels: ["discord"] },
    ]);
    expect(findAllOverlaps(registry)).toEqual([
      { channel: "telegram", sandboxes: ["alice", "bob"] },
    ]);
  });

  it("reports all pairs when three sandboxes share a channel", () => {
    const registry = makeRegistry([
      { name: "a", messagingChannels: ["telegram"] },
      { name: "b", messagingChannels: ["telegram"] },
      { name: "c", messagingChannels: ["telegram"] },
    ]);
    expect(findAllOverlaps(registry)).toEqual([
      { channel: "telegram", sandboxes: ["a", "b"] },
      { channel: "telegram", sandboxes: ["a", "c"] },
      { channel: "telegram", sandboxes: ["b", "c"] },
    ]);
  });

  it("returns empty when channels do not overlap", () => {
    const registry = makeRegistry([
      { name: "alice", messagingChannels: ["telegram"] },
      { name: "bob", messagingChannels: ["discord"] },
    ]);
    expect(findAllOverlaps(registry)).toEqual([]);
  });
});

describe("backfillMessagingChannels", () => {
  it("fills in missing messagingChannels by probing OpenShell", () => {
    const registry = makeRegistry([{ name: "alice" }]);
    const probe = {
      providerExists: vi.fn((name: string) => name === "alice-telegram-bridge"),
    };
    backfillMessagingChannels(registry, probe);
    expect(registry.updateSandbox).toHaveBeenCalledWith("alice", {
      messagingChannels: ["telegram"],
    });
    expect(probe.providerExists).toHaveBeenCalledWith("alice-telegram-bridge");
    expect(probe.providerExists).toHaveBeenCalledWith("alice-discord-bridge");
    expect(probe.providerExists).toHaveBeenCalledWith("alice-slack-bridge");
  });

  it("leaves entries with existing messagingChannels alone", () => {
    const registry = makeRegistry([
      { name: "alice", messagingChannels: ["telegram"] },
    ]);
    const probe = { providerExists: vi.fn(() => true) };
    backfillMessagingChannels(registry, probe);
    expect(registry.updateSandbox).not.toHaveBeenCalled();
    expect(probe.providerExists).not.toHaveBeenCalled();
  });

  it("writes an empty array when no providers exist for a sandbox", () => {
    const registry = makeRegistry([{ name: "alice" }]);
    const probe = { providerExists: vi.fn(() => false) };
    backfillMessagingChannels(registry, probe);
    expect(registry.updateSandbox).toHaveBeenCalledWith("alice", { messagingChannels: [] });
  });

  it("swallows probe errors for individual channels and keeps going", () => {
    const registry = makeRegistry([{ name: "alice" }]);
    const probe = {
      providerExists: vi.fn((name: string) => {
        if (name.endsWith("-telegram-bridge")) throw new Error("gateway down");
        return name.endsWith("-discord-bridge");
      }),
    };
    backfillMessagingChannels(registry, probe);
    expect(registry.updateSandbox).toHaveBeenCalledWith("alice", {
      messagingChannels: ["discord"],
    });
  });
});
