// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const os = require("os");
const path = require("path");

function isWsl(opts = {}) {
  // Explicit override — lets tests pin behavior regardless of the host kernel.
  // Useful because the WSL detection below consults `os.release()`, which
  // returns a "microsoft"-tagged string on WSL2 hosts even when env vars are
  // unset. Without this override, any test calling functions that consult
  // `isWsl()` becomes non-deterministic on WSL2 dev machines.
  if (typeof opts.isWsl === "boolean") return opts.isWsl;

  const platform = opts.platform ?? process.platform;
  if (platform !== "linux") return false;

  const env = opts.env ?? process.env;
  const release = opts.release ?? os.release();
  const procVersion = opts.procVersion ?? "";

  return (
    Boolean(env.WSL_DISTRO_NAME) ||
    Boolean(env.WSL_INTEROP) ||
    /microsoft/i.test(release) ||
    /microsoft/i.test(procVersion)
  );
}

function inferContainerRuntime(info = "") {
  const normalized = String(info).toLowerCase();
  if (!normalized.trim()) return "unknown";
  if (normalized.includes("podman")) return "podman";
  if (normalized.includes("colima")) return "colima";
  if (normalized.includes("docker desktop")) return "docker-desktop";
  if (normalized.includes("docker")) return "docker";
  return "unknown";
}

function shouldPatchCoredns(runtime, opts = {}) {
  // CoreDNS patching is needed for Colima and Podman (both use custom network bridges).
  // On WSL2, the host DNS is not routable from k3s pods — skip and let setup-dns-proxy.sh handle it.
  if (isWsl(opts)) return false;
  return runtime === "colima" || runtime === "podman";
}

function getColimaDockerSocketCandidates(opts = {}) {
  const home = opts.home ?? process.env.HOME ?? "/tmp";
  return [
    path.join(home, ".colima/default/docker.sock"),
    path.join(home, ".config/colima/default/docker.sock"),
  ];
}

function findColimaDockerSocket(opts = {}) {
  const existsSync = opts.existsSync ?? require("fs").existsSync;
  return getColimaDockerSocketCandidates(opts).find((socketPath) => existsSync(socketPath)) ?? null;
}

function getPodmanSocketCandidates(opts = {}) {
  const home = opts.home ?? process.env.HOME ?? "/tmp";
  const platform = opts.platform ?? process.platform;
  const uid = opts.uid ?? process.getuid?.() ?? 1000;

  if (platform === "darwin") {
    return [
      path.join(home, ".local/share/containers/podman/machine/podman.sock"),
      "/var/run/docker.sock",
    ];
  }

  return [`/run/user/${uid}/podman/podman.sock`, "/run/podman/podman.sock"];
}

function getDockerSocketCandidates(opts = {}) {
  const home = opts.home ?? process.env.HOME ?? "/tmp";
  const platform = opts.platform ?? process.platform;

  if (platform === "darwin") {
    return [
      ...getColimaDockerSocketCandidates({ home }),
      ...getPodmanSocketCandidates({ home, platform }),
      path.join(home, ".docker/run/docker.sock"),
    ];
  }

  if (platform === "linux") {
    return [
      ...getPodmanSocketCandidates({ home, platform, uid: opts.uid }),
      "/run/docker.sock",
      "/var/run/docker.sock",
    ];
  }

  return [];
}

function detectDockerHost(opts = {}) {
  const env = opts.env ?? process.env;
  if (env.DOCKER_HOST) {
    return {
      dockerHost: env.DOCKER_HOST,
      source: "env",
      socketPath: null,
    };
  }

  const existsSync = opts.existsSync ?? require("fs").existsSync;
  for (const socketPath of getDockerSocketCandidates(opts)) {
    if (existsSync(socketPath)) {
      return {
        dockerHost: `unix://${socketPath}`,
        source: "socket",
        socketPath,
      };
    }
  }

  return null;
}

function detectGatewayBackend(opts = {}) {
  const env = opts.env ?? process.env;
  const override = env.NEMOCLAW_GATEWAY_BACKEND;
  if (override === "vm" || override === "docker") return override;

  const vmAvailable =
    typeof opts.vmAvailable === "boolean"
      ? opts.vmAvailable
      : false; // caller should pass actual detection result
  const dockerAvailable =
    typeof opts.dockerAvailable === "boolean"
      ? opts.dockerAvailable
      : detectDockerHost(opts) !== null;

  // GPU inference is routed through inference.local (OpenShell L7 proxy
  // → host inference server), so the sandbox/gateway never needs direct
  // GPU access. The VM backend works for all scenarios.
  if (vmAvailable) return "vm";
  if (dockerAvailable) return "docker";
  return "unknown";
}

export {
  detectDockerHost,
  detectGatewayBackend,
  findColimaDockerSocket,
  getColimaDockerSocketCandidates,
  getDockerSocketCandidates,
  getPodmanSocketCandidates,
  inferContainerRuntime,
  isWsl,
  shouldPatchCoredns,
};
