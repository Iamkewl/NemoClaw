// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Handler for the /nemoclaw slash command (chat interface).
 *
 * Supports subcommands:
 *   /nemoclaw status   - show sandbox/blueprint/inference state
 *   /nemoclaw eject    - rollback to host installation
 *   /nemoclaw memory   - show memory stats or delegate to subcommands
 *   /nemoclaw shields  - show shields status (read-only)
 *   /nemoclaw config   - show sandbox config (read-only, redacted)
 *   /nemoclaw          - show help
 */

import { existsSync, readFileSync } from "node:fs";
import type { PluginCommandContext, PluginCommandResult, OpenClawPluginApi } from "../index.js";
import { loadState } from "../blueprint/state.js";
import {
  describeOnboardEndpoint,
  describeOnboardProvider,
  loadOnboardConfig,
} from "../onboard/config.js";
import {
  INDEX_SOFT_CAP,
  TOPIC_SOFT_CAP,
  MEMORY_TYPES,
  MEMORY_INDEX_PATH,
} from "../memory/index.js";
import { isValidMemoryType, type MemoryType } from "../memory/index.js";
import { TypedMemoryProvider } from "../memory/typed-provider.js";
import {
  loadMemoryConfig,
  saveMemoryConfig,
  injectMemoryInstructions,
  removeMemoryInstructions,
} from "../memory/config.js";
import { slashShieldsStatus } from "./shields-status.js";
import { slashConfigShow } from "./config-show.js";

export function handleSlashCommand(
  ctx: PluginCommandContext,
  _api: OpenClawPluginApi,
): PluginCommandResult {
  const parts = ctx.args?.trim().split(/\s+/) ?? [];
  const subcommand = parts[0] ?? "";

  switch (subcommand) {
    case "status":
      return slashStatus();
    case "eject":
      return slashEject();
    case "onboard":
      return slashOnboard();
    case "memory":
      return slashMemoryRouter(parts.slice(1));
    case "shields":
      return slashShieldsStatus();
    case "config":
      return slashConfigShow();
    default:
      return slashHelp();
  }
}

function slashHelp(): PluginCommandResult {
  return {
    text: [
      "**NemoClaw**",
      "",
      "Usage: `/nemoclaw <subcommand>`",
      "",
      "Subcommands:",
      "  `status`          - Show sandbox, blueprint, and inference state",
      "  `shields`         - Show shields status (up/down, timeout, policy)",
      "  `config`          - Show sandbox configuration (credentials redacted)",
      "  `eject`           - Show rollback instructions",
      "  `onboard`         - Show onboarding status and instructions",
      "  `memory`          - Show memory index stats",
      "  `memory read`     - Read a topic: `/nemoclaw memory read <slug>`",
      "  `memory search`   - Search topics: `/nemoclaw memory search <query>`",
      "  `memory list`     - List entries: `/nemoclaw memory list [--type <type>]`",
      "  `memory migrate`  - Migrate flat MEMORY.md to typed index",
      "  `memory enable`   - Enable typed memory index (injects AGENTS.md instructions)",
      "  `memory disable`  - Disable typed memory index (removes AGENTS.md instructions)",
      "",
      "For full management use the NemoClaw CLI:",
      "  `nemoclaw <name> shields down|up|status`",
      "  `nemoclaw <name> config get`",
      "  `nemoclaw <name> status`",
      "  `nemoclaw <name> connect`",
      "  `nemoclaw <name> logs`",
      "  `nemoclaw <name> destroy`",
    ].join("\n"),
  };
}

function slashStatus(): PluginCommandResult {
  const state = loadState();

  if (!state.lastAction) {
    return {
      text: "**NemoClaw**: No operations performed yet. Run `nemoclaw onboard` to get started.",
    };
  }

  const lines = [
    "**NemoClaw Status**",
    "",
    `Last action: ${state.lastAction}`,
    `Blueprint: ${state.blueprintVersion ?? "unknown"}`,
    `Run ID: ${state.lastRunId ?? "none"}`,
    `Sandbox: ${state.sandboxName ?? "none"}`,
    `Updated: ${state.updatedAt}`,
  ];

  if (state.migrationSnapshot) {
    lines.push("", `Rollback snapshot: ${state.migrationSnapshot}`);
  }

  if (state.lastRebuildAt) {
    lines.push("", `Last rebuild: ${state.lastRebuildAt}`);
    if (state.lastRebuildBackupPath) {
      lines.push(`Rebuild backup: ${state.lastRebuildBackupPath}`);
    }
  }

  return { text: lines.join("\n") };
}

