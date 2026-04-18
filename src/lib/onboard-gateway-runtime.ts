// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import pRetry from "p-retry";

import { ANSI_RE } from "./ansi-utils";

export interface GatewayStartResult {
  status: number;
  output: string;
}

export interface GatewayStartEnv {
  OPENSHELL_CLUSTER_IMAGE?: string;
  IMAGE_TAG?: string;
}

export function getGatewayStartEnv(openshellVersion: string | null): GatewayStartEnv {
  const gatewayEnv: GatewayStartEnv = {};
  const stableGatewayImage = openshellVersion
    ? `ghcr.io/nvidia/openshell/cluster:${openshellVersion}`
    : null;
  if (stableGatewayImage) {
    gatewayEnv.OPENSHELL_CLUSTER_IMAGE = stableGatewayImage;
    gatewayEnv.IMAGE_TAG = openshellVersion || undefined;
  }
  return gatewayEnv;
}

export interface StartGatewayDeps<TGpu = unknown> {
  gatewayName: string;
  gatewayPort: number;
  scriptsDir: string;
  processEnv: NodeJS.ProcessEnv;
  processArch?: string;
  showHeader: () => void;
  log: (message?: string) => void;
  error: (message?: string) => void;
  exit: (code: number) => never;
  openshellShellCommand: (args: string[]) => string;
  streamGatewayStart: (
    command: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<GatewayStartResult>;
  runCaptureOpenshell: (args: string[], opts?: { ignoreError?: boolean }) => string;
  runOpenshell: (
    args: string[],
    opts?: {
      ignoreError?: boolean;
      suppressOutput?: boolean;
      env?: Record<string, string>;
      stdio?: [string, string, string];
    },
  ) => { status: number; stdout?: string; stderr?: string };
  isGatewayHealthy: (
    statusOutput: string,
    gwInfoOutput: string,
    activeGatewayInfoOutput: string,
  ) => boolean;
  hasStaleGateway: (gwInfoOutput: string) => boolean;
  redact: (value: string) => string;
  compactText: (value: string) => string;
  envInt: (name: string, fallback: number) => number;
  sleep: (seconds: number) => void;
  getInstalledOpenshellVersion: () => string | null;
  getContainerRuntime: () => string;
  shouldPatchCoredns: (runtime: string) => boolean;
  run: (command: string | string[], opts?: { ignoreError?: boolean }) => unknown;
  destroyGateway: () => void;
  pruneKnownHostsEntries: (contents: string) => string;
  execFileSyncImpl?: typeof execFileSync;
  fsImpl?: Pick<typeof fs, "existsSync" | "readFileSync" | "writeFileSync">;
  osImpl?: Pick<typeof os, "homedir">;
}

export interface StartGatewayOptions {
  exitOnFailure?: boolean;
}

function clearGatewayKnownHosts(
  gatewayName: string,
  pruneKnownHostsEntries: (contents: string) => string,
  execFileSyncImpl: typeof execFileSync,
  fsImpl: Pick<typeof fs, "existsSync" | "readFileSync" | "writeFileSync">,
  homeDir: string,
): void {
  try {
    execFileSyncImpl("ssh-keygen", ["-R", `openshell-${gatewayName}`], { stdio: "ignore" });
  } catch {
    /* ssh-keygen -R may fail if entry doesn't exist — safe to ignore */
  }

  const knownHostsPath = path.join(homeDir, ".ssh", "known_hosts");
  if (fsImpl.existsSync(knownHostsPath)) {
    try {
      const kh = fsImpl.readFileSync(knownHostsPath, "utf8");
      const cleaned = pruneKnownHostsEntries(kh);
      if (cleaned !== kh) fsImpl.writeFileSync(knownHostsPath, cleaned);
    } catch {
      /* best-effort cleanup — ignore read/write errors */
    }
  }
}

export async function startGatewayWithOptions<TGpu = unknown>(
  _gpu: TGpu,
  deps: StartGatewayDeps<TGpu>,
  options: StartGatewayOptions = {},
): Promise<void> {
  const exitOnFailure = options.exitOnFailure ?? true;
  const execFileSyncImpl = deps.execFileSyncImpl ?? execFileSync;
  const fsImpl = deps.fsImpl ?? fs;
  const osImpl = deps.osImpl ?? os;

  deps.showHeader();

  const gatewayStatus = deps.runCaptureOpenshell(["status"], { ignoreError: true });
  const gwInfo = deps.runCaptureOpenshell(["gateway", "info", "-g", deps.gatewayName], {
    ignoreError: true,
  });
  const activeGatewayInfo = deps.runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
  if (deps.isGatewayHealthy(gatewayStatus, gwInfo, activeGatewayInfo)) {
    deps.log("  ✓ Reusing existing gateway");
    deps.runOpenshell(["gateway", "select", deps.gatewayName], { ignoreError: true });
    deps.processEnv.OPENSHELL_GATEWAY = deps.gatewayName;
    return;
  }

  if (deps.hasStaleGateway(gwInfo)) {
    deps.log("  Stale gateway detected — attempting restart without destroy...");
  }

  clearGatewayKnownHosts(
    deps.gatewayName,
    deps.pruneKnownHostsEntries,
    execFileSyncImpl,
    fsImpl,
    osImpl.homedir(),
  );

  const gwArgs = ["--name", deps.gatewayName, "--port", String(deps.gatewayPort)];
  const gatewayEnv = getGatewayStartEnv(deps.getInstalledOpenshellVersion());
  if (gatewayEnv.OPENSHELL_CLUSTER_IMAGE) {
    deps.log(`  Using pinned OpenShell gateway image: ${gatewayEnv.OPENSHELL_CLUSTER_IMAGE}`);
  }

  const retries = exitOnFailure ? 2 : 0;
  try {
    await pRetry(
      async () => {
        const startResult = await deps.streamGatewayStart(
          deps.openshellShellCommand(["gateway", "start", ...gwArgs]),
          {
            ...deps.processEnv,
            ...gatewayEnv,
          },
        );
        if (startResult.status !== 0) {
          const lines = String(deps.redact(startResult.output || ""))
            .split("\n")
            .map((line) => deps.compactText(line.replace(ANSI_RE, "")))
            .filter(Boolean)
            .map((line) => `    ${line}`);
          if (lines.length > 0) {
            deps.log(`  Gateway start returned before healthy:\n${lines.join("\n")}`);
          }
        }
        deps.log("  Waiting for gateway health...");

        const isArm64 = (deps.processArch ?? process.arch) === "arm64";
        const healthPollCount = deps.envInt("NEMOCLAW_HEALTH_POLL_COUNT", isArm64 ? 30 : 12);
        const healthPollInterval = deps.envInt(
          "NEMOCLAW_HEALTH_POLL_INTERVAL",
          isArm64 ? 10 : 5,
        );
        for (let i = 0; i < healthPollCount; i++) {
          deps.runCaptureOpenshell(["gateway", "select", deps.gatewayName], { ignoreError: true });
          const status = deps.runCaptureOpenshell(["status"], { ignoreError: true });
          const namedInfo = deps.runCaptureOpenshell(["gateway", "info", "-g", deps.gatewayName], {
            ignoreError: true,
          });
          const currentInfo = deps.runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
          if (deps.isGatewayHealthy(status, namedInfo, currentInfo)) {
            return;
          }
          if (i < healthPollCount - 1) deps.sleep(healthPollInterval);
        }

        throw new Error("Gateway failed to start");
      },
      {
        retries,
        minTimeout: 10_000,
        factor: 3,
        onFailedAttempt: (error) => {
          deps.log(
            `  Gateway start attempt ${error.attemptNumber} failed. ${error.retriesLeft} retries left...`,
          );
          if (error.retriesLeft > 0 && exitOnFailure) {
            deps.destroyGateway();
          }
        },
      },
    );
  } catch {
    if (exitOnFailure) {
      deps.error(`  Gateway failed to start after ${retries + 1} attempts.`);
      deps.error("  Gateway state preserved for diagnostics.");
      deps.error("");
      try {
        const logs = deps.redact(
          deps.runCaptureOpenshell(["doctor", "logs", "--name", deps.gatewayName], {
            ignoreError: true,
          }),
        );
        if (logs) {
          deps.error("  Gateway logs:");
          for (const line of String(logs)
            .split("\n")
            .map((line) => line.replace(/\r/g, "").replace(ANSI_RE, ""))
            .filter(Boolean)) {
            deps.error(`    ${line}`);
          }
          deps.error("");
        }
      } catch {
        // doctor logs unavailable — fall through to manual instructions
      }
      deps.error("  Troubleshooting:");
      deps.error(`    openshell doctor logs --name ${deps.gatewayName}`);
      deps.error("    openshell doctor check");
      deps.exit(1);
    }
    throw new Error("Gateway failed to start");
  }

  deps.log("  ✓ Gateway is healthy");
  const runtime = deps.getContainerRuntime();
  if (deps.shouldPatchCoredns(runtime)) {
    deps.log("  Patching CoreDNS DNS forwarding...");
    // Pass the script path and gateway name as discrete argv entries so
    // deps.gatewayName cannot alter shell parsing if it ever stops being a
    // fixed internal constant.
    deps.run(["bash", path.join(deps.scriptsDir, "fix-coredns.sh"), deps.gatewayName], {
      ignoreError: true,
    });
  }
  deps.sleep(5);
  deps.runOpenshell(["gateway", "select", deps.gatewayName], { ignoreError: true });
  deps.processEnv.OPENSHELL_GATEWAY = deps.gatewayName;
}

export interface RecoverGatewayRuntimeDeps {
  gatewayName: string;
  gatewayPort: number;
  processEnv: NodeJS.ProcessEnv;
  runCaptureOpenshell: (args: string[], opts?: { ignoreError?: boolean }) => string;
  runOpenshell: (
    args: string[],
    opts?: {
      ignoreError?: boolean;
      suppressOutput?: boolean;
      env?: Record<string, string>;
      stdio?: [string, string, string];
    },
  ) => { status: number; stdout?: string; stderr?: string };
  isSelectedGateway: (statusOutput: string, gatewayName?: string) => boolean;
  getGatewayStartEnv: () => GatewayStartEnv;
  envInt: (name: string, fallback: number) => number;
  sleep: (seconds: number) => void;
  redact: (value: string) => string;
  compactText: (value: string) => string;
  getContainerRuntime: () => string;
  shouldPatchCoredns: (runtime: string) => boolean;
  run: (command: string | string[], opts?: { ignoreError?: boolean }) => unknown;
  scriptsDir: string;
  error: (message?: string) => void;
}

export async function recoverGatewayRuntime(deps: RecoverGatewayRuntimeDeps): Promise<boolean> {
  deps.runOpenshell(["gateway", "select", deps.gatewayName], { ignoreError: true });
  let status = deps.runCaptureOpenshell(["status"], { ignoreError: true });
  if (status.includes("Connected") && deps.isSelectedGateway(status, deps.gatewayName)) {
    deps.processEnv.OPENSHELL_GATEWAY = deps.gatewayName;
    return true;
  }

  const startResult = deps.runOpenshell(
    ["gateway", "start", "--name", deps.gatewayName, "--port", String(deps.gatewayPort)],
    {
      ignoreError: true,
      env: deps.getGatewayStartEnv() as Record<string, string>,
      suppressOutput: true,
    },
  );
  if (startResult.status !== 0) {
    const diagnostic = deps.compactText(
      deps.redact(`${startResult.stderr || ""} ${startResult.stdout || ""}`),
    );
    deps.error(`  Gateway restart failed (exit ${startResult.status}).`);
    if (diagnostic) {
      deps.error(`  ${diagnostic.slice(0, 240)}`);
    }
  }
  deps.runOpenshell(["gateway", "select", deps.gatewayName], { ignoreError: true });

  const recoveryPollCount = deps.envInt("NEMOCLAW_HEALTH_POLL_COUNT", 10);
  const recoveryPollInterval = deps.envInt("NEMOCLAW_HEALTH_POLL_INTERVAL", 2);
  for (let i = 0; i < recoveryPollCount; i++) {
    status = deps.runCaptureOpenshell(["status"], { ignoreError: true });
    if (status.includes("Connected") && deps.isSelectedGateway(status, deps.gatewayName)) {
      deps.processEnv.OPENSHELL_GATEWAY = deps.gatewayName;
      const runtime = deps.getContainerRuntime();
      if (deps.shouldPatchCoredns(runtime)) {
        // Pass the script path and gateway name as discrete argv entries so
        // deps.gatewayName cannot alter shell parsing if it ever stops being a
        // fixed internal constant.
        deps.run(["bash", path.join(deps.scriptsDir, "fix-coredns.sh"), deps.gatewayName], {
          ignoreError: true,
        });
      }
      return true;
    }
    if (i < recoveryPollCount - 1) deps.sleep(recoveryPollInterval);
  }

  return false;
}
