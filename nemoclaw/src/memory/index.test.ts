// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, vi } from "vitest";
import type fs from "node:fs";
import {
  loadMemoryIndex,
  saveMemoryIndex,
  loadTopic,
  saveTopic,
  listTopicSlugs,
  isValidMemoryType,
  slugify,
  parseTopicFrontmatter,
  getMemoryStats,
  INDEX_SOFT_CAP,
  TOPIC_SOFT_CAP,
  MEMORY_TYPES,
  type MemoryIndex,
  type MemoryIndexEntry,
  type MemoryTopicFrontmatter,
} from "./index.js";

// ---------------------------------------------------------------------------
// In-memory filesystem mock
// ---------------------------------------------------------------------------

const store = new Map<string, string>();
const dirs = new Set<string>();

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  return {
    ...original,
    existsSync: (p: string) => store.has(p) || dirs.has(p),
    mkdirSync: (_p: string) => {
      dirs.add(_p);
    },
    readFileSync: (p: string) => {
      const content = store.get(p);
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
    writeFileSync: (p: string, data: string) => {
      store.set(p, data);
    },
    readdirSync: (p: string) => {
      const prefix = p.endsWith("/") ? p : p + "/";
      const results: string[] = [];
      for (const key of store.keys()) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes("/")) {
          results.push(key.slice(prefix.length));
        }
      }
      return results;
    },
  };
});

// ---------------------------------------------------------------------------
// Test paths
// ---------------------------------------------------------------------------

const INDEX_PATH = "/test/workspace/MEMORY.md";
const TOPICS_PATH = "/test/workspace/memory/topics";

function topicPath(slug: string): string {
  return `${TOPICS_PATH}/${slug}.md`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<MemoryIndexEntry> = {}): MemoryIndexEntry {
  return {
    slug: "test-topic",
    title: "Test Topic",
    type: "user",
    updatedAt: "2026-03-20",
    ...overrides,
  };
}

function makeFrontmatter(overrides: Partial<MemoryTopicFrontmatter> = {}): MemoryTopicFrontmatter {
  return {
    name: "test-topic",
    description: "A test topic",
    type: "user",
    created: "2026-03-20T10:00:00.000Z",
    updated: "2026-03-20T10:00:00.000Z",
    ...overrides,
  };
}

