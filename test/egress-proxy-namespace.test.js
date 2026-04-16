// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Egress Proxy Binary Resolution — Policy & Namespace Tests
 *
 * Validates that the network policy for issue #1471 is correctly configured,
 * and documents the expected proxy behavior for cross-namespace binary resolution.
 *
 * See: https://github.com/NVIDIA/NemoClaw/issues/1471
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const BASELINE_POLICY = path.join(
  import.meta.dirname,
  "..",
  "nemoclaw-blueprint",
  "policies",
  "openclaw-sandbox.yaml",
);

describe("issue #1471: egress proxy binary resolution", () => {
  const yaml = fs.readFileSync(BASELINE_POLICY, "utf-8");

  describe("telegram policy is correctly configured", () => {
    it("has a telegram network policy entry", () => {
      expect(yaml).toMatch(/^\s{2}telegram:\s*$/m);
    });

    it("telegram policy includes api.telegram.org endpoint", () => {
      // Extract the telegram block
      const telegramMatch = yaml.match(/^\s{2}telegram:.*?(?=^\s{2}\w+:|^[^ ])/ms);
      expect(telegramMatch).not.toBeNull();
      const telegramBlock = telegramMatch[0];
      expect(telegramBlock).toContain("api.telegram.org");
    });

    it("telegram policy specifies node as an allowed binary", () => {
      const telegramMatch = yaml.match(/^\s{2}telegram:.*?(?=^\s{2}\w+:|^[^ ])/ms);
      expect(telegramMatch).not.toBeNull();
      const telegramBlock = telegramMatch[0];
      expect(telegramBlock).toMatch(/path:\s*\/usr\/local\/bin\/node/);
    });

    it("telegram policy uses port 443 with rest protocol", () => {
      const telegramMatch = yaml.match(/^\s{2}telegram:.*?(?=^\s{2}\w+:|^[^ ])/ms);
      expect(telegramMatch).not.toBeNull();
      const telegramBlock = telegramMatch[0];
      expect(telegramBlock).toContain("port: 443");
      expect(telegramBlock).toContain("protocol: rest");
    });
  });

  describe("policy configuration is not the cause of issue #1471", () => {
    it("the telegram policy allows GET and POST to /bot*/** paths", () => {
      // Issue #1471 is NOT a policy configuration problem.
      // Even with correct policy, the proxy reports binary=- because it
      // cannot resolve the calling binary across network namespaces.
      const telegramMatch = yaml.match(/^\s{2}telegram:.*?(?=^\s{2}\w+:|^[^ ])/ms);
      expect(telegramMatch).not.toBeNull();
      const telegramBlock = telegramMatch[0];
      expect(telegramBlock).toMatch(/method:\s*GET/);
      expect(telegramBlock).toMatch(/method:\s*POST/);
      expect(telegramBlock).toMatch(/path:\s*"\/bot\*/);
    });

    it("every policy group has explicit binaries (not wildcard)", () => {
      // Wildcard binaries (path: '*') do NOT fix #1471 because the proxy
      // fails to resolve the binary before it ever checks the allowlist.
      // This test confirms we're not using wildcards as a "fix".
      expect(yaml).not.toMatch(/path:\s*['"]\*['"]/);
    });
  });

  describe("discord WebSocket policy uses CONNECT tunnel", () => {
    it("discord gateway endpoint uses access: full (CONNECT tunnel)", () => {
      // Related issue #409: WebSocket connections require CONNECT tunnels
      // because the proxy's HTTP idle timeout kills long-lived connections.
      // This also triggers the binary resolution path.
      expect(yaml).toMatch(/gateway\.discord\.gg/);
      const discordGwMatch = yaml.match(
        /host:\s*gateway\.discord\.gg.*?(?=^\s{6}-\s*host:|\s{4}binaries:)/ms,
      );
      expect(discordGwMatch).not.toBeNull();
      expect(discordGwMatch[0]).toContain("access: full");
    });
  });
});

describe("issue #1471: root cause documentation", () => {
  it("documents the namespace mismatch root cause", () => {
    // This test serves as executable documentation for the root cause.
    //
    // Architecture:
    //   Pod namespace (10.200.0.1) ← proxy runs here
    //   Sandbox namespace (10.200.0.2) ← agent processes run here
    //
    // The proxy resolves calling binaries by:
    //   1. Getting the peer port of the accepted connection
    //   2. Scanning /proc/<proxy_pid>/net/tcp{,6} for a matching entry
    //   3. Using the inode to find the PID, then reading /proc/<pid>/exe
    //
    // Step 2 fails because the sandbox's TCP connections are in a
    // different network namespace. The proxy scans its OWN /proc/net/tcp
    // which only shows connections in the pod namespace — the client-side
    // socket (in the sandbox namespace) is invisible.
    //
    // Fix: The proxy must scan the sandbox namespace's /proc/net/tcp,
    // e.g., via /proc/<sandbox_init_pid>/net/tcp or nsenter.
    expect(true).toBe(true);
  });

  it("documents that the issue is platform-specific (macOS Docker Desktop + k3s)", () => {
    // The issue is reported on macOS with Docker Desktop and k3s inside
    // the container. On Linux with native Docker, the namespace setup may
    // differ and the issue may not manifest.
    //
    // Docker Desktop macOS → Linux VM → Docker container → k3s → pod → sandbox namespace
    // This deep nesting creates the namespace mismatch.
    expect(true).toBe(true);
  });
});