function slashOnboard(): PluginCommandResult {
  const config = loadOnboardConfig();
  if (config) {
    return {
      text: [
        "**NemoClaw Onboard Status**",
        "",
        `Endpoint: ${describeOnboardEndpoint(config)}`,
        `Provider: ${describeOnboardProvider(config)}`,
        config.ncpPartner ? `NCP Partner: ${config.ncpPartner}` : null,
        `Model: ${config.model}`,
        `Credential: $${config.credentialEnv}`,
        `Profile: ${config.profile}`,
        `Onboarded: ${config.onboardedAt}`,
        "",
        "To reconfigure, run: `nemoclaw onboard`",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  return {
    text: [
      "**NemoClaw Onboarding**",
      "",
      "No configuration found. Run the onboard command to set up inference:",
      "",
      "```",
      "nemoclaw onboard",
      "```",
    ].join("\n"),
  };
}

function slashMemoryRouter(args: string[]): PluginCommandResult {
  const sub = args[0] ?? "";
  const provider = new TypedMemoryProvider();

  switch (sub) {
    case "read":
      return slashMemoryRead(provider, args.slice(1).join(" ").trim());
    case "search":
      return slashMemorySearch(provider, args.slice(1).join(" ").trim());
    case "list":
      return slashMemoryList(provider, args);
    case "migrate":
      return slashMemoryMigrate(provider);
    case "enable":
      return slashMemoryEnable(provider);
    case "disable":
      return slashMemoryDisable();
    default:
      return slashMemoryStats(provider);
  }
}

function slashMemoryStats(provider: TypedMemoryProvider): PluginCommandResult {
  const config = loadMemoryConfig();
  const stats = provider.stats();

  const lines = [
    "**Memory Stats**",
    "",
    `Mode: ${config.mode}${config.enabledAt ? ` (since ${config.enabledAt})` : ""}`,
    `Index entries: ${String(stats.indexEntryCount)}${stats.indexOverCap ? ` (over ${String(INDEX_SOFT_CAP)} soft cap!)` : ""}`,
    `Index lines: ${String(stats.indexLineCount)}`,
    `Topic files: ${String(stats.topicCount)}`,
    "",
    "**By type:**",
    ...MEMORY_TYPES.map((t) => `  ${t}: ${String(stats.topicsByType[t])}`),
  ];

  if (stats.oversizedTopics.length > 0) {
    lines.push(
      "",
      `Oversized topics (>${String(TOPIC_SOFT_CAP)} lines): ${stats.oversizedTopics.join(", ")}`,
    );
  }

  return { text: lines.join("\n") };
}

function slashMemoryRead(provider: TypedMemoryProvider, slug: string): PluginCommandResult {
  if (!slug) {
    return { text: "Usage: `/nemoclaw memory read <slug>`" };
  }

  const topic = provider.load(slug);
  if (!topic) {
    return { text: `Memory topic \`${slug}\` not found.` };
  }

  const { frontmatter, body } = topic;
  const lines = [
    `**${frontmatter.name}**`,
    "",
    `Type: ${frontmatter.type}`,
    `Description: ${frontmatter.description}`,
    `Updated: ${frontmatter.updated}`,
    "",
    body.trim(),
  ];

  return { text: lines.join("\n") };
}

function slashMemorySearch(provider: TypedMemoryProvider, query: string): PluginCommandResult {
  if (!query) {
    return { text: "Usage: `/nemoclaw memory search <query>`" };
  }

  const results = provider.search(query);
  if (results.length === 0) {
    return { text: `No results found for query: \`${query}\`` };
  }

  const rows = results.map((e) => `| ${e.title} | ${e.slug} | ${e.type} | ${e.updatedAt} |`);

  return {
    text: [
      `**Memory Search: ${query}**`,
      "",
      "| Title | Slug | Type | Updated |",
      "|---|---|---|---|",
      ...rows,
    ].join("\n"),
  };
}

function slashMemoryList(provider: TypedMemoryProvider, args: string[]): PluginCommandResult {
  let filter: { type?: MemoryType } | undefined;

  const typeIdx = args.indexOf("--type");
  if (typeIdx !== -1) {
    const typeVal = args[typeIdx + 1];
    if (typeVal && isValidMemoryType(typeVal)) {
      filter = { type: typeVal };
    }
  }

  const entries = provider.list(filter);

  if (entries.length === 0) {
    const typeMsg = filter?.type ? ` of type \`${filter.type}\`` : "";
    return { text: `No memory entries found${typeMsg}.` };
  }

  const rows = entries.map((e) => `| ${e.title} | ${e.slug} | ${e.type} | ${e.updatedAt} |`);

  return {
    text: [
      "**Memory Index**",
      "",
      "| Title | Slug | Type | Updated |",
      "|---|---|---|---|",
      ...rows,
    ].join("\n"),
  };
}

function slashMemoryMigrate(provider: TypedMemoryProvider): PluginCommandResult {
  if (!existsSync(MEMORY_INDEX_PATH)) {
    return { text: "Nothing to migrate: MEMORY.md does not exist." };
  }

  const content = readFileSync(MEMORY_INDEX_PATH, "utf-8");

  if (!content.trim()) {
    return { text: "Nothing to migrate: MEMORY.md is empty." };
  }

  if (content.includes("| Topic | Type | Updated |")) {
    return {
      text: "Memory index already exists (typed index detected). Migration skipped.",
    };
  }

  const result = provider.migrate(content);
  return {
    text: [
      "**Memory Migration Complete**",
      "",
      `Imported: ${String(result.imported)}`,
      `Skipped: ${String(result.skipped)}`,
    ].join("\n"),
  };
}

function slashMemoryEnable(provider: TypedMemoryProvider): PluginCommandResult {
  const config = loadMemoryConfig();
  if (config.mode === "typed-index") {
    return { text: "Typed memory index is already enabled." };
  }

  // Inject instructions into AGENTS.md
  injectMemoryInstructions();

  // Save config
  saveMemoryConfig({ mode: "typed-index", enabledAt: new Date().toISOString().slice(0, 10) });

  // Check if flat MEMORY.md exists and offer migration
  const lines = [
    "**Typed Memory Index Enabled**",
    "",
    "Memory instructions injected into AGENTS.md.",
    "The agent will now use the index-then-load pattern.",
  ];

  if (existsSync(MEMORY_INDEX_PATH)) {
    const content = readFileSync(MEMORY_INDEX_PATH, "utf-8");
    if (content.trim() && !content.includes("| Topic | Type | Updated |")) {
      const result = provider.migrate(content);
      lines.push(
        "",
        `Migrated existing MEMORY.md: ${String(result.imported)} imported, ${String(result.skipped)} skipped.`,
      );
    }
  }

  return { text: lines.join("\n") };
}

function slashMemoryDisable(): PluginCommandResult {
  const config = loadMemoryConfig();
  if (config.mode === "default") {
    return { text: "Typed memory index is already disabled. Using default memory." };
  }

  // Remove instructions from AGENTS.md
  removeMemoryInstructions();

  // Save config
  saveMemoryConfig({ mode: "default" });

  return {
    text: [
      "**Typed Memory Index Disabled**",
      "",
      "Memory instructions removed from AGENTS.md.",
      "The agent will use OpenClaw's default memory behavior.",
      "",
      "Topic files are still on disk and can be re-enabled at any time.",
    ].join("\n"),
  };
}

function slashEject(): PluginCommandResult {
  const state = loadState();

  if (!state.lastAction) {
    return { text: "No NemoClaw deployment found. Nothing to eject from." };
  }

  if (!state.migrationSnapshot && !state.hostBackupPath) {
    return {
      text: "No migration snapshot found. Manual rollback required.",
    };
  }

  return {
    text: [
      "**Eject from NemoClaw**",
      "",
      "To rollback to your host OpenClaw installation, run:",
      "",
      "```",
      "nemoclaw <name> destroy",
      "```",
      "",
      `Snapshot: ${state.migrationSnapshot ?? state.hostBackupPath ?? "none"}`,
    ].join("\n"),
  };
}
