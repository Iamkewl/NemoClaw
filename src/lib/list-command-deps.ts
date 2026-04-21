// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as onboardSession from "./onboard-session";
import type { ListSandboxesCommandDeps, RecoveryResult } from "./inventory-commands";
import { parseGatewayInference } from "./inference-config";
import { parseSshProcesses, createSystemDeps } from "./sandbox-session-state";
import { resolveOpenshell } from "./resolve-openshell";

interface ListCommandRuntimeBridge {
  captureOpenshell: (
    args: string[],
    opts?: { ignoreError?: boolean },
  ) => { status: number; output: string };
  recoverRegistryEntries: (options?: {
    requestedSandboxName?: string | null;
  }) => Promise<RecoveryResult>;
}

function getRuntimeBridge(): ListCommandRuntimeBridge {
  return require("../nemoclaw") as ListCommandRuntimeBridge;
}

export function buildListCommandDeps(): ListSandboxesCommandDeps {
  const opsBinList = resolveOpenshell();
  const sessionDeps = opsBinList ? createSystemDeps(opsBinList) : null;
  const runtime = getRuntimeBridge();

  // Cache the SSH process probe once for all sandboxes — avoids spawning ps
  // per sandbox row. The getSshProcesses() call is the expensive part (5s timeout).
  let cachedSshOutput: string | null | undefined;
  const getCachedSshOutput = () => {
    if (cachedSshOutput === undefined && sessionDeps) {
      cachedSshOutput = sessionDeps.getSshProcesses();
    }
    return cachedSshOutput ?? null;
  };

  return {
    recoverRegistryEntries: () => runtime.recoverRegistryEntries(),
    getLiveInference: () =>
      parseGatewayInference(
        runtime.captureOpenshell(["inference", "get"], { ignoreError: true }).output,
      ),
    loadLastSession: () => onboardSession.loadSession(),
    getActiveSessionCount: sessionDeps
      ? (name) => {
          try {
            const sshOutput = getCachedSshOutput();
            if (sshOutput === null) return null;
            return parseSshProcesses(sshOutput, name).length;
          } catch {
            return null;
          }
        }
      : undefined,
  };
}
