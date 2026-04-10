// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function createOnboardMessagingHelpers(deps) {
  const {
    getCredential,
    isNonInteractive,
    normalizeCredentialValue,
    note,
    prompt,
    saveCredential,
    step,
  } = deps;

  const MESSAGING_CHANNELS = [
    {
      name: "telegram",
      envKey: "TELEGRAM_BOT_TOKEN",
      description: "Telegram bot messaging",
      help: "Create a bot via @BotFather on Telegram, then copy the token.",
      label: "Telegram Bot Token",
      userIdEnvKey: "TELEGRAM_ALLOWED_IDS",
      userIdHelp: "Send /start to @userinfobot on Telegram to get your numeric user ID.",
      userIdLabel: "Telegram User ID (for DM access)",
      allowIdsMode: "dm",
    },
    {
      name: "discord",
      envKey: "DISCORD_BOT_TOKEN",
      description: "Discord bot messaging",
      help: "Discord Developer Portal → Applications → Bot → Reset/Copy Token.",
      label: "Discord Bot Token",
      serverIdEnvKey: "DISCORD_SERVER_ID",
      serverIdHelp:
        "Enable Developer Mode in Discord, then right-click your server and copy the Server ID.",
      serverIdLabel: "Discord Server ID (for guild workspace access)",
      requireMentionEnvKey: "DISCORD_REQUIRE_MENTION",
      requireMentionHelp:
        "Choose whether the bot should reply only when @mentioned or to all messages in this server.",
      userIdEnvKey: "DISCORD_USER_ID",
      userIdHelp:
        "Optional: enable Developer Mode in Discord, then right-click your user/avatar and copy the User ID. Leave blank to allow any member of the configured server to message the bot.",
      userIdLabel: "Discord User ID (optional guild allowlist)",
      allowIdsMode: "guild",
    },
    {
      name: "slack",
      envKey: "SLACK_BOT_TOKEN",
      description: "Slack bot messaging",
      help: "Slack API → Your Apps → OAuth & Permissions → Bot User OAuth Token (xoxb-...).",
      label: "Slack Bot Token",
    },
  ];

  async function setupMessagingChannels() {
    step(5, 8, "Messaging channels");

    const getMessagingToken = (envKey) =>
      getCredential(envKey) || normalizeCredentialValue(process.env[envKey]) || null;

    if (isNonInteractive() || process.env.NEMOCLAW_NON_INTERACTIVE === "1") {
      const found = MESSAGING_CHANNELS.filter((c) => getMessagingToken(c.envKey)).map(
        (c) => c.name,
      );
      if (found.length > 0) {
        note(`  [non-interactive] Messaging tokens detected: ${found.join(", ")}`);
      } else {
        note("  [non-interactive] No messaging tokens configured. Skipping.");
      }
      return found;
    }

    const enabled = new Set(
      MESSAGING_CHANNELS.filter((c) => getMessagingToken(c.envKey)).map((c) => c.name),
    );

    const output = process.stderr;
    const linesAbovePrompt = MESSAGING_CHANNELS.length + 3;
    let firstDraw = true;
    const showList = () => {
      if (!firstDraw) {
        output.write(`\r\x1b[${linesAbovePrompt}A\x1b[J`);
      }
      firstDraw = false;
      output.write("\n");
      output.write("  Available messaging channels:\n");
      MESSAGING_CHANNELS.forEach((ch, i) => {
        const marker = enabled.has(ch.name) ? "●" : "○";
        const status = getMessagingToken(ch.envKey) ? " (configured)" : "";
        output.write(`    [${i + 1}] ${marker} ${ch.name} — ${ch.description}${status}\n`);
      });
      output.write("\n");
      output.write("  Press 1-3 to toggle, Enter when done: ");
    };

    showList();

    await new Promise((resolve, reject) => {
      const input = process.stdin;
      let rawModeEnabled = false;
      let finished = false;

      function cleanup() {
        input.removeListener("data", onData);
        if (rawModeEnabled && typeof input.setRawMode === "function") {
          input.setRawMode(false);
        }
      }

      function finish() {
        if (finished) return;
        finished = true;
        cleanup();
        output.write("\n");
        resolve();
      }

      function onData(chunk) {
        const text = chunk.toString("utf8");
        for (let i = 0; i < text.length; i += 1) {
          const ch = text[i];
          if (ch === "\u0003") {
            cleanup();
            reject(Object.assign(new Error("Prompt interrupted"), { code: "SIGINT" }));
            process.kill(process.pid, "SIGINT");
            return;
          }
          if (ch === "\r" || ch === "\n") {
            finish();
            return;
          }
          const num = parseInt(ch, 10);
          if (num >= 1 && num <= MESSAGING_CHANNELS.length) {
            const channel = MESSAGING_CHANNELS[num - 1];
            if (enabled.has(channel.name)) {
              enabled.delete(channel.name);
            } else {
              enabled.add(channel.name);
            }
            showList();
          }
        }
      }

      input.setEncoding("utf8");
      if (typeof input.resume === "function") {
        input.resume();
      }
      if (typeof input.setRawMode === "function") {
        input.setRawMode(true);
        rawModeEnabled = true;
      }
      input.on("data", onData);
    });

    const selected = Array.from(enabled);
    if (selected.length === 0) {
      console.log("  Skipping messaging channels.");
      return [];
    }

    for (const name of selected) {
      const ch = MESSAGING_CHANNELS.find((c) => c.name === name);
      if (!ch) {
        console.log(`  Unknown channel: ${name}`);
        continue;
      }
      if (getMessagingToken(ch.envKey)) {
        console.log(`  ✓ ${ch.name} — already configured`);
      } else {
        console.log("");
        console.log(`  ${ch.help}`);
        const token = normalizeCredentialValue(await prompt(`  ${ch.label}: `, { secret: true }));
        if (token) {
          saveCredential(ch.envKey, token);
          process.env[ch.envKey] = token;
          console.log(`  ✓ ${ch.name} token saved`);
        } else {
          console.log(`  Skipped ${ch.name} (no token entered)`);
          continue;
        }
      }
      if (ch.serverIdEnvKey) {
        const existingServerIds = process.env[ch.serverIdEnvKey] || "";
        if (existingServerIds) {
          console.log(`  ✓ ${ch.name} — server ID already set: ${existingServerIds}`);
        } else {
          console.log(`  ${ch.serverIdHelp}`);
          const serverId = (await prompt(`  ${ch.serverIdLabel}: `)).trim();
          if (serverId) {
            process.env[ch.serverIdEnvKey] = serverId;
            console.log(`  ✓ ${ch.name} server ID saved`);
          } else {
            console.log(`  Skipped ${ch.name} server ID (guild channels stay disabled)`);
          }
        }
      }
      if (ch.requireMentionEnvKey && ch.serverIdEnvKey && process.env[ch.serverIdEnvKey]) {
        const existingRequireMention = process.env[ch.requireMentionEnvKey];
        if (existingRequireMention === "0" || existingRequireMention === "1") {
          const mode = existingRequireMention === "0" ? "all messages" : "@mentions only";
          console.log(`  ✓ ${ch.name} — reply mode already set: ${mode}`);
        } else {
          console.log(`  ${ch.requireMentionHelp}`);
          const answer = (await prompt("  Reply only when @mentioned? [Y/n]: "))
            .trim()
            .toLowerCase();
          process.env[ch.requireMentionEnvKey] = answer === "n" || answer === "no" ? "0" : "1";
          const mode =
            process.env[ch.requireMentionEnvKey] === "0" ? "all messages" : "@mentions only";
          console.log(`  ✓ ${ch.name} reply mode saved: ${mode}`);
        }
      }
      if (ch.userIdEnvKey && (!ch.serverIdEnvKey || process.env[ch.serverIdEnvKey])) {
        const existingIds = process.env[ch.userIdEnvKey] || "";
        if (existingIds) {
          console.log(`  ✓ ${ch.name} — allowed IDs already set: ${existingIds}`);
        } else {
          console.log(`  ${ch.userIdHelp}`);
          const userId = (await prompt(`  ${ch.userIdLabel}: `)).trim();
          if (userId) {
            process.env[ch.userIdEnvKey] = userId;
            console.log(`  ✓ ${ch.name} user ID saved`);
          } else {
            const skippedReason =
              ch.allowIdsMode === "guild"
                ? "any member in the configured server can message the bot"
                : "bot will require manual pairing";
            console.log(`  Skipped ${ch.name} user ID (${skippedReason})`);
          }
        }
      }
    }
    console.log("");
    return selected;
  }

  return {
    MESSAGING_CHANNELS,
    setupMessagingChannels,
  };
}
