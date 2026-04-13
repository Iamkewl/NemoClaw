// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Slash command handler for `/nemoclaw config`.
 *
 * Read-only — shows the current sandbox configuration with credential
 * values redacted. Configuration can only be modified from the host CLI
 * (security invariant: sandbox never writes its own immutable config).
 */

import type { PluginCommandResult } from "../index.js";
import {
  describeOnboardEndpoint,
  describeOnboardProvider,
  loadOnboardConfig,
} from "../onboard/config.js";

export function slashConfigShow(): PluginCommandResult {
  const config = loadOnboardConfig();

  if (!config) {
    return {
      text: [
        "**NemoClaw Config**",
        "",
        "No configuration found. Run `nemoclaw onboard` from the host to configure.",
      ].join("\n"),
    };
  }

  // Redact credential env var value — only show the variable name
  const redactedCredential = `$${config.credentialEnv}`;
  const lastFour = config.credentialEnv ? `(set via env var)` : "(not configured)";

  const lines = [
    "**NemoClaw Config**",
    "",
    `Gateway:     ${describeOnboardEndpoint(config)}`,
    `Auth token:  ${redactedCredential} ${lastFour}`,
    `Inference:   ${describeOnboardProvider(config)}`,
    config.ncpPartner ? `NCP Partner: ${config.ncpPartner}` : null,
    `Model:       ${config.model}`,
    `Profile:     ${config.profile}`,
    `Onboarded:   ${config.onboardedAt}`,
    "",
    "Configuration can only be modified from the host CLI.",
    "Use `nemoclaw config get <sandbox>` for the full sandbox config.",
  ];

  return { text: lines.filter(Boolean).join("\n") };
}
