// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("p-retry", () => ({
  default: async (
    fn: () => Promise<unknown>,
    opts?: { onFailedAttempt?: (error: Error & { attemptNumber: number; retriesLeft: number }) => void },
  ) => {
    try {
      return await fn();
    } catch (error) {
      opts?.onFailedAttempt?.(Object.assign(error as Error, { attemptNumber: 1, retriesLeft: 0 }));
      throw error;
    }
  },
}));
// Import from compiled dist/ so coverage is attributed correctly.
import {
  getGatewayStartEnv,
  recoverGatewayRuntime,
  startGatewayWithOptions,
} from "../../dist/lib/onboard-gateway-runtime";

describe("onboard-gateway-runtime", () => {
  it("builds a pinned gateway image environment from the installed OpenShell version", () => {
    expect(getGatewayStartEnv("0.0.24")).toEqual({
      OPENSHELL_CLUSTER_IMAGE: "ghcr.io/nvidia/openshell/cluster:0.0.24",
      IMAGE_TAG: "0.0.24",
    });
    expect(getGatewayStartEnv(null)).toEqual({});
  });

  it("reuses an already healthy gateway without attempting a restart", async () => {
    const log = vi.fn();
    const runOpenshell = vi.fn(() => ({ status: 0 }));
    const processEnv: NodeJS.ProcessEnv = {};

    await startGatewayWithOptions(
      null,
      {
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        scriptsDir: "/repo/scripts",
        processEnv,
        showHeader: vi.fn(),
        log,
        error: vi.fn(),
        exit: ((code: number) => {
          throw new Error(`exit:${code}`);
        }) as never,
        openshellShellCommand: (args) => args.join(" "),
        streamGatewayStart: async () => ({ status: 0, output: "" }),
        runCaptureOpenshell: (args) => (args[0] === "status" ? "Gateway status: Connected" : "Gateway: nemoclaw"),
        runOpenshell,
        isGatewayHealthy: () => true,
        hasStaleGateway: () => false,
        redact: (value) => value,
        compactText: (value) => value.trim(),
        envInt: (_name, fallback) => fallback,
        sleep: () => {},
        getInstalledOpenshellVersion: () => "0.0.24",
        getContainerRuntime: () => "docker",
        shouldPatchCoredns: () => false,
        run: () => ({ status: 0 }),
        destroyGateway: vi.fn(),
        pruneKnownHostsEntries: (value) => value,
      },
      { exitOnFailure: true },
    );

    expect(log).toHaveBeenCalledWith("  ✓ Reusing existing gateway");
    expect(runOpenshell).toHaveBeenCalledWith(["gateway", "select", "nemoclaw"], {
      ignoreError: true,
    });
    expect(processEnv.OPENSHELL_GATEWAY).toBe("nemoclaw");
  });

  it("starts the gateway, patches CoreDNS when needed, and selects it afterward", async () => {
    const log = vi.fn();
    const runCaptureOpenshell = vi
      .fn()
      .mockReturnValueOnce("Gateway status: Disconnected")
      .mockReturnValueOnce("Gateway: nemoclaw")
      .mockReturnValueOnce("Gateway: openshell")
      .mockReturnValueOnce("")
      .mockReturnValueOnce("Gateway status: Connected\nGateway: nemoclaw")
      .mockReturnValueOnce("Gateway: nemoclaw")
      .mockReturnValueOnce("Gateway: nemoclaw");
    const run = vi.fn(() => ({ status: 0 }));
    const runOpenshell = vi.fn(() => ({ status: 0 }));
    const processEnv: NodeJS.ProcessEnv = {};

    await startGatewayWithOptions(
      null,
      {
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        scriptsDir: "/repo/scripts",
        processEnv,
        showHeader: vi.fn(),
        log,
        error: vi.fn(),
        exit: ((code: number) => {
          throw new Error(`exit:${code}`);
        }) as never,
        openshellShellCommand: (args) => `openshell ${args.join(" ")}`,
        streamGatewayStart: async (_command, env) => {
          expect(env.OPENSHELL_CLUSTER_IMAGE).toBe("ghcr.io/nvidia/openshell/cluster:0.0.24");
          return { status: 0, output: "starting gateway" };
        },
        runCaptureOpenshell,
        runOpenshell,
        isGatewayHealthy: (status) => status.includes("Connected") && status.includes("nemoclaw"),
        hasStaleGateway: () => false,
        redact: (value) => value,
        compactText: (value) => value.trim(),
        envInt: (_name, fallback) => fallback === 12 ? 1 : fallback === 5 ? 0 : fallback,
        sleep: vi.fn(),
        getInstalledOpenshellVersion: () => "0.0.24",
        getContainerRuntime: () => "docker",
        shouldPatchCoredns: () => true,
        run,
        destroyGateway: vi.fn(),
        pruneKnownHostsEntries: (value) => value,
      },
      { exitOnFailure: true },
    );

    expect(log).toHaveBeenCalledWith("  Waiting for gateway health...");
    expect(log).toHaveBeenCalledWith("  ✓ Gateway is healthy");
    expect(log).toHaveBeenCalledWith("  Patching CoreDNS DNS forwarding...");
    expect(run).toHaveBeenCalledWith(
      ["bash", "/repo/scripts/fix-coredns.sh", "nemoclaw"],
      { ignoreError: true },
    );
    expect(runOpenshell).toHaveBeenLastCalledWith(["gateway", "select", "nemoclaw"], {
      ignoreError: true,
    });
    expect(processEnv.OPENSHELL_GATEWAY).toBe("nemoclaw");
  });

  it("prints doctor logs and exits when gateway startup fails with exitOnFailure", async () => {
    vi.useFakeTimers();
    const error = vi.fn();
    try {
      const promise = startGatewayWithOptions(
        null,
        {
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          scriptsDir: "/repo/scripts",
          processEnv: {},
          showHeader: vi.fn(),
          log: vi.fn(),
          error,
          exit: ((code: number) => {
            throw new Error(`exit:${code}`);
          }) as never,
          openshellShellCommand: (args) => args.join(" "),
          streamGatewayStart: async () => ({ status: 1, output: "ERROR gateway failed" }),
          runCaptureOpenshell: (args) =>
            args.includes("doctor")
              ? "ERROR k3s cluster crashed: OOMKilled\nGateway auth token: nvapi-fakecredential-9999"
              : "",
          runOpenshell: vi.fn(() => ({ status: 0 })),
          isGatewayHealthy: () => false,
          hasStaleGateway: () => true,
          redact: (value) => value.replace(/nvapi-[^\s]+/g, "<REDACTED>"),
          compactText: (value) => value.trim(),
          envInt: (_name, fallback) => fallback === 12 ? 0 : fallback,
          sleep: vi.fn(),
          getInstalledOpenshellVersion: () => null,
          getContainerRuntime: () => "docker",
          shouldPatchCoredns: () => false,
          run: vi.fn(() => ({ status: 0 })),
          destroyGateway: vi.fn(),
          pruneKnownHostsEntries: (value) => value,
        },
        { exitOnFailure: true },
      ).then(
        () => {
          throw new Error("expected gateway startup to fail");
        },
        (error) => error,
      );
      await vi.advanceTimersByTimeAsync(100_000);
      const failure = await promise;
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toBe("exit:1");
    } finally {
      vi.useRealTimers();
    }

    expect(error).toHaveBeenCalledWith("  Gateway failed to start after 3 attempts.");
    expect(error).toHaveBeenCalledWith("  Gateway logs:");
    expect(error.mock.calls.join("\n")).toContain("OOMKilled");
    expect(error.mock.calls.join("\n")).not.toContain("nvapi-fakecredential-9999");
  });

  it("recovers gateway runtime by restarting, polling health, and patching CoreDNS when needed", async () => {
    const runCaptureOpenshell = vi
      .fn()
      .mockReturnValueOnce("Disconnected")
      .mockReturnValueOnce("Connected Gateway: nemoclaw");
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const run = vi.fn(() => ({ status: 0 }));
    const processEnv: NodeJS.ProcessEnv = {};

    const ok = await recoverGatewayRuntime({
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      processEnv,
      runCaptureOpenshell,
      runOpenshell,
      isSelectedGateway: () => true,
      getGatewayStartEnv: () => ({ OPENSHELL_CLUSTER_IMAGE: "ghcr.io/nvidia/openshell/cluster:0.0.24" }),
      envInt: (_name, fallback) => fallback === 10 ? 1 : fallback === 2 ? 0 : fallback,
      sleep: vi.fn(),
      redact: (value) => value,
      compactText: (value) => value.trim(),
      getContainerRuntime: () => "docker",
      shouldPatchCoredns: () => true,
      run,
      scriptsDir: "/repo/scripts",
      error: vi.fn(),
    });

    expect(ok).toBe(true);
    expect(runOpenshell).toHaveBeenCalledWith(["gateway", "select", "nemoclaw"], {
      ignoreError: true,
    });
    expect(runOpenshell).toHaveBeenCalledWith(
      ["gateway", "start", "--name", "nemoclaw", "--port", "8080"],
      {
        ignoreError: true,
        env: { OPENSHELL_CLUSTER_IMAGE: "ghcr.io/nvidia/openshell/cluster:0.0.24" },
        suppressOutput: true,
      },
    );
    expect(run).toHaveBeenCalledWith(
      ["bash", "/repo/scripts/fix-coredns.sh", "nemoclaw"],
      { ignoreError: true },
    );
    expect(processEnv.OPENSHELL_GATEWAY).toBe("nemoclaw");
  });
});
