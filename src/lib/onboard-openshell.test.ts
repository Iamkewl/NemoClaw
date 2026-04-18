// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
// Import from compiled dist/ so coverage is attributed correctly.
import {
  installOpenshell,
  isOpenshellInstalled,
  waitForSandboxReady,
} from "../../dist/lib/onboard-openshell";

describe("onboard-openshell", () => {
  it("detects whether OpenShell is installed", () => {
    expect(isOpenshellInstalled(() => "/usr/bin/openshell")).toBe(true);
    expect(isOpenshellInstalled(() => null)).toBe(false);
  });

  it("installs openshell and computes the future-shell PATH hint", () => {
    const spawnSync = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const result = installOpenshell({
      scriptPath: "/repo/scripts/install-openshell.sh",
      rootDir: "/repo",
      env: { HOME: "/home/test", PATH: "/usr/local/bin:/usr/bin" },
      spawnSync,
      existsSync: (filePath) => filePath === "/home/test/.local/bin/openshell",
      resolveOpenshell: () => null,
      getFutureShellPathHint: (binDir, pathValue) =>
        pathValue.includes(binDir) ? null : `export PATH=\"${binDir}:$PATH\"`,
    });

    expect(spawnSync).toHaveBeenCalledWith("bash", ["/repo/scripts/install-openshell.sh"], {
      cwd: "/repo",
      env: { HOME: "/home/test", PATH: "/usr/local/bin:/usr/bin" },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      timeout: 300000,
    });
    expect(result).toEqual({
      installed: true,
      localBin: "/home/test/.local/bin",
      futureShellPathHint: 'export PATH="/home/test/.local/bin:$PATH"',
      updatedPathValue: "/home/test/.local/bin:/usr/local/bin:/usr/bin",
      openshellBinary: "/home/test/.local/bin/openshell",
    });
  });

  it("returns a failure result and forwards installer output on install errors", () => {
    const errorWriter = vi.fn();
    const result = installOpenshell({
      scriptPath: "/repo/scripts/install-openshell.sh",
      rootDir: "/repo",
      env: { HOME: "/home/test", PATH: "/usr/local/bin:/usr/bin" },
      spawnSync: () => ({ status: 1, stdout: "stdout failure", stderr: "stderr failure" }),
      existsSync: () => false,
      resolveOpenshell: () => null,
      getFutureShellPathHint: () => null,
      errorWriter,
    });

    expect(result).toEqual({
      installed: false,
      localBin: null,
      futureShellPathHint: null,
      updatedPathValue: null,
      openshellBinary: null,
    });
    expect(errorWriter).toHaveBeenCalledWith("stdout failurestderr failure");
  });

  it("waits for the sandbox pod to reach the Running phase", () => {
    const calls: string[][] = [];
    const result = waitForSandboxReady(
      "alpha",
      {
        runCaptureOpenshell: (args) => {
          calls.push(args);
          return calls.length === 3 ? "Running" : "Pending";
        },
        sleep: vi.fn(),
      },
      5,
      1,
    );

    expect(result).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual([
      "doctor",
      "exec",
      "--",
      "kubectl",
      "-n",
      "openshell",
      "get",
      "pod",
      "alpha",
      "-o",
      "jsonpath={.status.phase}",
    ]);
  });
});
