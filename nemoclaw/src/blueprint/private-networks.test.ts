// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, vi } from "vitest";
import type fs from "node:fs";

// In-memory fs shared with the mocked module.
const store = new Map<string, string>();
let existsCalls: string[] = [];

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  return {
    ...original,
    existsSync: (p: string) => {
      existsCalls.push(p);
      return store.has(p);
    },
    readFileSync: (p: string) => {
      const content = store.get(p);
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
  };
});

const { getNetworkEntries, getPrivateNetworks, isPrivateHostname, resetCache } =
  await import("./private-networks.js");

const VALID_YAML = `
ipv4:
  - address: 10.0.0.0
    prefix: 8
    purpose: Private network
  - address: 127.0.0.0
    prefix: 8
    purpose: Loopback
ipv6:
  - address: "::1"
    prefix: 128
    purpose: Loopback
  - address: "fe80::"
    prefix: 10
    purpose: Link-local
names:
  - name: localhost
    purpose: Loopback special-use name
`;

function seedYaml(path: string, body: string): void {
  store.set(path, body);
}

describe("private-networks loader", () => {
  beforeEach(() => {
    store.clear();
    existsCalls = [];
    delete process.env.NEMOCLAW_BLUEPRINT_PATH;
    resetCache();
  });

  describe("resolveBlueprintPath", () => {
    it("honours NEMOCLAW_BLUEPRINT_PATH when set", () => {
      process.env.NEMOCLAW_BLUEPRINT_PATH = "/custom/path";
      seedYaml("/custom/path/private-networks.yaml", VALID_YAML);
      const entries = getNetworkEntries();
      expect(entries.ipv4).toHaveLength(2);
      // existsSync is only consulted for the dev-guess fallback, which
      // is skipped when the env var is set.
      expect(existsCalls).toEqual([]);
    });

    it("falls back to current directory when no env var and no dev guess", () => {
      seedYaml("private-networks.yaml", VALID_YAML);
      const entries = getNetworkEntries();
      expect(entries.ipv6).toHaveLength(2);
    });

    it("prefers the dev-checkout guess over cwd when both exist", () => {
      // existsSync returns true iff the path is in the store, so we
      // (1) trigger a load that discovers the dev-guess path the loader
      // probes, (2) seed that path plus a differing cwd path, and
      // (3) confirm the dev-guess content wins.
      seedYaml("private-networks.yaml", VALID_YAML);
      getNetworkEntries(); // populates existsCalls
      const guess = existsCalls[0];
      expect(guess).toBeDefined();

      store.clear();
      resetCache();
      existsCalls = [];
      seedYaml(
        "private-networks.yaml",
        "ipv4:\n  - address: 8.8.8.0\n    prefix: 24\n    purpose: cwd sentinel\nipv6: []\n",
      );
      // existsSync is called on the directory, so seed it as well as the
      // file underneath for the resolver to prefer this path.
      seedYaml(guess, "<dir>");
      seedYaml(`${guess}/private-networks.yaml`, VALID_YAML);
      const entries = getNetworkEntries();
      expect(entries.ipv4[0].address).toBe("10.0.0.0");
    });
  });

  describe("schema validation", () => {
    beforeEach(() => {
      process.env.NEMOCLAW_BLUEPRINT_PATH = "/blueprint";
    });

    it("rejects a document missing the ipv4 array", () => {
      seedYaml("/blueprint/private-networks.yaml", "ipv6: []\nnames: []\n");
      expect(() => getNetworkEntries()).toThrow(
        /expected top-level 'ipv4', 'ipv6', and 'names' arrays/,
      );
    });

    it("rejects a document where ipv4 is not an array", () => {
      seedYaml("/blueprint/private-networks.yaml", "ipv4: notanarray\nipv6: []\nnames: []\n");
      expect(() => getNetworkEntries()).toThrow(
        /expected top-level 'ipv4', 'ipv6', and 'names' arrays/,
      );
    });

    it("rejects a document missing the names array", () => {
      seedYaml("/blueprint/private-networks.yaml", "ipv4: []\nipv6: []\n");
      expect(() => getNetworkEntries()).toThrow(
        /expected top-level 'ipv4', 'ipv6', and 'names' arrays/,
      );
    });

    it("rejects an ipv4 entry that is not an object", () => {
      seedYaml("/blueprint/private-networks.yaml", "ipv4:\n  - 42\nipv6: []\nnames: []\n");
      expect(() => getNetworkEntries()).toThrow(/expected an object/);
    });

    it("rejects an ipv4 entry missing address", () => {
      seedYaml(
        "/blueprint/private-networks.yaml",
        "ipv4:\n  - prefix: 8\n    purpose: orphan\nipv6: []\nnames: []\n",
      );
      expect(() => getNetworkEntries()).toThrow(/missing or empty 'address'/);
    });

    it("rejects an ipv4 entry with non-integer prefix", () => {
      seedYaml(
        "/blueprint/private-networks.yaml",
        "ipv4:\n  - address: 10.0.0.0\n    prefix: 8.5\n    purpose: fractional\nipv6: []\nnames: []\n",
      );
      expect(() => getNetworkEntries()).toThrow(/must be a non-negative integer/);
    });

    it("rejects an ipv4 entry with an empty purpose", () => {
      seedYaml(
        "/blueprint/private-networks.yaml",
        'ipv4:\n  - address: 10.0.0.0\n    prefix: 8\n    purpose: "   "\nipv6: []\nnames: []\n',
      );
      expect(() => getNetworkEntries()).toThrow(/'purpose' must be a non-empty string/);
    });

    it("rejects a names entry missing the name field", () => {
      seedYaml(
        "/blueprint/private-networks.yaml",
        "ipv4: []\nipv6: []\nnames:\n  - purpose: orphan\n",
      );
      expect(() => getNetworkEntries()).toThrow(/missing or empty 'name'/);
    });

    it("rejects a names entry with empty purpose", () => {
      seedYaml(
        "/blueprint/private-networks.yaml",
        'ipv4: []\nipv6: []\nnames:\n  - name: localhost\n    purpose: ""\n',
      );
      expect(() => getNetworkEntries()).toThrow(/'purpose' must be a non-empty string/);
    });
  });

  describe("getPrivateNetworks and isPrivateHostname", () => {
    beforeEach(() => {
      process.env.NEMOCLAW_BLUEPRINT_PATH = "/blueprint";
      seedYaml("/blueprint/private-networks.yaml", VALID_YAML);
    });

    it("caches the BlockList across calls", () => {
      const first = getPrivateNetworks();
      const second = getPrivateNetworks();
      expect(first).toBe(second);
    });

    it("resetCache forces a reload", () => {
      const before = getPrivateNetworks();
      resetCache();
      // Change the YAML so a reload can be detected through isPrivateHostname.
      seedYaml(
        "/blueprint/private-networks.yaml",
        "ipv4:\n  - address: 8.8.8.0\n    prefix: 24\n    purpose: after reset\nipv6: []\nnames: []\n",
      );
      const after = getPrivateNetworks();
      expect(after).not.toBe(before);
      expect(isPrivateHostname("8.8.8.1")).toBe(true);
      expect(isPrivateHostname("10.0.0.1")).toBe(false);
    });

    it("returns true for localhost as a hostname", () => {
      expect(isPrivateHostname("localhost")).toBe(true);
    });

    it("strips IPv6 brackets before matching", () => {
      expect(isPrivateHostname("[::1]")).toBe(true);
      expect(isPrivateHostname("[fe80::1]")).toBe(true);
      expect(isPrivateHostname("[2606:4700::1]")).toBe(false);
    });

    it("returns false for a bare DNS name", () => {
      expect(isPrivateHostname("example.com")).toBe(false);
    });

    it("returns false for garbage input", () => {
      expect(isPrivateHostname("not-an-ip")).toBe(false);
      expect(isPrivateHostname("")).toBe(false);
    });
  });
});
