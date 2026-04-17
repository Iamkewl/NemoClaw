// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PluginCommandContext, OpenClawPluginApi } from "../index.js";
import type { NemoClawState } from "../blueprint/state.js";
import type { NemoClawOnboardConfig } from "../onboard/config.js";

// ---------------------------------------------------------------------------
// Hoist mockProvider so vi.mock factories can reference it
// ---------------------------------------------------------------------------

const mockProvider = vi.hoisted(() => ({
  load: vi.fn(),
  search: vi.fn(),
  list: vi.fn(),
  migrate: vi.fn(),
  stats: vi.fn(),
  context: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("../blueprint/state.js", () => ({
  loadState: vi.fn(),
}));

vi.mock("../onboard/config.js", () => ({
  loadOnboardConfig: vi.fn(),
  describeOnboardEndpoint: vi.fn(),
  describeOnboardProvider: vi.fn(),
}));

vi.mock("../memory/index.js", () => ({
  getMemoryStats: vi.fn(),
  INDEX_SOFT_CAP: 200,
  TOPIC_SOFT_CAP: 500,
  MEMORY_TYPES: ["user", "project", "feedback", "reference"],
  MEMORY_INDEX_PATH: "/sandbox/.openclaw/workspace/MEMORY.md",
  isValidMemoryType: (v: string) => ["user", "project", "feedback", "reference"].includes(v),
}));

vi.mock("../memory/typed-provider.js", () => ({
  TypedMemoryProvider: vi.fn(function () {
    return mockProvider;
  }),
}));

const mockMemoryConfig = vi.hoisted(() => ({
  loadMemoryConfig: vi.fn(),
  saveMemoryConfig: vi.fn(),
  hasMemoryInstructions: vi.fn(),
  injectMemoryInstructions: vi.fn(),
  removeMemoryInstructions: vi.fn(),
}));

vi.mock("../memory/config.js", () => mockMemoryConfig);

vi.mock("./shields-status.js", () => ({
  slashShieldsStatus: vi.fn(() => ({ text: "**Shields: UP**" })),
}));

vi.mock("./config-show.js", () => ({
  slashConfigShow: vi.fn(() => ({ text: "**NemoClaw Config**" })),
}));

// ---------------------------------------------------------------------------
// Mock node:fs for slashMemoryMigrate
// ---------------------------------------------------------------------------

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { handleSlashCommand } from "./slash.js";
import { loadState } from "../blueprint/state.js";
import {
  loadOnboardConfig,
  describeOnboardEndpoint,
  describeOnboardProvider,
} from "../onboard/config.js";
import { getMemoryStats } from "../memory/index.js";
import type { MemoryStats } from "../memory/index.js";
import { existsSync, readFileSync } from "node:fs";

const mockedLoadState = vi.mocked(loadState);
const mockedLoadOnboardConfig = vi.mocked(loadOnboardConfig);
const mockedDescribeOnboardEndpoint = vi.mocked(describeOnboardEndpoint);
const mockedDescribeOnboardProvider = vi.mocked(describeOnboardProvider);
const mockedGetMemoryStats = vi.mocked(getMemoryStats);
const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);

function makeCtx(args?: string): PluginCommandContext {
  return {
    channel: "test-channel",
    isAuthorizedSender: true,
    args,
    commandBody: `/nemoclaw${args ? ` ${args}` : ""}`,
    config: {},
  };
}

function makeApi(): OpenClawPluginApi {
  return {
    id: "nemoclaw",
    name: "NemoClaw",
    config: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    registerCommand: vi.fn(),
    registerProvider: vi.fn(),
    registerService: vi.fn(),
    resolvePath: vi.fn((p: string) => p),
    on: vi.fn(),
  };
}

function blankState(): NemoClawState {
  return {
    lastRunId: null,
    lastAction: null,
    blueprintVersion: null,
    sandboxName: null,
    migrationSnapshot: null,
    hostBackupPath: null,
    createdAt: null,
    updatedAt: new Date().toISOString(),
    lastRebuildAt: null,
    lastRebuildBackupPath: null,
    shieldsDown: false,
    shieldsDownAt: null,
    shieldsDownTimeout: null,
    shieldsDownReason: null,
    shieldsDownPolicy: null,
    shieldsPolicySnapshotPath: null,
  };
}

function blankStats(): MemoryStats {
  return {
    indexEntryCount: 0,
    indexLineCount: 0,
    indexOverCap: false,
    topicCount: 0,
    topicsByType: { user: 0, project: 0, feedback: 0, reference: 0 },
    oversizedTopics: [],
  };
}

describe("commands/slash", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedLoadState.mockReturnValue(blankState());
    mockedLoadOnboardConfig.mockReturnValue(null);
    mockedGetMemoryStats.mockReturnValue(blankStats());
    mockProvider.stats.mockReturnValue(blankStats());
    mockProvider.load.mockReturnValue(null);
    mockProvider.search.mockReturnValue([]);
    mockProvider.list.mockReturnValue([]);
    mockProvider.migrate.mockReturnValue({ imported: 0, skipped: 0 });
    mockedExistsSync.mockReturnValue(false);
    mockedReadFileSync.mockReturnValue("");
    mockMemoryConfig.loadMemoryConfig.mockReturnValue({ mode: "default" });
    mockMemoryConfig.hasMemoryInstructions.mockReturnValue(false);
  });

  // -------------------------------------------------------------------------
  // help (default)
  // -------------------------------------------------------------------------

  describe("help", () => {
    it("returns help text for empty args", () => {
      const result = handleSlashCommand(makeCtx(), makeApi());
      expect(result.text).toContain("NemoClaw");
      expect(result.text).toContain("Subcommands:");
      expect(result.text).toContain("status");
      expect(result.text).toContain("shields");
      expect(result.text).toContain("config");
      expect(result.text).toContain("eject");
      expect(result.text).toContain("onboard");
      expect(result.text).toContain("memory");
      expect(result.text).toContain("memory read");
      expect(result.text).toContain("memory search");
      expect(result.text).toContain("memory list");
      expect(result.text).toContain("memory migrate");
    });

    it("returns help text for unknown subcommand", () => {
      const result = handleSlashCommand(makeCtx("unknown"), makeApi());
      expect(result.text).toContain("Subcommands:");
    });
  });

  // -------------------------------------------------------------------------
  // shields (routing)
  // -------------------------------------------------------------------------

  describe("shields", () => {
    it("routes to shields status handler", () => {
      const result = handleSlashCommand(makeCtx("shields"), makeApi());
      expect(result.text).toContain("Shields");
    });
  });

  // -------------------------------------------------------------------------
  // config (routing)
  // -------------------------------------------------------------------------

  describe("config", () => {
    it("routes to config show handler", () => {
      const result = handleSlashCommand(makeCtx("config"), makeApi());
      expect(result.text).toContain("Config");
    });
  });

  // -------------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------------

  describe("status", () => {
    it("reports no operations when state is blank", () => {
      const result = handleSlashCommand(makeCtx("status"), makeApi());
      expect(result.text).toContain("No operations performed yet");
    });

    it("reports state when last action exists", () => {
      mockedLoadState.mockReturnValue({
        ...blankState(),
        lastRunId: "run-123",
        lastAction: "deploy",
        blueprintVersion: "1.0.0",
        sandboxName: "test-sandbox",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      });
      const result = handleSlashCommand(makeCtx("status"), makeApi());
      expect(result.text).toContain("Last action: deploy");
      expect(result.text).toContain("Blueprint: 1.0.0");
      expect(result.text).toContain("Run ID: run-123");
      expect(result.text).toContain("Sandbox: test-sandbox");
    });

    it("includes rebuild info when present", () => {
      mockedLoadState.mockReturnValue({
        ...blankState(),
        lastRunId: "run-789",
        lastAction: "rebuild",
        blueprintVersion: "2.0.0",
        sandboxName: "sb",
        lastRebuildAt: "2026-04-15T10:00:00Z",
        lastRebuildBackupPath: "/backups/rebuild-001",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      });
      const result = handleSlashCommand(makeCtx("status"), makeApi());
      expect(result.text).toContain("Last rebuild: 2026-04-15T10:00:00Z");
      expect(result.text).toContain("Rebuild backup: /backups/rebuild-001");
    });

    it("includes rollback snapshot when present", () => {
      mockedLoadState.mockReturnValue({
        ...blankState(),
        lastRunId: "run-456",
        lastAction: "migrate",
        blueprintVersion: "2.0.0",
        sandboxName: "sb",
        migrationSnapshot: "/snapshots/snap-001",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      });
      const result = handleSlashCommand(makeCtx("status"), makeApi());
      expect(result.text).toContain("Rollback snapshot: /snapshots/snap-001");
    });
  });

  // -------------------------------------------------------------------------
  // eject
  // -------------------------------------------------------------------------

  describe("eject", () => {
    it("reports nothing to eject when state is blank", () => {
      const result = handleSlashCommand(makeCtx("eject"), makeApi());
      expect(result.text).toContain("No NemoClaw deployment found");
    });

    it("reports manual rollback required when no snapshot exists", () => {
      mockedLoadState.mockReturnValue({
        ...blankState(),
        lastRunId: "run-1",
        lastAction: "deploy",
        blueprintVersion: "1.0.0",
        sandboxName: "sb",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      });
      const result = handleSlashCommand(makeCtx("eject"), makeApi());
      expect(result.text).toContain("Manual rollback required");
    });

    it("shows eject instructions when migration snapshot exists", () => {
      mockedLoadState.mockReturnValue({
        ...blankState(),
        lastRunId: "run-1",
        lastAction: "migrate",
        blueprintVersion: "1.0.0",
        sandboxName: "sb",
        migrationSnapshot: "/snapshots/snap-001",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      });
      const result = handleSlashCommand(makeCtx("eject"), makeApi());
      expect(result.text).toContain("Eject from NemoClaw");
      expect(result.text).toContain("nemoclaw <name> destroy");
      expect(result.text).toContain("Snapshot: /snapshots/snap-001");
    });

    it("uses hostBackupPath when migrationSnapshot is absent", () => {
      mockedLoadState.mockReturnValue({
        ...blankState(),
        lastRunId: "run-1",
        lastAction: "deploy",
        blueprintVersion: "1.0.0",
        sandboxName: "sb",
        hostBackupPath: "/backups/backup-001",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      });
      const result = handleSlashCommand(makeCtx("eject"), makeApi());
      expect(result.text).toContain("Snapshot: /backups/backup-001");
    });
  });

  // -------------------------------------------------------------------------
  // onboard
  // -------------------------------------------------------------------------

  describe("onboard", () => {
    it("shows setup instructions when no config exists", () => {
      const result = handleSlashCommand(makeCtx("onboard"), makeApi());
      expect(result.text).toContain("No configuration found");
      expect(result.text).toContain("nemoclaw onboard");
    });

    it("shows onboard status when config exists", () => {
      const config = {
        endpointType: "build" as const,
        endpointUrl: "https://api.build.nvidia.com/v1",
        ncpPartner: null,
        model: "nvidia/nemotron-3-super-120b-a12b",
        profile: "default",
        credentialEnv: "NVIDIA_API_KEY",
        onboardedAt: "2026-03-01T00:00:00.000Z",
      };
      mockedLoadOnboardConfig.mockReturnValue(config);
      mockedDescribeOnboardEndpoint.mockReturnValue("build (https://api.build.nvidia.com/v1)");
      mockedDescribeOnboardProvider.mockReturnValue("NVIDIA Endpoint API");
      const result = handleSlashCommand(makeCtx("onboard"), makeApi());
      expect(result.text).toContain("NemoClaw Onboard Status");
      expect(result.text).toContain("NVIDIA Endpoint API");
      expect(result.text).toContain("nvidia/nemotron-3-super-120b-a12b");
      expect(result.text).toContain("NVIDIA_API_KEY");
    });

    it("includes NCP partner when set", () => {
      const config: NemoClawOnboardConfig = {
        endpointType: "ncp",
        endpointUrl: "https://partner.example.com/v1",
        ncpPartner: "PartnerCo",
        model: "nvidia/nemotron-3-super-120b-a12b",
        profile: "default",
        credentialEnv: "NVIDIA_API_KEY",
        onboardedAt: "2026-03-01T00:00:00.000Z",
      };
      mockedLoadOnboardConfig.mockReturnValue(config);
      mockedDescribeOnboardEndpoint.mockReturnValue("ncp (https://partner.example.com/v1)");
      mockedDescribeOnboardProvider.mockReturnValue("NVIDIA Cloud Partner");
      const result = handleSlashCommand(makeCtx("onboard"), makeApi());
      expect(result.text).toContain("NCP Partner: PartnerCo");
    });
  });

  // -------------------------------------------------------------------------
  // memory (stats — no subcommand)
  // -------------------------------------------------------------------------

  describe("memory", () => {
    it("returns stats for empty memory", () => {
      const result = handleSlashCommand(makeCtx("memory"), makeApi());
      expect(result.text).toContain("Memory Stats");
      expect(result.text).toContain("Index entries: 0");
      expect(result.text).toContain("Topic files: 0");
    });

    it("returns stats with type breakdown", () => {
      mockProvider.stats.mockReturnValue({
        indexEntryCount: 5,
        indexLineCount: 12,
        indexOverCap: false,
        topicCount: 5,
        topicsByType: { user: 2, project: 1, feedback: 1, reference: 1 },
        oversizedTopics: [],
      });
      const result = handleSlashCommand(makeCtx("memory"), makeApi());
      expect(result.text).toContain("Index entries: 5");
      expect(result.text).toContain("user: 2");
      expect(result.text).toContain("project: 1");
    });

    it("shows over-cap warning", () => {
      mockProvider.stats.mockReturnValue({
        indexEntryCount: 201,
        indexLineCount: 210,
        indexOverCap: true,
        topicCount: 201,
        topicsByType: { user: 201, project: 0, feedback: 0, reference: 0 },
        oversizedTopics: [],
      });
      const result = handleSlashCommand(makeCtx("memory"), makeApi());
      expect(result.text).toContain("over 200 soft cap!");
    });

    it("lists oversized topics", () => {
      mockProvider.stats.mockReturnValue({
        indexEntryCount: 2,
        indexLineCount: 8,
        indexOverCap: false,
        topicCount: 2,
        topicsByType: { user: 1, project: 1, feedback: 0, reference: 0 },
        oversizedTopics: ["big-topic", "huge-topic"],
      });
      const result = handleSlashCommand(makeCtx("memory"), makeApi());
      expect(result.text).toContain("Oversized topics");
      expect(result.text).toContain("big-topic");
      expect(result.text).toContain("huge-topic");
    });
  });

  // -------------------------------------------------------------------------
  // memory read
  // -------------------------------------------------------------------------

  describe("memory read", () => {
    it("returns topic content when found", () => {
      mockProvider.load.mockReturnValue({
        frontmatter: {
          name: "My Topic",
          description: "A description",
          type: "user",
          created: "2026-03-01T00:00:00.000Z",
          updated: "2026-03-01T00:00:00.000Z",
        },
        body: "This is the body content.",
      });
      const result = handleSlashCommand(makeCtx("memory read my-topic"), makeApi());
      expect(result.text).toContain("My Topic");
      expect(result.text).toContain("This is the body content.");
    });

    it("returns not found for missing slug", () => {
      mockProvider.load.mockReturnValue(null);
      const result = handleSlashCommand(makeCtx("memory read missing-slug"), makeApi());
      expect(result.text).toContain("not found");
    });

    it("returns usage when no slug provided", () => {
      const result = handleSlashCommand(makeCtx("memory read"), makeApi());
      expect(result.text).toContain("Usage");
    });
  });

  // -------------------------------------------------------------------------
  // memory search
  // -------------------------------------------------------------------------

  describe("memory search", () => {
    it("returns matching entries", () => {
      mockProvider.search.mockReturnValue([
        { slug: "topic-one", title: "Topic One", type: "user", updatedAt: "2026-03-01" },
        { slug: "topic-two", title: "Topic Two", type: "project", updatedAt: "2026-03-02" },
      ]);
      const result = handleSlashCommand(makeCtx("memory search topic"), makeApi());
      expect(result.text).toContain("Topic One");
      expect(result.text).toContain("Topic Two");
    });

    it("returns no results for no matches", () => {
      mockProvider.search.mockReturnValue([]);
      const result = handleSlashCommand(makeCtx("memory search nothinghere"), makeApi());
      expect(result.text).toContain("No results");
    });

    it("returns usage when no query provided", () => {
      const result = handleSlashCommand(makeCtx("memory search"), makeApi());
      expect(result.text).toContain("Usage");
    });
  });

  // -------------------------------------------------------------------------
  // memory list
  // -------------------------------------------------------------------------

  describe("memory list", () => {
    it("lists all entries", () => {
      mockProvider.list.mockReturnValue([
        { slug: "entry-a", title: "Entry A", type: "user", updatedAt: "2026-03-01" },
        { slug: "entry-b", title: "Entry B", type: "reference", updatedAt: "2026-03-02" },
      ]);
      const result = handleSlashCommand(makeCtx("memory list"), makeApi());
      expect(result.text).toContain("Entry A");
      expect(result.text).toContain("Entry B");
    });

    it("filters by type", () => {
      mockProvider.list.mockReturnValue([
        { slug: "user-entry", title: "User Entry", type: "user", updatedAt: "2026-03-01" },
      ]);
      const result = handleSlashCommand(makeCtx("memory list --type user"), makeApi());
      expect(result.text).toContain("User Entry");
      expect(mockProvider.list).toHaveBeenCalledWith({ type: "user" });
    });

    it("returns empty message when no entries", () => {
      mockProvider.list.mockReturnValue([]);
      const result = handleSlashCommand(makeCtx("memory list"), makeApi());
      expect(result.text).toContain("No memory entries found");
    });
  });

  // -------------------------------------------------------------------------
  // memory migrate
  // -------------------------------------------------------------------------

  describe("memory migrate", () => {
    it("reports migration results", () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(
        "- Some flat memory entry\n- Another entry\n- Third entry\n- skip this",
      );
      mockProvider.migrate.mockReturnValue({ imported: 3, skipped: 1 });
      const result = handleSlashCommand(makeCtx("memory migrate"), makeApi());
      expect(result.text).toContain("3");
      expect(result.text).toContain("1");
    });

    it("warns when index already has typed table", () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(
        "| Topic | Type | Updated |\n|---|---|---|\n| Foo | user | 2026-01-01 |",
      );
      const result = handleSlashCommand(makeCtx("memory migrate"), makeApi());
      expect(result.text).toContain("already exists");
    });

    it("says nothing to migrate when file does not exist", () => {
      mockedExistsSync.mockReturnValue(false);
      const result = handleSlashCommand(makeCtx("memory migrate"), makeApi());
      expect(result.text).toContain("Nothing to migrate");
    });

    it("says nothing to migrate when file is empty", () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue("   ");
      const result = handleSlashCommand(makeCtx("memory migrate"), makeApi());
      expect(result.text).toContain("Nothing to migrate");
    });
  });

  // -------------------------------------------------------------------------
  // memory stats — mode display
  // -------------------------------------------------------------------------

  describe("memory stats mode", () => {
    it("shows default mode", () => {
      mockMemoryConfig.loadMemoryConfig.mockReturnValue({ mode: "default" });
      const result = handleSlashCommand(makeCtx("memory"), makeApi());
      expect(result.text).toContain("Mode: default");
    });

    it("shows typed-index mode with date", () => {
      mockMemoryConfig.loadMemoryConfig.mockReturnValue({
        mode: "typed-index",
        enabledAt: "2026-04-10",
      });
      const result = handleSlashCommand(makeCtx("memory"), makeApi());
      expect(result.text).toContain("Mode: typed-index");
      expect(result.text).toContain("since 2026-04-10");
    });
  });

  // -------------------------------------------------------------------------
  // memory enable
  // -------------------------------------------------------------------------

  describe("memory enable", () => {
    it("enables typed-index and injects AGENTS.md instructions", () => {
      mockMemoryConfig.loadMemoryConfig.mockReturnValue({ mode: "default" });
      const result = handleSlashCommand(makeCtx("memory enable"), makeApi());
      expect(result.text).toContain("Typed Memory Index Enabled");
      expect(result.text).toContain("Memory instructions injected");
      expect(mockMemoryConfig.injectMemoryInstructions).toHaveBeenCalled();
      expect(mockMemoryConfig.saveMemoryConfig).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "typed-index" }),
      );
    });

    it("returns already-enabled when mode is typed-index", () => {
      mockMemoryConfig.loadMemoryConfig.mockReturnValue({ mode: "typed-index" });
      const result = handleSlashCommand(makeCtx("memory enable"), makeApi());
      expect(result.text).toContain("already enabled");
      expect(mockMemoryConfig.injectMemoryInstructions).not.toHaveBeenCalled();
    });

    it("auto-migrates existing flat MEMORY.md on enable", () => {
      mockMemoryConfig.loadMemoryConfig.mockReturnValue({ mode: "default" });
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue("- Some flat memory entry\n- Another entry\n");
      mockProvider.migrate.mockReturnValue({ imported: 2, skipped: 0 });

      const result = handleSlashCommand(makeCtx("memory enable"), makeApi());
      expect(result.text).toContain("Migrated existing MEMORY.md");
      expect(result.text).toContain("2 imported");
      expect(mockProvider.migrate).toHaveBeenCalled();
    });

    it("does not migrate when MEMORY.md already has typed index", () => {
      mockMemoryConfig.loadMemoryConfig.mockReturnValue({ mode: "default" });
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue("| Topic | Type | Updated |\n|---|---|---|\n");

      const result = handleSlashCommand(makeCtx("memory enable"), makeApi());
      expect(result.text).toContain("Typed Memory Index Enabled");
      expect(result.text).not.toContain("Migrated");
      expect(mockProvider.migrate).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // memory disable
  // -------------------------------------------------------------------------

  describe("memory disable", () => {
    it("disables typed-index and removes AGENTS.md instructions", () => {
      mockMemoryConfig.loadMemoryConfig.mockReturnValue({ mode: "typed-index" });
      const result = handleSlashCommand(makeCtx("memory disable"), makeApi());
      expect(result.text).toContain("Typed Memory Index Disabled");
      expect(result.text).toContain("instructions removed");
      expect(mockMemoryConfig.removeMemoryInstructions).toHaveBeenCalled();
      expect(mockMemoryConfig.saveMemoryConfig).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "default" }),
      );
    });

    it("returns already-disabled when mode is default", () => {
      mockMemoryConfig.loadMemoryConfig.mockReturnValue({ mode: "default" });
      const result = handleSlashCommand(makeCtx("memory disable"), makeApi());
      expect(result.text).toContain("already disabled");
      expect(mockMemoryConfig.removeMemoryInstructions).not.toHaveBeenCalled();
    });

    it("mentions topic files are preserved", () => {
      mockMemoryConfig.loadMemoryConfig.mockReturnValue({ mode: "typed-index" });
      const result = handleSlashCommand(makeCtx("memory disable"), makeApi());
      expect(result.text).toContain("still on disk");
    });
  });

  // -------------------------------------------------------------------------
  // help includes enable/disable
  // -------------------------------------------------------------------------

  describe("help includes enable/disable", () => {
    it("lists enable and disable in help text", () => {
      const result = handleSlashCommand(makeCtx(), makeApi());
      expect(result.text).toContain("memory enable");
      expect(result.text).toContain("memory disable");
    });
  });
});
