// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function createOnboardOpenclawHelpers(deps) {
  const {
    buildSandboxConfigSyncScript,
    cleanupTempDir,
    getProviderSelectionConfig,
    openshellShellCommand,
    run,
    shellQuote,
    step,
    writeSandboxConfigSyncFile,
  } = deps;

  async function setupOpenclaw(sandboxName, model, provider) {
    step(7, 8, "Setting up OpenClaw inside sandbox");

    const selectionConfig = getProviderSelectionConfig(provider, model);
    if (selectionConfig) {
      const sandboxConfig = {
        ...selectionConfig,
        onboardedAt: new Date().toISOString(),
      };
      const script = buildSandboxConfigSyncScript(sandboxConfig);
      const scriptFile = writeSandboxConfigSyncFile(script);
      try {
        run(
          `${openshellShellCommand(["sandbox", "connect", sandboxName])} < ${shellQuote(scriptFile)}`,
          { stdio: ["ignore", "ignore", "inherit"] },
        );
      } finally {
        cleanupTempDir(scriptFile, "nemoclaw-sync");
      }
    }

    console.log("  ✓ OpenClaw gateway launched inside sandbox");
  }

  return {
    setupOpenclaw,
  };
}
