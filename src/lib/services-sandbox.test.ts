// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync as realSpawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// We test stopSandboxChannels / stopAll by temporarily replacing the
// compiled resolve-openshell module's export and spying on spawnSync.
// This avoids vi.mock() hoisting issues with CommonJS require chains.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
const resolveOpenshellModule = require("../../dist/lib/resolve-openshell");

import {
  stopSandboxChannels,
  stopAll,
} from "../../dist/lib/services";

// ---------------------------------------------------------------------------
// stopSandboxChannels
// ---------------------------------------------------------------------------

describe("stopSandboxChannels", () => {
  let spawnSyncSpy: ReturnType<typeof vi.spyOn>;
  let originalResolve: typeof resolveOpenshellModule.resolveOpenshell;

  beforeEach(() => {
    originalResolve = resolveOpenshellModule.resolveOpenshell;
    resolveOpenshellModule.resolveOpenshell = vi.fn(() => "/usr/local/bin/openshell");
    // Spy on child_process.spawnSync used by the compiled dist module.
    // The dist code does `require("node:child_process").spawnSync`, so
    // we spy on the same module that the compiled code loaded.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cp = require("node:child_process");
    spawnSyncSpy = vi.spyOn(cp, "spawnSync").mockReturnValue({ status: 0 });
  });

  afterEach(() => {
    resolveOpenshellModule.resolveOpenshell = originalResolve;
    spawnSyncSpy.mockRestore();
  });

  it("execs pkill inside the sandbox via openshell", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    stopSandboxChannels("my-sandbox");

    expect(spawnSyncSpy).toHaveBeenCalledWith(
      "/usr/local/bin/openshell",
      ["sandbox", "exec", "--name", "my-sandbox", "--", "pkill", "-TERM", "-f", "openclaw gateway run"],
      expect.objectContaining({ timeout: 15000 }),
    );
    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("OpenClaw gateway stopped inside sandbox");
    logSpy.mockRestore();
  });

  it("treats pkill exit 1 (no process matched) as success", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    spawnSyncSpy.mockReturnValue({ status: 1 });

    stopSandboxChannels("my-sandbox");

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("OpenClaw gateway was not running inside sandbox");
    logSpy.mockRestore();
  });

  it("warns when sandbox is unreachable (exit > 1)", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    spawnSyncSpy.mockReturnValue({ status: 255 });

    stopSandboxChannels("my-sandbox");

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Could not stop in-sandbox gateway");
    expect(output).toContain("sandbox may be unreachable");
    logSpy.mockRestore();
  });

  it("warns when spawn returns null status (timeout)", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    spawnSyncSpy.mockReturnValue({ status: null });

    stopSandboxChannels("my-sandbox");

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Could not stop in-sandbox gateway");
    logSpy.mockRestore();
  });

  it("warns and skips when openshell is not found", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    resolveOpenshellModule.resolveOpenshell = vi.fn(() => null);

    stopSandboxChannels("my-sandbox");

    expect(spawnSyncSpy).not.toHaveBeenCalled();
    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("openshell not found");
    logSpy.mockRestore();
  });

  it("uses --name flag for sandbox selection (not positional)", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    stopSandboxChannels("my-sandbox");

    const args = spawnSyncSpy.mock.calls[0][1] as string[];
    expect(args[1]).toBe("exec");
    expect(args[2]).toBe("--name");
    expect(args[3]).toBe("my-sandbox");
    logSpy.mockRestore();
  });

  it("targets 'openclaw gateway run' (not just 'openclaw gateway') to avoid killing unrelated processes", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    stopSandboxChannels("my-sandbox");

    const args = spawnSyncSpy.mock.calls[0][1] as string[];
    const pkillPattern = args[args.length - 1];
    // Must include "run" to avoid matching decoy processes like
    // "openclaw gateway decoy" or "openclaw gateway status".
    expect(pkillPattern).toBe("openclaw gateway run");
    logSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// stopAll — sandbox channel integration
// ---------------------------------------------------------------------------

describe("stopAll with sandbox channels", () => {
  let pidDir: string;
  let spawnSyncSpy: ReturnType<typeof vi.spyOn>;
  let originalResolve: typeof resolveOpenshellModule.resolveOpenshell;

  beforeEach(() => {
    pidDir = mkdtempSync(join(tmpdir(), "nemoclaw-svc-sandbox-test-"));
    originalResolve = resolveOpenshellModule.resolveOpenshell;
    resolveOpenshellModule.resolveOpenshell = vi.fn(() => "/usr/local/bin/openshell");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cp = require("node:child_process");
    spawnSyncSpy = vi.spyOn(cp, "spawnSync").mockReturnValue({ status: 0 });
  });

  afterEach(() => {
    rmSync(pidDir, { recursive: true, force: true });
    resolveOpenshellModule.resolveOpenshell = originalResolve;
    spawnSyncSpy.mockRestore();
  });

  it("stops in-sandbox channels when sandboxName is provided", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    stopAll({ pidDir, sandboxName: "test-sb" });

    expect(spawnSyncSpy).toHaveBeenCalledWith(
      "/usr/local/bin/openshell",
      ["sandbox", "exec", "--name", "test-sb", "--", "pkill", "-TERM", "-f", "openclaw gateway run"],
      expect.any(Object),
    );
    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("OpenClaw gateway stopped");
    expect(output).toContain("All services stopped");
    logSpy.mockRestore();
  });

  it("warns when no sandbox name is available", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const savedNemoclaw = process.env.NEMOCLAW_SANDBOX;
    const savedNemoclawName = process.env.NEMOCLAW_SANDBOX_NAME;
    const savedSandbox = process.env.SANDBOX_NAME;
    delete process.env.NEMOCLAW_SANDBOX;
    delete process.env.NEMOCLAW_SANDBOX_NAME;
    delete process.env.SANDBOX_NAME;

    try {
      stopAll({ pidDir });
    } finally {
      if (savedNemoclaw !== undefined) process.env.NEMOCLAW_SANDBOX = savedNemoclaw;
      if (savedNemoclawName !== undefined) process.env.NEMOCLAW_SANDBOX_NAME = savedNemoclawName;
      if (savedSandbox !== undefined) process.env.SANDBOX_NAME = savedSandbox;
    }

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("No sandbox name available");
    expect(output).toContain("All services stopped");
    logSpy.mockRestore();
  });

  it("still stops cloudflared even when sandbox exec fails", () => {
    writeFileSync(join(pidDir, "cloudflared.pid"), "999999999");
    spawnSyncSpy.mockReturnValue({ status: 255 });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    stopAll({ pidDir, sandboxName: "test-sb" });
    logSpy.mockRestore();

    // cloudflared PID file should be cleaned up regardless
    expect(existsSync(join(pidDir, "cloudflared.pid"))).toBe(false);
  });

  it("reads sandbox name from NEMOCLAW_SANDBOX env when not in opts", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const saved = process.env.NEMOCLAW_SANDBOX;
    process.env.NEMOCLAW_SANDBOX = "env-sandbox";

    try {
      stopAll({ pidDir });
    } finally {
      if (saved !== undefined) {
        process.env.NEMOCLAW_SANDBOX = saved;
      } else {
        delete process.env.NEMOCLAW_SANDBOX;
      }
    }

    expect(spawnSyncSpy).toHaveBeenCalledWith(
      "/usr/local/bin/openshell",
      expect.arrayContaining(["env-sandbox"]),
      expect.any(Object),
    );
    logSpy.mockRestore();
  });

  it("reads sandbox name from NEMOCLAW_SANDBOX_NAME when NEMOCLAW_SANDBOX is unset", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const savedNemoclaw = process.env.NEMOCLAW_SANDBOX;
    const savedNemoclawName = process.env.NEMOCLAW_SANDBOX_NAME;
    delete process.env.NEMOCLAW_SANDBOX;
    process.env.NEMOCLAW_SANDBOX_NAME = "named-sandbox";

    try {
      stopAll({ pidDir });
    } finally {
      if (savedNemoclaw !== undefined) {
        process.env.NEMOCLAW_SANDBOX = savedNemoclaw;
      } else {
        delete process.env.NEMOCLAW_SANDBOX;
      }
      if (savedNemoclawName !== undefined) {
        process.env.NEMOCLAW_SANDBOX_NAME = savedNemoclawName;
      } else {
        delete process.env.NEMOCLAW_SANDBOX_NAME;
      }
    }

    expect(spawnSyncSpy).toHaveBeenCalledWith(
      "/usr/local/bin/openshell",
      expect.arrayContaining(["named-sandbox"]),
      expect.any(Object),
    );
    logSpy.mockRestore();
  });
});