function makeTopicFile(fm: MemoryTopicFrontmatter, body: string): string {
  const lines = [
    "---",
    `name: ${fm.name}`,
    `description: ${fm.description}`,
    `type: ${fm.type}`,
    `created: "${fm.created}"`,
    `updated: "${fm.updated}"`,
    "---",
    body,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("memory/index", () => {
  beforeEach(() => {
    store.clear();
    dirs.clear();
  });

  // -------------------------------------------------------------------------
  // isValidMemoryType
  // -------------------------------------------------------------------------

  describe("isValidMemoryType", () => {
    it("returns true for valid types", () => {
      for (const t of MEMORY_TYPES) {
        expect(isValidMemoryType(t)).toBe(true);
      }
    });

    it("returns false for invalid types", () => {
      expect(isValidMemoryType("foo")).toBe(false);
      expect(isValidMemoryType("")).toBe(false);
      expect(isValidMemoryType("User")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // slugify
  // -------------------------------------------------------------------------

  describe("slugify", () => {
    it("converts spaces to hyphens and lowercases", () => {
      expect(slugify("My Cool Topic")).toBe("my-cool-topic");
    });

    it("strips special characters", () => {
      expect(slugify("Hello, World! (2026)")).toBe("hello-world-2026");
    });

    it("collapses multiple hyphens", () => {
      expect(slugify("a  --  b")).toBe("a-b");
    });

    it("truncates to 80 characters", () => {
      const long = "a".repeat(100);
      expect(slugify(long).length).toBe(80);
    });

    it("trims whitespace", () => {
      expect(slugify("  padded  ")).toBe("padded");
    });
  });

  // -------------------------------------------------------------------------
  // parseTopicFrontmatter
  // -------------------------------------------------------------------------

  describe("parseTopicFrontmatter", () => {
    it("parses valid frontmatter", () => {
      const fm = makeFrontmatter();
      const content = makeTopicFile(fm, "\nSome body text.\n");
      const result = parseTopicFrontmatter(content);
      if (result === null) throw new Error("expected non-null");
      expect(result.frontmatter.name).toBe("test-topic");
      expect(result.frontmatter.type).toBe("user");
      expect(result.body).toContain("Some body text.");
    });

    it("returns null for content without frontmatter", () => {
      expect(parseTopicFrontmatter("Just plain text")).toBeNull();
    });

    it("returns null for invalid YAML", () => {
      expect(parseTopicFrontmatter("---\n: [invalid\n---\nbody")).toBeNull();
    });

    it("returns null when required fields are missing", () => {
      const content = "---\nname: test\n---\nbody";
      expect(parseTopicFrontmatter(content)).toBeNull();
    });

    it("returns null for invalid memory type in frontmatter", () => {
      const content = "---\nname: x\ndescription: y\ntype: invalid\n---\nbody";
      expect(parseTopicFrontmatter(content)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // loadMemoryIndex
  // -------------------------------------------------------------------------

  describe("loadMemoryIndex", () => {
    it("returns empty entries when file does not exist", () => {
      const idx = loadMemoryIndex(INDEX_PATH);
      expect(idx.entries).toEqual([]);
    });

    it("returns empty entries for legacy flat content", () => {
      store.set(INDEX_PATH, "# My Memory\n\nSome random notes here.\n");
      const idx = loadMemoryIndex(INDEX_PATH);
      expect(idx.entries).toEqual([]);
    });

    it("parses valid index table", () => {
      const content = [
        "<!-- Memory Index -->",
        "",
        "| Topic | Type | Updated |",
        "|---|---|---|",
        "| [Editor Prefs](memory/topics/editor-prefs.md) | user | 2026-03-20 |",
        "| [API Limits](memory/topics/api-limits.md) | reference | 2026-03-19 |",
        "",
      ].join("\n");
      store.set(INDEX_PATH, content);

      const idx = loadMemoryIndex(INDEX_PATH);
      expect(idx.entries).toHaveLength(2);
      expect(idx.entries[0]).toEqual({
        slug: "editor-prefs",
        title: "Editor Prefs",
        type: "user",
        updatedAt: "2026-03-20",
      });
      expect(idx.entries[1]).toEqual({
        slug: "api-limits",
        title: "API Limits",
        type: "reference",
        updatedAt: "2026-03-19",
      });
    });

    it("skips rows with invalid memory types", () => {
      const content = [
        "| Topic | Type | Updated |",
        "|---|---|---|",
        "| [Good](memory/topics/good.md) | user | 2026-03-20 |",
        "| [Bad](memory/topics/bad.md) | invalid | 2026-03-20 |",
      ].join("\n");
      store.set(INDEX_PATH, content);

      const idx = loadMemoryIndex(INDEX_PATH);
      expect(idx.entries).toHaveLength(1);
      expect(idx.entries[0].slug).toBe("good");
    });

    it("handles empty file", () => {
      store.set(INDEX_PATH, "");
      const idx = loadMemoryIndex(INDEX_PATH);
      expect(idx.entries).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // saveMemoryIndex
  // -------------------------------------------------------------------------

  describe("saveMemoryIndex", () => {
    it("writes valid markdown table", () => {
      const index: MemoryIndex = {
        entries: [makeEntry({ slug: "a", title: "Topic A", updatedAt: "2026-03-19" })],
      };
      saveMemoryIndex(index, INDEX_PATH);

      const content = store.get(INDEX_PATH);
      if (content === undefined) throw new Error("expected file");
      expect(content).toContain("| Topic | Type | Updated |");
      expect(content).toContain("| [Topic A](memory/topics/a.md) | user | 2026-03-19 |");
    });

    it("sorts entries by updatedAt descending", () => {
      const index: MemoryIndex = {
        entries: [
          makeEntry({ slug: "old", title: "Old", updatedAt: "2026-03-01" }),
          makeEntry({ slug: "new", title: "New", updatedAt: "2026-03-20" }),
        ],
      };
      saveMemoryIndex(index, INDEX_PATH);

      const content = store.get(INDEX_PATH);
      if (content === undefined) throw new Error("expected file");
      const newIdx = content.indexOf("New");
      const oldIdx = content.indexOf("Old");
      expect(newIdx).toBeLessThan(oldIdx);
    });

    it("writes header comments", () => {
      saveMemoryIndex({ entries: [] }, INDEX_PATH);
      const content = store.get(INDEX_PATH);
      if (content === undefined) throw new Error("expected file");
      expect(content).toContain("<!-- Memory Index");
      expect(content).toContain("Soft cap");
      expect(content).toContain("daily notes");
    });

    it("round-trips with loadMemoryIndex", () => {
      const original: MemoryIndex = {
        entries: [
          makeEntry({ slug: "a", title: "Alpha", type: "decision", updatedAt: "2026-03-20" }),
          makeEntry({ slug: "b", title: "Beta", type: "project", updatedAt: "2026-03-18" }),
        ],
      };
      saveMemoryIndex(original, INDEX_PATH);
      const loaded = loadMemoryIndex(INDEX_PATH);
      expect(loaded.entries).toHaveLength(2);
      expect(loaded.entries[0].slug).toBe("a");
      expect(loaded.entries[1].slug).toBe("b");
    });
  });

  // -------------------------------------------------------------------------
  // loadTopic / saveTopic
  // -------------------------------------------------------------------------

  describe("loadTopic", () => {
    it("returns null when file does not exist", () => {
      expect(loadTopic("nonexistent", TOPICS_PATH)).toBeNull();
    });

    it("returns parsed frontmatter and body", () => {
      const fm = makeFrontmatter({ name: "my-topic" });
      store.set(topicPath("my-topic"), makeTopicFile(fm, "\nTopic body.\n"));

      const result = loadTopic("my-topic", TOPICS_PATH);
      expect(result).not.toBeNull();
      if (result === null) throw new Error("expected non-null");
      expect(result.frontmatter.name).toBe("my-topic");
      expect(result.body).toContain("Topic body.");
    });

    it("returns null for file with invalid frontmatter", () => {
      store.set(topicPath("bad"), "Just text, no frontmatter");
      expect(loadTopic("bad", TOPICS_PATH)).toBeNull();
    });
  });

  describe("saveTopic", () => {
    it("writes topic file with frontmatter", () => {
      const fm = makeFrontmatter({ name: "new-topic", type: "decision" });
      saveTopic("new-topic", fm, "\nDecision rationale.\n", TOPICS_PATH);

      const content = store.get(topicPath("new-topic"));
      if (content === undefined) throw new Error("expected file");
      expect(content).toContain("---");
      expect(content).toContain("name: new-topic");
      expect(content).toContain("type: decision");
      expect(content).toContain("Decision rationale.");
    });

    it("creates topics directory if missing", () => {
      const fm = makeFrontmatter();
      saveTopic("test", fm, "\nbody\n", "/new/topics");
      expect(dirs.has("/new/topics")).toBe(true);
    });

    it("round-trips with loadTopic", () => {
      const fm = makeFrontmatter({ name: "rt", description: "Round trip test" });
      const body = "\nThis is the body content.\n";
      saveTopic("rt", fm, body, TOPICS_PATH);

      const loaded = loadTopic("rt", TOPICS_PATH);
      expect(loaded).not.toBeNull();
      if (loaded === null) throw new Error("expected non-null");
      expect(loaded.frontmatter.name).toBe("rt");
      expect(loaded.frontmatter.description).toBe("Round trip test");
      expect(loaded.body).toContain("This is the body content.");
    });
  });

  // -------------------------------------------------------------------------
  // listTopicSlugs
  // -------------------------------------------------------------------------

  describe("listTopicSlugs", () => {
    it("returns empty array when directory does not exist", () => {
      expect(listTopicSlugs("/nonexistent")).toEqual([]);
    });

    it("returns slugs from .md files", () => {
      store.set(topicPath("alpha"), "content");
      store.set(topicPath("beta"), "content");
      dirs.add(TOPICS_PATH);

      const slugs = listTopicSlugs(TOPICS_PATH);
      expect(slugs).toContain("alpha");
      expect(slugs).toContain("beta");
      expect(slugs).toHaveLength(2);
    });

    it("ignores non-md files", () => {
      store.set(`${TOPICS_PATH}/readme.txt`, "content");
      store.set(topicPath("valid"), "content");
      dirs.add(TOPICS_PATH);

      const slugs = listTopicSlugs(TOPICS_PATH);
      expect(slugs).toEqual(["valid"]);
    });
  });

  // -------------------------------------------------------------------------
  // getMemoryStats
  // -------------------------------------------------------------------------

  describe("getMemoryStats", () => {
    it("returns zeroed stats when nothing exists", () => {
      const stats = getMemoryStats(INDEX_PATH, TOPICS_PATH);
      expect(stats.indexEntryCount).toBe(0);
      expect(stats.indexLineCount).toBe(0);
      expect(stats.indexOverCap).toBe(false);
      expect(stats.topicCount).toBe(0);
      expect(stats.oversizedTopics).toEqual([]);
      for (const t of MEMORY_TYPES) {
        expect(stats.topicsByType[t]).toBe(0);
      }
    });

    it("counts entries by type", () => {
      const index: MemoryIndex = {
        entries: [
          makeEntry({ slug: "a", type: "user" }),
          makeEntry({ slug: "b", type: "user" }),
          makeEntry({ slug: "c", type: "decision" }),
        ],
      };
      saveMemoryIndex(index, INDEX_PATH);
      dirs.add(TOPICS_PATH);

      const stats = getMemoryStats(INDEX_PATH, TOPICS_PATH);
      expect(stats.indexEntryCount).toBe(3);
      expect(stats.topicsByType.user).toBe(2);
      expect(stats.topicsByType.decision).toBe(1);
      expect(stats.topicsByType.project).toBe(0);
      expect(stats.topicsByType.reference).toBe(0);
    });

    it("detects index over soft cap", () => {
      const entries: MemoryIndexEntry[] = [];
      for (let i = 0; i < INDEX_SOFT_CAP + 1; i++) {
        entries.push(makeEntry({ slug: `t${String(i)}`, title: `Topic ${String(i)}` }));
      }
      saveMemoryIndex({ entries }, INDEX_PATH);

      const stats = getMemoryStats(INDEX_PATH, TOPICS_PATH);
      expect(stats.indexOverCap).toBe(true);
    });

    it("detects oversized topics", () => {
      const longBody = "line\n".repeat(TOPIC_SOFT_CAP + 10);
      const fm = makeFrontmatter({ name: "big" });
      store.set(topicPath("big"), makeTopicFile(fm, longBody));
      dirs.add(TOPICS_PATH);

      const stats = getMemoryStats(INDEX_PATH, TOPICS_PATH);
      expect(stats.oversizedTopics).toContain("big");
    });

    it("counts topic files on disk", () => {
      store.set(topicPath("one"), "content");
      store.set(topicPath("two"), "content");
      dirs.add(TOPICS_PATH);

      const stats = getMemoryStats(INDEX_PATH, TOPICS_PATH);
      expect(stats.topicCount).toBe(2);
    });
  });
});
