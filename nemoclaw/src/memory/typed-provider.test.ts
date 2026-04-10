// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, vi } from "vitest";
import type fs from "node:fs";
import type { MemoryTopicFrontmatter } from "./index.js";

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
    unlinkSync: (p: string) => {
      store.delete(p);
    },
  };
});

// ---------------------------------------------------------------------------
// Test paths and helpers
// ---------------------------------------------------------------------------

const INDEX_PATH = "/test/workspace/MEMORY.md";
const TOPICS_PATH = "/test/workspace/memory/topics";

function topicPath(slug: string): string {
  return `${TOPICS_PATH}/${slug}.md`;
}

function makeFrontmatter(overrides: Partial<MemoryTopicFrontmatter> = {}): MemoryTopicFrontmatter {
  return {
    name: "Test Topic",
    description: "A test topic description",
    type: "user",
    created: "2026-03-20T10:00:00.000Z",
    updated: "2026-03-20T10:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Import subject under test after mock is set up
// ---------------------------------------------------------------------------

const { TypedMemoryProvider } = await import("./typed-provider.js");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TypedMemoryProvider", () => {
  let provider: InstanceType<typeof TypedMemoryProvider>;

  beforeEach(() => {
    store.clear();
    dirs.clear();
    provider = new TypedMemoryProvider(INDEX_PATH, TOPICS_PATH);
  });

  // -------------------------------------------------------------------------
  // context()
  // -------------------------------------------------------------------------

  describe("context()", () => {
    it("returns empty string when index file does not exist", () => {
      expect(provider.context()).toBe("");
    });

    it("returns raw content when index file exists", () => {
      const content = "# Memory Index\n\nSome content here.\n";
      store.set(INDEX_PATH, content);
      expect(provider.context()).toBe(content);
    });
  });

  // -------------------------------------------------------------------------
  // save() + load()
  // -------------------------------------------------------------------------

  describe("save() + load()", () => {
    it("saves a topic and loads it back (round-trip)", () => {
      const fm = makeFrontmatter({ name: "My Topic", type: "project" });
      const body = "\nBody content here.\n";
      provider.save("my-topic", fm, body);

      const result = provider.load("my-topic");
      expect(result).not.toBeNull();
      expect(result?.frontmatter.name).toBe("My Topic");
      expect(result?.frontmatter.type).toBe("project");
      expect(result?.body).toContain("Body content here.");
    });

    it("upserts entry in index on re-save", () => {
      const fm = makeFrontmatter({ name: "Topic A" });
      provider.save("topic-a", fm, "\nOriginal body.\n");

      const updatedFm = makeFrontmatter({
        name: "Topic A Updated",
        updated: "2026-04-01T12:00:00.000Z",
      });
      provider.save("topic-a", updatedFm, "\nUpdated body.\n");

      const entries = provider.list();
      const matching = entries.filter((e) => e.slug === "topic-a");
      expect(matching).toHaveLength(1);
      expect(matching[0].title).toBe("Topic A Updated");
      expect(matching[0].updatedAt).toBe("2026-04-01");
    });

    it("returns null for a slug that does not exist", () => {
      expect(provider.load("nonexistent-slug")).toBeNull();
    });

    it("updates the index entry after save", () => {
      const fm = makeFrontmatter({ name: "Indexed Topic", type: "reference" });
      provider.save("indexed-topic", fm, "\nbody\n");

      const entries = provider.list();
      expect(entries).toHaveLength(1);
      expect(entries[0].slug).toBe("indexed-topic");
      expect(entries[0].type).toBe("reference");
    });
  });

  // -------------------------------------------------------------------------
  // list()
  // -------------------------------------------------------------------------

  describe("list()", () => {
    beforeEach(() => {
      provider.save("user-topic", makeFrontmatter({ name: "User Topic", type: "user" }), "");
      provider.save(
        "project-topic",
        makeFrontmatter({ name: "Project Topic", type: "project" }),
        "",
      );
      provider.save(
        "reference-topic",
        makeFrontmatter({ name: "Reference Topic", type: "reference" }),
        "",
      );
    });

    it("returns all entries when no filter is provided", () => {
      const entries = provider.list();
      expect(entries).toHaveLength(3);
    });

    it("filters entries by type", () => {
      const userEntries = provider.list({ type: "user" });
      expect(userEntries).toHaveLength(1);
      expect(userEntries[0].slug).toBe("user-topic");

      const projectEntries = provider.list({ type: "project" });
      expect(projectEntries).toHaveLength(1);
      expect(projectEntries[0].slug).toBe("project-topic");
    });

    it("returns empty array when filter type matches nothing", () => {
      const feedbackEntries = provider.list({ type: "feedback" });
      expect(feedbackEntries).toHaveLength(0);
    });

    it("returns all entries when filter has no type field", () => {
      const entries = provider.list({});
      expect(entries).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // delete()
  // -------------------------------------------------------------------------

  describe("delete()", () => {
    it("removes topic file and index entry", () => {
      provider.save("to-delete", makeFrontmatter({ name: "To Delete" }), "\nbody\n");
      expect(provider.load("to-delete")).not.toBeNull();
      expect(provider.list()).toHaveLength(1);

      provider.delete("to-delete");

      expect(provider.load("to-delete")).toBeNull();
      expect(provider.list()).toHaveLength(0);
      expect(store.has(topicPath("to-delete"))).toBe(false);
    });

    it("is a no-op for a missing slug (does not throw)", () => {
      provider.save("keep-me", makeFrontmatter({ name: "Keep Me" }), "");
      expect(() => {
        provider.delete("nonexistent-slug");
      }).not.toThrow();
      // existing topics remain untouched
      expect(provider.list()).toHaveLength(1);
    });

    it("removes only the targeted entry from the index", () => {
      provider.save("alpha", makeFrontmatter({ name: "Alpha" }), "");
      provider.save("beta", makeFrontmatter({ name: "Beta" }), "");
      provider.delete("alpha");

      const entries = provider.list();
      expect(entries).toHaveLength(1);
      expect(entries[0].slug).toBe("beta");
    });
  });

  // -------------------------------------------------------------------------
  // search()
  // -------------------------------------------------------------------------

  describe("search()", () => {
    beforeEach(() => {
      provider.save(
        "typescript-guide",
        makeFrontmatter({ name: "TypeScript Guide", type: "reference" }),
        "\nLearn TypeScript basics and advanced patterns.\n",
      );
      provider.save(
        "python-tips",
        makeFrontmatter({ name: "Python Tips", type: "project" }),
        "\nHelpful Python programming tips and tricks.\n",
      );
      provider.save(
        "user-preferences",
        makeFrontmatter({ name: "User Preferences", type: "user" }),
        "\nPreferred editor settings and shortcuts.\n",
      );
    });

    it("matches entries by title keyword", () => {
      const results = provider.search("TypeScript");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].slug).toBe("typescript-guide");
    });

    it("matches entries by body keyword", () => {
      const results = provider.search("programming");
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((e) => e.slug === "python-tips")).toBe(true);
    });

    it("ranks title matches higher than body-only matches", () => {
      // "guide" appears in the title of typescript-guide but not as a title for python-tips
      // "tips" appears in python-tips title, let's look for something appearing in body of one and title of another
      // Save a topic where term is in both title and body to confirm title scores higher
      provider.save(
        "python-guide",
        makeFrontmatter({ name: "Python Guide", type: "project" }),
        "\nNotes about TypeScript.\n",
      );

      // "python" is in title of python-tips (+2) and python-guide (+2), and in body of neither extra
      // "guide" is in title of typescript-guide (+2) and python-guide (+2)
      // Let's search for a term that is only in title of one and only in body of another
      const results = provider.search("Python programming");
      // python-tips: title has "python" (+2), body has "programming" (+1) = 3
      // python-guide: title has "python" (+2), body has nothing matching "programming" = 2
      expect(results[0].slug).toBe("python-tips");
    });

    it("returns empty array when nothing matches", () => {
      const results = provider.search("xyzzy-nonexistent");
      expect(results).toEqual([]);
    });

    it("returns empty array for blank query", () => {
      expect(provider.search("")).toEqual([]);
      expect(provider.search("   ")).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // stats()
  // -------------------------------------------------------------------------

  describe("stats()", () => {
    it("returns zeroed stats when empty", () => {
      const stats = provider.stats();
      expect(stats.indexEntryCount).toBe(0);
      expect(stats.indexLineCount).toBe(0);
      expect(stats.indexOverCap).toBe(false);
      expect(stats.topicCount).toBe(0);
      expect(stats.topicsByType.user).toBe(0);
      expect(stats.topicsByType.project).toBe(0);
      expect(stats.topicsByType.feedback).toBe(0);
      expect(stats.topicsByType.reference).toBe(0);
      expect(stats.oversizedTopics).toEqual([]);
    });

    it("reflects correct counts after saves", () => {
      provider.save("u1", makeFrontmatter({ name: "User 1", type: "user" }), "");
      provider.save("u2", makeFrontmatter({ name: "User 2", type: "user" }), "");
      provider.save("p1", makeFrontmatter({ name: "Project 1", type: "project" }), "");
      provider.save("r1", makeFrontmatter({ name: "Reference 1", type: "reference" }), "");

      const stats = provider.stats();
      expect(stats.indexEntryCount).toBe(4);
      expect(stats.topicsByType.user).toBe(2);
      expect(stats.topicsByType.project).toBe(1);
      expect(stats.topicsByType.reference).toBe(1);
      expect(stats.topicsByType.feedback).toBe(0);
      expect(stats.topicCount).toBe(4);
    });
  });

  // -------------------------------------------------------------------------
  // migrate()
  // -------------------------------------------------------------------------

  describe("migrate()", () => {
    it("imports entries from flat content", () => {
      const flat = [
        "# Old Memory",
        "",
        "- I prefer dark mode",
        "- Use TypeScript for all new projects",
        "- API endpoint is https://api.example.com",
      ].join("\n");

      const result = provider.migrate(flat);
      expect(result.imported).toBe(3);
      expect(result.skipped).toBe(0);

      const entries = provider.list();
      expect(entries).toHaveLength(3);
    });

    it("skips duplicate slugs", () => {
      const flat = "- I prefer dark mode\n- I prefer dark mode\n";
      const result = provider.migrate(flat);
      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(1);
    });

    it("skips blank lines and comments", () => {
      const flat = ["", "   ", "<!-- this is a comment -->", "# Heading", "- actual entry"].join(
        "\n",
      );

      const result = provider.migrate(flat);
      expect(result.imported).toBe(1);
    });

    it("infers type from keywords", () => {
      const flat = [
        "- user prefers tabs",
        "- api endpoint for auth",
        "- feedback: stop using var",
        "- general project note",
      ].join("\n");

      provider.migrate(flat);

      const userEntries = provider.list({ type: "user" });
      const refEntries = provider.list({ type: "reference" });
      const feedbackEntries = provider.list({ type: "feedback" });
      const projectEntries = provider.list({ type: "project" });

      expect(userEntries.length).toBeGreaterThan(0);
      expect(refEntries.length).toBeGreaterThan(0);
      expect(feedbackEntries.length).toBeGreaterThan(0);
      expect(projectEntries.length).toBeGreaterThan(0);
    });

    it("handles empty input gracefully", () => {
      const result = provider.migrate("");
      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(0);
    });

    it("does not re-import entries that already exist", () => {
      const fm = makeFrontmatter({ name: "i prefer dark mode", type: "user" });
      provider.save("i-prefer-dark-mode", fm, "");

      const flat = "- i prefer dark mode\n- new entry\n";
      const result = provider.migrate(flat);

      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(1);

      const entries = provider.list();
      const matching = entries.filter((e) => e.slug === "i-prefer-dark-mode");
      expect(matching).toHaveLength(1);
    });

    it("strips list markers before slugifying", () => {
      const flat = "* My Important Note\n";
      provider.migrate(flat);

      const entries = provider.list();
      expect(entries[0].slug).toBe("my-important-note");
    });
  });
});
