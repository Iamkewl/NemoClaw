// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import pRetry from "p-retry";

export function createOnboardGatewayHelpers(deps) {
  const {
    GATEWAY_NAME,
    ROOT,
    SCRIPTS,
    compactText,
    envInt,
    getContainerRuntime,
    getInstalledOpenshellVersion,
    hasStaleGateway,
    isGatewayHealthy,
    isSelectedGateway,
    openshellShellCommand,
    redact,
    registry,
    run,
    runCaptureOpenshell,
    runOpenshell,
    shouldPatchCoredns,
    sleep,
    step,
  } = deps;

  function pruneKnownHostsEntries(contents) {
    return contents
      .split("\n")
      .filter((l) => {
        const trimmed = l.trim();
        if (!trimmed || trimmed.startsWith("#")) return true;
        const hostField = trimmed.split(/\s+/)[0];
        return !hostField.split(",").some((h) => h.startsWith("openshell-"));
      })
      .join("\n");
  }

  function streamGatewayStart(command, env = process.env) {
    const child = spawn("bash", ["-lc", command], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const lines = [];
    let pending = "";
    let settled = false;
    let resolvePromise;
    let lastPrintedLine = "";
    let currentPhase = "cluster";
    let lastHeartbeatBucket = -1;
    let lastOutputAt = Date.now();
    const startedAt = Date.now();

    function getDisplayWidth() {
      return Math.max(60, Number(process.stdout.columns || 100));
    }

    function trimDisplayLine(line) {
      const width = getDisplayWidth();
      const maxLen = Math.max(40, width - 4);
      if (line.length <= maxLen) return line;
      return `${line.slice(0, Math.max(0, maxLen - 3))}...`;
    }

    function printProgressLine(line) {
      const display = trimDisplayLine(line);
      if (display !== lastPrintedLine) {
        console.log(display);
        lastPrintedLine = display;
      }
    }

    function elapsedSeconds() {
      return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    }

    function setPhase(nextPhase) {
      if (!nextPhase || nextPhase === currentPhase) return;
      currentPhase = nextPhase;
      const phaseLine =
        nextPhase === "install"
          ? "  Installing OpenShell components..."
          : nextPhase === "pod"
            ? "  Starting OpenShell gateway pod..."
            : nextPhase === "health"
              ? "  Waiting for gateway health..."
              : "  Starting gateway cluster...";
      printProgressLine(phaseLine);
    }

    function classifyLine(line) {
      if (/ApplyJob|helm-install-openshell|Applying HelmChart/i.test(line)) return "install";
      if (
        /openshell-0|Observed pod startup duration|MountVolume\.MountDevice succeeded/i.test(line)
      ) {
        return "pod";
      }
      if (/Gateway .* ready\.?$/i.test(line)) return "health";
      return null;
    }

    function flushLine(rawLine) {
      const line = rawLine.replace(/\r/g, "").trimEnd();
      if (!line) return;
      lines.push(line);
      lastOutputAt = Date.now();
      const nextPhase = classifyLine(line);
      if (nextPhase) setPhase(nextPhase);
    }

    function onChunk(chunk) {
      pending += chunk.toString();
      const parts = pending.split("\n");
      pending = parts.pop();
      parts.forEach(flushLine);
    }

    function finish(result) {
      if (settled) return;
      settled = true;
      if (pending) flushLine(pending);
      clearInterval(heartbeatTimer);
      resolvePromise(result);
    }

    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);

    printProgressLine("  Starting gateway cluster...");
    const heartbeatTimer = setInterval(() => {
      if (settled) return;
      const elapsed = elapsedSeconds();
      const bucket = Math.floor(elapsed / 10);
      if (bucket === lastHeartbeatBucket) return;
      if (Date.now() - lastOutputAt < 3000 && elapsed < 10) return;
      const heartbeatLine =
        currentPhase === "install"
          ? `  Still installing OpenShell components... (${elapsed}s elapsed)`
          : currentPhase === "pod"
            ? `  Still starting OpenShell gateway pod... (${elapsed}s elapsed)`
            : currentPhase === "health"
              ? `  Still waiting for gateway health... (${elapsed}s elapsed)`
              : `  Still starting gateway cluster... (${elapsed}s elapsed)`;
      printProgressLine(heartbeatLine);
      lastHeartbeatBucket = bucket;
    }, 5000);
    heartbeatTimer.unref?.();

    return new Promise((resolve) => {
      resolvePromise = resolve;
      child.on("error", (error) => {
        const detail = error?.message || String(error);
        lines.push(detail);
        finish({ status: 1, output: lines.join("\n") });
      });
      child.on("close", (code) => {
        finish({ status: code ?? 1, output: lines.join("\n") });
      });
    });
  }

  function destroyGateway() {
    const destroyResult = runOpenshell(["gateway", "destroy", "-g", GATEWAY_NAME], {
      ignoreError: true,
    });
    // Clear the local registry so `nemoclaw list` stays consistent with OpenShell state. (#532)
    if (destroyResult.status === 0) {
      registry.clearAll();
    }
    // openshell gateway destroy doesn't remove Docker volumes, which leaves
    // corrupted cluster state that breaks the next gateway start. Clean them up.
    run(
      `docker volume ls -q --filter "name=openshell-cluster-${GATEWAY_NAME}" | grep . && docker volume ls -q --filter "name=openshell-cluster-${GATEWAY_NAME}" | xargs docker volume rm || true`,
      { ignoreError: true },
    );
  }

  async function startGatewayWithOptions(_gpu, { exitOnFailure = true } = {}) {
    step(2, 8, "Starting OpenShell gateway");

    const gatewayStatus = runCaptureOpenshell(["status"], { ignoreError: true });
    const gwInfo = runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], {
      ignoreError: true,
    });
    const activeGatewayInfo = runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
    if (isGatewayHealthy(gatewayStatus, gwInfo, activeGatewayInfo)) {
      console.log("  ✓ Reusing existing gateway");
      runOpenshell(["gateway", "select", GATEWAY_NAME], { ignoreError: true });
      process.env.OPENSHELL_GATEWAY = GATEWAY_NAME;
      return;
    }

    // When a stale gateway is detected (metadata exists but container is gone,
    // e.g. after a Docker/Colima restart), skip the destroy — `gateway start`
    // can recover the container without wiping metadata and mTLS certs.
    // The retry loop below will destroy only if start genuinely fails.
    if (hasStaleGateway(gwInfo)) {
      console.log("  Stale gateway detected — attempting restart without destroy...");
    }

    // Clear stale SSH host keys from previous gateway (fixes #768)
    try {
      const { execFileSync } = require("child_process");
      execFileSync("ssh-keygen", ["-R", `openshell-${GATEWAY_NAME}`], { stdio: "ignore" });
    } catch {
      /* ssh-keygen -R may fail if entry doesn't exist — safe to ignore */
    }
    // Also purge any known_hosts entries matching the gateway hostname pattern
    const knownHostsPath = path.join(os.homedir(), ".ssh", "known_hosts");
    if (fs.existsSync(knownHostsPath)) {
      try {
        const kh = fs.readFileSync(knownHostsPath, "utf8");
        const cleaned = pruneKnownHostsEntries(kh);
        if (cleaned !== kh) fs.writeFileSync(knownHostsPath, cleaned);
      } catch {
        /* best-effort cleanup — ignore read/write errors */
      }
    }

    const gwArgs = ["--name", GATEWAY_NAME];
    // Do NOT pass --gpu here. On DGX Spark (and most GPU hosts), inference is
    // routed through a host-side provider (Ollama, vLLM, or cloud API) — the
    // sandbox itself does not need direct GPU access. Passing --gpu causes
    // FailedPrecondition errors when the gateway's k3s device plugin cannot
    // allocate GPUs. See: https://build.nvidia.com/spark/nemoclaw/instructions
    const gatewayEnv = getGatewayStartEnv();
    if (gatewayEnv.OPENSHELL_CLUSTER_IMAGE) {
      console.log(`  Using pinned OpenShell gateway image: ${gatewayEnv.OPENSHELL_CLUSTER_IMAGE}`);
    }

    // Retry gateway start with exponential backoff. On some hosts (Horde VMs,
    // first-run environments) the embedded k3s needs more time than OpenShell's
    // internal health-check window allows. Retrying after a clean destroy lets
    // the second attempt benefit from cached images and cleaner cgroup state.
    // See: https://github.com/NVIDIA/OpenShell/issues/433
    const retries = exitOnFailure ? 2 : 0;
    try {
      await pRetry(
        async () => {
          const startResult = await streamGatewayStart(
            openshellShellCommand(["gateway", "start", ...gwArgs]),
            {
              ...process.env,
              ...gatewayEnv,
            },
          );
          if (startResult.status !== 0) {
            const output = compactText(String(startResult.output || ""));
            if (output) {
              console.log(`  Gateway start returned before healthy: ${output.slice(0, 240)}`);
            }
          }
          console.log("  Waiting for gateway health...");

          const healthPollCount = envInt("NEMOCLAW_HEALTH_POLL_COUNT", 5);
          const healthPollInterval = envInt("NEMOCLAW_HEALTH_POLL_INTERVAL", 2);
          for (let i = 0; i < healthPollCount; i++) {
            const status = runCaptureOpenshell(["status"], { ignoreError: true });
            const namedInfo = runCaptureOpenshell(["gateway", "info", "-g", GATEWAY_NAME], {
              ignoreError: true,
            });
            const currentInfo = runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
            if (isGatewayHealthy(status, namedInfo, currentInfo)) {
              return; // success
            }
            if (i < healthPollCount - 1) sleep(healthPollInterval);
          }

          throw new Error("Gateway failed to start");
        },
        {
          retries,
          minTimeout: 10_000,
          factor: 3,
          onFailedAttempt: (err) => {
            console.log(
              `  Gateway start attempt ${err.attemptNumber} failed. ${err.retriesLeft} retries left...`,
            );
            if (err.retriesLeft > 0 && exitOnFailure) {
              destroyGateway();
            }
          },
        },
      );
    } catch {
      if (exitOnFailure) {
        console.error(`  Gateway failed to start after ${retries + 1} attempts.`);
        console.error("  Gateway state preserved for diagnostics.");
        console.error("");
        console.error("  Troubleshooting:");
        console.error("    openshell doctor logs --name nemoclaw");
        console.error("    openshell doctor check");
        process.exit(1);
      }
      throw new Error("Gateway failed to start");
    }

    console.log("  ✓ Gateway is healthy");

    // CoreDNS fix — k3s-inside-Docker has broken DNS forwarding on all platforms.
    const runtime = getContainerRuntime();
    if (shouldPatchCoredns(runtime)) {
      console.log("  Patching CoreDNS DNS forwarding...");
      run(`bash "${path.join(SCRIPTS, "fix-coredns.sh")}" ${GATEWAY_NAME} 2>&1 || true`, {
        ignoreError: true,
      });
    }
    sleep(5);
    runOpenshell(["gateway", "select", GATEWAY_NAME], { ignoreError: true });
    process.env.OPENSHELL_GATEWAY = GATEWAY_NAME;
  }

  async function startGateway(_gpu) {
    return startGatewayWithOptions(_gpu, { exitOnFailure: true });
  }

  async function startGatewayForRecovery(_gpu) {
    return startGatewayWithOptions(_gpu, { exitOnFailure: false });
  }

  function getGatewayStartEnv() {
    const gatewayEnv = {};
    const openshellVersion = getInstalledOpenshellVersion();
    const stableGatewayImage = openshellVersion
      ? `ghcr.io/nvidia/openshell/cluster:${openshellVersion}`
      : null;
    if (stableGatewayImage && openshellVersion) {
      gatewayEnv.OPENSHELL_CLUSTER_IMAGE = stableGatewayImage;
      gatewayEnv.IMAGE_TAG = openshellVersion;
    }
    return gatewayEnv;
  }

  async function recoverGatewayRuntime() {
    runOpenshell(["gateway", "select", GATEWAY_NAME], { ignoreError: true });
    let status = runCaptureOpenshell(["status"], { ignoreError: true });
    if (status.includes("Connected") && isSelectedGateway(status)) {
      process.env.OPENSHELL_GATEWAY = GATEWAY_NAME;
      return true;
    }

    const startResult = runOpenshell(["gateway", "start", "--name", GATEWAY_NAME], {
      ignoreError: true,
      env: getGatewayStartEnv(),
      suppressOutput: true,
    });
    if (startResult.status !== 0) {
      const diagnostic = compactText(
        redact(`${startResult.stderr || ""} ${startResult.stdout || ""}`),
      );
      console.error(`  Gateway restart failed (exit ${startResult.status}).`);
      if (diagnostic) {
        console.error(`  ${diagnostic.slice(0, 240)}`);
      }
    }
    runOpenshell(["gateway", "select", GATEWAY_NAME], { ignoreError: true });

    const recoveryPollCount = envInt("NEMOCLAW_HEALTH_POLL_COUNT", 10);
    const recoveryPollInterval = envInt("NEMOCLAW_HEALTH_POLL_INTERVAL", 2);
    for (let i = 0; i < recoveryPollCount; i++) {
      status = runCaptureOpenshell(["status"], { ignoreError: true });
      if (status.includes("Connected") && isSelectedGateway(status)) {
        process.env.OPENSHELL_GATEWAY = GATEWAY_NAME;
        const runtime = getContainerRuntime();
        if (shouldPatchCoredns(runtime)) {
          run(`bash "${path.join(SCRIPTS, "fix-coredns.sh")}" ${GATEWAY_NAME} 2>&1 || true`, {
            ignoreError: true,
          });
        }
        return true;
      }
      if (i < recoveryPollCount - 1) sleep(recoveryPollInterval);
    }

    return false;
  }

  // ── Step 3: Sandbox ──────────────────────────────────────────────

  return {
    destroyGateway,
    getGatewayStartEnv,
    pruneKnownHostsEntries,
    recoverGatewayRuntime,
    startGateway,
    startGatewayForRecovery,
    startGatewayWithOptions,
    streamGatewayStart,
  };
}
