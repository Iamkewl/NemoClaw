// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import type { SpawnSyncReturns } from "node:child_process";

export interface InstallOpenshellResult {
  installed: boolean;
  localBin: string | null;
  futureShellPathHint: string | null;
  updatedPathValue: string | null;
  openshellBinary: string | null;
}

export function isOpenshellInstalled(resolveOpenshell: () => string | null): boolean {
  return resolveOpenshell() !== null;
}

export interface InstallOpenshellDeps {
  scriptPath: string;
  rootDir: string;
  env: NodeJS.ProcessEnv;
  spawnSync: (
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      stdio: ["ignore", "pipe", "pipe"];
      encoding: BufferEncoding;
      timeout: number;
    },
  ) => Pick<SpawnSyncReturns<string>, "status" | "stdout" | "stderr">;
  existsSync: (filePath: string) => boolean;
  resolveOpenshell: () => string | null;
  getFutureShellPathHint: (binDir: string, pathValue: string) => string | null;
  errorWriter?: (message?: string) => void;
}

export function installOpenshell(deps: InstallOpenshellDeps): InstallOpenshellResult {
  const errorWriter = deps.errorWriter ?? console.error;
  const result = deps.spawnSync("bash", [deps.scriptPath], {
    cwd: deps.rootDir,
    env: deps.env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    timeout: 300_000,
  });
  if (result.status !== 0) {
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    if (output) {
      errorWriter(output);
    }
    return {
      installed: false,
      localBin: null,
      futureShellPathHint: null,
      updatedPathValue: null,
      openshellBinary: null,
    };
  }

  const localBin = deps.env.XDG_BIN_HOME || path.join(deps.env.HOME || "", ".local", "bin");
  const openshellPath = path.join(localBin, "openshell");
  const openshellExists = deps.existsSync(openshellPath);
  const futureShellPathHint = openshellExists
    ? deps.getFutureShellPathHint(localBin, deps.env.PATH || "")
    : null;
  const updatedPathValue =
    openshellExists && futureShellPathHint
      ? `${localBin}${path.delimiter}${deps.env.PATH || ""}`
      : null;
  const openshellBinary = deps.resolveOpenshell() ?? (openshellExists ? openshellPath : null);
  return {
    installed: openshellExists || openshellBinary !== null,
    localBin,
    futureShellPathHint,
    updatedPathValue,
    openshellBinary,
  };
}

export interface WaitForSandboxReadyDeps {
  runCaptureOpenshell: (args: string[], opts?: { ignoreError?: boolean }) => string;
  sleep: (seconds: number) => void;
}

export function waitForSandboxReady(
  sandboxName: string,
  deps: WaitForSandboxReadyDeps,
  attempts = 10,
  delaySeconds = 2,
): boolean {
  for (let i = 0; i < attempts; i += 1) {
    const podPhase = deps.runCaptureOpenshell(
      [
        "doctor",
        "exec",
        "--",
        "kubectl",
        "-n",
        "openshell",
        "get",
        "pod",
        sandboxName,
        "-o",
        "jsonpath={.status.phase}",
      ],
      { ignoreError: true },
    );
    if (podPhase === "Running") return true;
    deps.sleep(delaySeconds);
  }
  return false;
}
