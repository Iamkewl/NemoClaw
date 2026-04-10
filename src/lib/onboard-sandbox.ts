// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createOnboardSandboxHelpers(deps) {
  const {
    CONTROL_UI_PORT,
    DISCORD_SNOWFLAKE_RE,
    GATEWAY_NAME,
    ROOT,
    SCRIPTS,
    MESSAGING_CHANNELS,
    REMOTE_PROVIDER_CONFIG,
    agentOnboard,
    classifySandboxCreateFailure,
    ensureDashboardForward,
    fetchGatewayAuthTokenFromSandbox,
    formatEnvAssignment,
    getCredential,
    getSandboxStateFromOutputs,
    isNonInteractive,
    isRecreateSandbox,
    isSandboxReady,
    normalizeCredentialValue,
    note,
    openshellShellCommand,
    patchStagedDockerfile,
    printSandboxCreateRecoveryHints,
    promptOrDefault,
    providerExistsInGateway,
    registry,
    run,
    runCapture,
    runCaptureOpenshell,
    runOpenshell,
    secureTempFile,
    shellQuote,
    sleep,
    stageOptimizedSandboxBuildContext,
    step,
    streamSandboxCreate,
    upsertMessagingProviders,
    webSearch,
  } = deps;

  function getSandboxReuseState(sandboxName) {
    if (!sandboxName) return "missing";
    const getOutput = runCaptureOpenshell(["sandbox", "get", sandboxName], { ignoreError: true });
    const listOutput = runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
    return getSandboxStateFromOutputs(sandboxName, getOutput, listOutput);
  }

  function repairRecordedSandbox(sandboxName) {
    if (!sandboxName) return;
    note(`  [resume] Cleaning up recorded sandbox '${sandboxName}' before recreating it.`);
    runOpenshell(["forward", "stop", "18789"], { ignoreError: true });
    runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });
    registry.removeSandbox(sandboxName);
  }

  function sandboxExistsInGateway(sandboxName) {
    const output = runCaptureOpenshell(["sandbox", "get", sandboxName], { ignoreError: true });
    return Boolean(output);
  }

  function pruneStaleSandboxEntry(sandboxName) {
    const existing = registry.getSandbox(sandboxName);
    const liveExists = sandboxExistsInGateway(sandboxName);
    if (existing && !liveExists) {
      registry.removeSandbox(sandboxName);
    }
    return liveExists;
  }

  function buildSandboxConfigSyncScript(selectionConfig) {
    // openclaw.json is immutable (root:root 444, Landlock read-only) — never
    // write to it at runtime.  Model routing is handled by the host-side
    // gateway (`openshell inference set` in Step 5), not from inside the
    // sandbox.  We only write the NemoClaw selection config (~/.nemoclaw/).
    return `
set -euo pipefail
mkdir -p ~/.nemoclaw
cat > ~/.nemoclaw/config.json <<'EOF_NEMOCLAW_CFG'
${JSON.stringify(selectionConfig, null, 2)}
EOF_NEMOCLAW_CFG
exit
`.trim();
  }

  function isOpenclawReady(sandboxName) {
    return Boolean(fetchGatewayAuthTokenFromSandbox(sandboxName));
  }

  function writeSandboxConfigSyncFile(script) {
    const scriptFile = secureTempFile("nemoclaw-sync", ".sh");
    fs.writeFileSync(scriptFile, `${script}\n`, { mode: 0o600 });
    return scriptFile;
  }

  function waitForSandboxReady(sandboxName, attempts = 10, delaySeconds = 2) {
    for (let i = 0; i < attempts; i += 1) {
      const podPhase = runCaptureOpenshell(
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
      sleep(delaySeconds);
    }
    return false;
  }

  // parsePolicyPresetEnv — see urlUtils import above
  // isSafeModelId — see validation import above

  async function promptValidatedSandboxName() {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const nameAnswer = await promptOrDefault(
        "  Sandbox name (lowercase, starts with letter, hyphens ok) [my-assistant]: ",
        "NEMOCLAW_SANDBOX_NAME",
        "my-assistant",
      );
      const sandboxName = (nameAnswer || "my-assistant").trim().toLowerCase();

      // Validate: RFC 1123 subdomain — lowercase alphanumeric and hyphens,
      // must start with a letter (not a digit) to satisfy Kubernetes naming.
      if (/^[a-z]([a-z0-9-]*[a-z0-9])?$/.test(sandboxName)) {
        return sandboxName;
      }

      console.error(`  Invalid sandbox name: '${sandboxName}'`);
      if (/^[0-9]/.test(sandboxName)) {
        console.error("  Names must start with a letter, not a digit.");
      } else {
        console.error("  Names must be lowercase, contain only letters, numbers, and hyphens,");
        console.error("  must start with a letter, and end with a letter or number.");
      }

      // Non-interactive runs cannot re-prompt — abort so the caller can fix the
      // NEMOCLAW_SANDBOX_NAME env var and retry.
      if (isNonInteractive()) {
        process.exit(1);
      }

      if (attempt < MAX_ATTEMPTS - 1) {
        console.error("  Please try again.\n");
      }
    }

    console.error("  Too many invalid attempts.");
    process.exit(1);
  }

  // ── Step 5: Sandbox ──────────────────────────────────────────────

  // eslint-disable-next-line complexity

  async function createSandbox(
    gpu,
    model,
    provider,
    preferredInferenceApi = null,
    sandboxNameOverride = null,
    webSearchConfig = null,
    enabledChannels = null,
    fromDockerfile = null,
    agent = null,
    dangerouslySkipPermissions = false,
  ) {
    step(6, 8, "Creating sandbox");

    const sandboxName = sandboxNameOverride || (await promptValidatedSandboxName());
    const effectivePort = agent ? agent.forwardPort : CONTROL_UI_PORT;
    const chatUiUrl = process.env.CHAT_UI_URL || `http://127.0.0.1:${effectivePort}`;

    // Check whether messaging providers will be needed — this must happen before
    // the sandbox reuse decision so we can detect stale sandboxes that were created
    // without provider attachments (security: prevents legacy raw-env-var leaks).
    const getMessagingToken = (envKey) =>
      getCredential(envKey) || normalizeCredentialValue(process.env[envKey]) || null;

    // When enabledChannels is provided (from the toggle picker), only include
    // channels the user selected. When null (backward compat), include all.
    const enabledEnvKeys =
      enabledChannels != null
        ? new Set(
            MESSAGING_CHANNELS.filter((c) => enabledChannels.includes(c.name)).map((c) => c.envKey),
          )
        : null;

    const messagingTokenDefs = [
      {
        name: `${sandboxName}-discord-bridge`,
        envKey: "DISCORD_BOT_TOKEN",
        token: getMessagingToken("DISCORD_BOT_TOKEN"),
      },
      {
        name: `${sandboxName}-slack-bridge`,
        envKey: "SLACK_BOT_TOKEN",
        token: getMessagingToken("SLACK_BOT_TOKEN"),
      },
      {
        name: `${sandboxName}-telegram-bridge`,
        envKey: "TELEGRAM_BOT_TOKEN",
        token: getMessagingToken("TELEGRAM_BOT_TOKEN"),
      },
    ].filter(({ envKey }) => !enabledEnvKeys || enabledEnvKeys.has(envKey));
    const hasMessagingTokens = messagingTokenDefs.some(({ token }) => !!token);

    // Reconcile local registry state with the live OpenShell gateway state.
    const liveExists = pruneStaleSandboxEntry(sandboxName);

    if (liveExists) {
      const existingSandboxState = getSandboxReuseState(sandboxName);

      // Check whether messaging providers are missing from the gateway. Only
      // force recreation when at least one required provider doesn't exist yet —
      // this avoids destroying sandboxes already created with provider attachments.
      const needsProviderMigration =
        hasMessagingTokens &&
        messagingTokenDefs.some(({ name, token }) => token && !providerExistsInGateway(name));

      if (!isRecreateSandbox() && !needsProviderMigration) {
        if (isNonInteractive()) {
          if (existingSandboxState === "ready") {
            // Upsert messaging providers even on reuse so credential changes take
            // effect without requiring a full sandbox recreation.
            upsertMessagingProviders(messagingTokenDefs);
            note(`  [non-interactive] Sandbox '${sandboxName}' exists and is ready — reusing it`);
            note(
              "  Pass --recreate-sandbox or set NEMOCLAW_RECREATE_SANDBOX=1 to force recreation.",
            );
            ensureDashboardForward(sandboxName, chatUiUrl);
            return sandboxName;
          }
          console.error(`  Sandbox '${sandboxName}' already exists but is not ready.`);
          console.error(
            "  Pass --recreate-sandbox or set NEMOCLAW_RECREATE_SANDBOX=1 to overwrite.",
          );
          process.exit(1);
        }

        if (existingSandboxState === "ready") {
          console.log(`  Sandbox '${sandboxName}' already exists.`);
          console.log("  Choosing 'n' will delete the existing sandbox and create a new one.");
          const answer = await promptOrDefault("  Reuse existing sandbox? [Y/n]: ", null, "y");
          const normalizedAnswer = answer.trim().toLowerCase();
          if (normalizedAnswer !== "n" && normalizedAnswer !== "no") {
            upsertMessagingProviders(messagingTokenDefs);
            ensureDashboardForward(sandboxName, chatUiUrl);
            return sandboxName;
          }
        } else {
          console.log(`  Sandbox '${sandboxName}' exists but is not ready.`);
          console.log("  Selecting 'n' will abort onboarding.");
          const answer = await promptOrDefault(
            "  Delete it and create a new one? [Y/n]: ",
            null,
            "y",
          );
          const normalizedAnswer = answer.trim().toLowerCase();
          if (normalizedAnswer === "n" || normalizedAnswer === "no") {
            console.log("  Aborting onboarding.");
            process.exit(1);
          }
        }
      }

      if (needsProviderMigration) {
        console.log(`  Sandbox '${sandboxName}' exists but messaging providers are not attached.`);
        console.log("  Recreating to ensure credentials flow through the provider pipeline.");
      } else if (existingSandboxState === "ready") {
        note(`  Sandbox '${sandboxName}' exists and is ready — recreating by explicit request.`);
      } else {
        note(`  Sandbox '${sandboxName}' exists but is not ready — recreating it.`);
      }

      note(`  Deleting and recreating sandbox '${sandboxName}'...`);

      // Destroy old sandbox
      runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });
      registry.removeSandbox(sandboxName);
    }

    // Stage build context — use the custom Dockerfile path when provided,
    // otherwise use the optimised default that only sends what the build needs.
    let buildCtx, stagedDockerfile;
    if (fromDockerfile) {
      const fromResolved = path.resolve(fromDockerfile);
      if (!fs.existsSync(fromResolved)) {
        console.error(`  Custom Dockerfile not found: ${fromResolved}`);
        process.exit(1);
      }
      buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-"));
      stagedDockerfile = path.join(buildCtx, "Dockerfile");
      // Copy the entire parent directory as build context.
      fs.cpSync(path.dirname(fromResolved), buildCtx, {
        recursive: true,
        filter: (src) => {
          const base = path.basename(src);
          return !["node_modules", ".git", ".venv", "__pycache__"].includes(base);
        },
      });
      // If the caller pointed at a file not named "Dockerfile", copy it to the
      // location openshell expects (buildCtx/Dockerfile).
      if (path.basename(fromResolved) !== "Dockerfile") {
        fs.copyFileSync(fromResolved, stagedDockerfile);
      }
      console.log(`  Using custom Dockerfile: ${fromResolved}`);
    } else if (agent) {
      const agentBuild = agentOnboard.createAgentSandbox(agent);
      buildCtx = agentBuild.buildCtx;
      stagedDockerfile = agentBuild.stagedDockerfile;
    } else {
      ({ buildCtx, stagedDockerfile } = stageOptimizedSandboxBuildContext(ROOT));
    }

    // Create sandbox (use -- echo to avoid dropping into interactive shell)
    // Pass the base policy so sandbox starts in proxy mode (required for policy updates later)
    const globalPermissivePath = path.join(
      ROOT,
      "nemoclaw-blueprint",
      "policies",
      "openclaw-sandbox-permissive.yaml",
    );
    let basePolicyPath;
    if (dangerouslySkipPermissions) {
      // Permissive mode: use agent-specific permissive policy if available,
      // otherwise fall back to the global permissive policy.
      const agentPermissive = agent && agentOnboard.getAgentPermissivePolicyPath(agent);
      basePolicyPath = agentPermissive || globalPermissivePath;
    } else {
      const defaultPolicyPath = path.join(
        ROOT,
        "nemoclaw-blueprint",
        "policies",
        "openclaw-sandbox.yaml",
      );
      basePolicyPath = (agent && agentOnboard.getAgentPolicyPath(agent)) || defaultPolicyPath;
    }
    const createArgs = [
      "--from",
      `${buildCtx}/Dockerfile`,
      "--name",
      sandboxName,
      "--policy",
      basePolicyPath,
    ];
    // --gpu is intentionally omitted. See comment in startGateway().

    // Create OpenShell providers for messaging credentials so they flow through
    // the provider/placeholder system instead of raw env vars. The L7 proxy
    // rewrites Authorization headers (Bearer/Bot) and URL-path segments
    // (/bot{TOKEN}/) with real secrets at egress (OpenShell ≥ 0.0.20).
    const messagingProviders = upsertMessagingProviders(messagingTokenDefs);
    for (const p of messagingProviders) {
      createArgs.push("--provider", p);
    }

    console.log(`  Creating sandbox '${sandboxName}' (this takes a few minutes on first run)...`);
    if (webSearchConfig && !getCredential(webSearch.BRAVE_API_KEY_ENV)) {
      console.error(
        "  Brave Search is enabled, but BRAVE_API_KEY is not available in this process.",
      );
      console.error(
        "  Re-run with BRAVE_API_KEY set, or disable Brave Search before recreating the sandbox.",
      );
      process.exit(1);
    }
    const activeMessagingChannels = messagingTokenDefs
      .filter(({ token }) => !!token)
      .map(({ envKey }) => {
        if (envKey === "DISCORD_BOT_TOKEN") return "discord";
        if (envKey === "SLACK_BOT_TOKEN") return "slack";
        if (envKey === "TELEGRAM_BOT_TOKEN") return "telegram";
        return null;
      })
      .filter(Boolean);
    // Build allowed sender IDs map from env vars set during the messaging prompt.
    // Each channel with a userIdEnvKey in MESSAGING_CHANNELS may have a
    // comma-separated list of IDs (e.g. TELEGRAM_ALLOWED_IDS="123,456").
    const messagingAllowedIds = {};
    const enabledTokenEnvKeys = new Set(messagingTokenDefs.map(({ envKey }) => envKey));
    for (const ch of MESSAGING_CHANNELS) {
      if (
        enabledTokenEnvKeys.has(ch.envKey) &&
        ch.allowIdsMode === "dm" &&
        ch.userIdEnvKey &&
        process.env[ch.userIdEnvKey]
      ) {
        const ids = process.env[ch.userIdEnvKey]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (ids.length > 0) messagingAllowedIds[ch.name] = ids;
      }
    }
    const discordGuilds = {};
    if (enabledTokenEnvKeys.has("DISCORD_BOT_TOKEN")) {
      const serverIds = (process.env.DISCORD_SERVER_IDS || process.env.DISCORD_SERVER_ID || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const userIds = (process.env.DISCORD_ALLOWED_IDS || process.env.DISCORD_USER_ID || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const serverId of serverIds) {
        if (!DISCORD_SNOWFLAKE_RE.test(serverId)) {
          console.warn(
            `  Warning: Discord server ID '${serverId}' does not look like a snowflake.`,
          );
        }
      }
      for (const userId of userIds) {
        if (!DISCORD_SNOWFLAKE_RE.test(userId)) {
          console.warn(`  Warning: Discord user ID '${userId}' does not look like a snowflake.`);
        }
      }
      const requireMention = process.env.DISCORD_REQUIRE_MENTION !== "0";
      for (const serverId of serverIds) {
        discordGuilds[serverId] = {
          requireMention,
          ...(userIds.length > 0 ? { users: userIds } : {}),
        };
      }
    }
    patchStagedDockerfile(
      stagedDockerfile,
      model,
      chatUiUrl,
      String(Date.now()),
      provider,
      preferredInferenceApi,
      webSearchConfig,
      activeMessagingChannels,
      messagingAllowedIds,
      discordGuilds,
    );
    // Only pass non-sensitive env vars to the sandbox. Credentials flow through
    // OpenShell providers — the gateway injects them as placeholders and the L7
    // proxy rewrites Authorization headers with real secrets at egress.
    // See: crates/openshell-sandbox/src/secrets.rs (placeholder rewriting),
    //      crates/openshell-router/src/backend.rs (inference auth injection).
    const envArgs = [formatEnvAssignment("CHAT_UI_URL", chatUiUrl)];
    const blockedSandboxEnvNames = new Set([
      // Derived from REMOTE_PROVIDER_CONFIG to prevent drift
      ...Object.values(REMOTE_PROVIDER_CONFIG)
        .map((cfg) => cfg.credentialEnv)
        .filter(Boolean),
      // Additional credentials not in REMOTE_PROVIDER_CONFIG
      "BEDROCK_API_KEY",
      "DISCORD_BOT_TOKEN",
      "SLACK_BOT_TOKEN",
      "TELEGRAM_BOT_TOKEN",
    ]);
    const sandboxEnv = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !blockedSandboxEnvNames.has(name)),
    );
    // Run without piping through awk — the pipe masked non-zero exit codes
    // from openshell because bash returns the status of the last pipeline
    // command (awk, always 0) unless pipefail is set. Removing the pipe
    // lets the real exit code flow through to run().
    const createCommand = `${openshellShellCommand([
      "sandbox",
      "create",
      ...createArgs,
      "--",
      "env",
      ...envArgs,
      "nemoclaw-start",
    ])} 2>&1`;
    const createResult = await streamSandboxCreate(createCommand, sandboxEnv, {
      readyCheck: () => {
        const list = runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
        return isSandboxReady(list, sandboxName);
      },
    });

    // Clean up build context regardless of outcome
    run(`rm -rf "${buildCtx}"`, { ignoreError: true });

    if (createResult.status !== 0) {
      const failure = classifySandboxCreateFailure(createResult.output);
      if (failure.kind === "sandbox_create_incomplete") {
        // The sandbox was created in the gateway but the create stream exited
        // with a non-zero code (e.g. SSH 255).  Fall through to the ready-wait
        // loop — the sandbox may still reach Ready on its own.
        console.warn("");
        console.warn(
          `  Create stream exited with code ${createResult.status} after sandbox was created.`,
        );
        console.warn("  Checking whether the sandbox reaches Ready state...");
      } else {
        console.error("");
        console.error(`  Sandbox creation failed (exit ${createResult.status}).`);
        if (createResult.output) {
          console.error("");
          console.error(createResult.output);
        }
        console.error("  Try:  openshell sandbox list        # check gateway state");
        printSandboxCreateRecoveryHints(createResult.output);
        process.exit(createResult.status || 1);
      }
    }

    // Wait for sandbox to reach Ready state in k3s before registering.
    // On WSL2 + Docker Desktop the pod can take longer to initialize;
    // without this gate, NemoClaw registers a phantom sandbox that
    // causes "sandbox not found" on every subsequent connect/status call.
    console.log("  Waiting for sandbox to become ready...");
    let ready = false;
    for (let i = 0; i < 30; i++) {
      const list = runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
      if (isSandboxReady(list, sandboxName)) {
        ready = true;
        break;
      }
      sleep(2);
    }

    if (!ready) {
      // Clean up the orphaned sandbox so the next onboard retry with the same
      // name doesn't fail on "sandbox already exists".
      const delResult = runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });
      console.error("");
      console.error(`  Sandbox '${sandboxName}' was created but did not become ready within 60s.`);
      if (delResult.status === 0) {
        console.error("  The orphaned sandbox has been removed — you can safely retry.");
      } else {
        console.error(`  Could not remove the orphaned sandbox. Manual cleanup:`);
        console.error(`    openshell sandbox delete "${sandboxName}"`);
      }
      console.error("  Retry: nemoclaw onboard");
      process.exit(1);
    }

    // Wait for NemoClaw dashboard to become fully ready (web server live)
    // This prevents port forwards from connecting to a non-existent port
    // or seeing 502/503 errors during initial load.
    console.log("  Waiting for NemoClaw dashboard to become ready...");
    for (let i = 0; i < 15; i++) {
      const readyMatch = runCapture(
        `openshell sandbox exec ${shellQuote(sandboxName)} curl -sf http://localhost:18789/ 2>/dev/null || echo "no"`,
        { ignoreError: true },
      );
      if (readyMatch && !readyMatch.includes("no")) {
        console.log("  ✓ Dashboard is live");
        break;
      }
      if (i === 14) {
        console.warn("  Dashboard taking longer than expected to start. Continuing...");
      } else {
        sleep(2);
      }
    }

    // Release any stale forward on port 18789 before claiming it for the new sandbox.
    // A previous onboard run may have left the port forwarded to a different sandbox,
    // which would silently prevent the new sandbox's dashboard from being reachable.
    ensureDashboardForward(sandboxName, chatUiUrl);

    // Register only after confirmed ready — prevents phantom entries
    registry.registerSandbox({
      name: sandboxName,
      gpuEnabled: !!gpu,
      agent: agent ? agent.name : null,
      dangerouslySkipPermissions: dangerouslySkipPermissions || undefined,
    });

    // DNS proxy — run a forwarder in the sandbox pod so the isolated
    // sandbox namespace can resolve hostnames (fixes #626).
    console.log("  Setting up sandbox DNS proxy...");
    run(
      `bash "${path.join(SCRIPTS, "setup-dns-proxy.sh")}" ${shellQuote(GATEWAY_NAME)} ${shellQuote(sandboxName)} 2>&1 || true`,
      { ignoreError: true },
    );

    // Check that messaging providers exist in the gateway (sandbox attachment
    // cannot be verified via CLI yet — only gateway-level existence is checked).
    for (const p of messagingProviders) {
      if (!providerExistsInGateway(p)) {
        console.error(`  ⚠ Messaging provider '${p}' was not found in the gateway.`);
        console.error(`    The credential may not be available inside the sandbox.`);
        console.error(
          `    To fix: openshell provider create --name ${p} --type generic --credential <KEY>`,
        );
      }
    }

    console.log(`  ✓ Sandbox '${sandboxName}' created`);
    return sandboxName;
  }

  // ── Step 3: Inference selection ──────────────────────────────────

  // eslint-disable-next-line complexity

  return {
    buildSandboxConfigSyncScript,
    createSandbox,
    getSandboxReuseState,
    isOpenclawReady,
    pruneStaleSandboxEntry,
    promptValidatedSandboxName,
    repairRecordedSandbox,
    waitForSandboxReady,
    writeSandboxConfigSyncFile,
  };
}
