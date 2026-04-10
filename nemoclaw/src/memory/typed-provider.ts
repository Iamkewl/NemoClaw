// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { MemoryProvider } from "./provider.js";
import {
  loadMemoryIndex,
  saveMemoryIndex,
  loadTopic,
  saveTopic,
  getMemoryStats,
  slugify,
  MEMORY_INDEX_PATH,
  TOPICS_DIR,
  type MemoryType,
  type MemoryIndexEntry,
  type MemoryTopicFrontmatter,
  type MemoryStats,
} from "./index.js";

export class TypedMemoryProvider implements MemoryProvider {
  private readonly indexPath: string;
  private readonly topicsDir: string;

  constructor(indexPath: string = MEMORY_INDEX_PATH, topicsDir: string = TOPICS_DIR) {
    this.indexPath = indexPath;
    this.topicsDir = topicsDir;
  }

  context(): string {
    if (!existsSync(this.indexPath)) return "";
    return readFileSync(this.indexPath, "utf-8");
  }

  load(slug: string): { frontmatter: MemoryTopicFrontmatter; body: string } | null {
    return loadTopic(slug, this.topicsDir);
  }

  save(slug: string, frontmatter: MemoryTopicFrontmatter, body: string): void {
    saveTopic(slug, frontmatter, body, this.topicsDir);

    const index = loadMemoryIndex(this.indexPath);
    const updatedAt = frontmatter.updated
      ? frontmatter.updated.slice(0, 10)
      : new Date().toISOString().slice(0, 10);

    const existingIdx = index.entries.findIndex((e) => e.slug === slug);
    const entry: MemoryIndexEntry = {
      slug,
      title: frontmatter.name,
      type: frontmatter.type,
      updatedAt,
    };

    if (existingIdx >= 0) {
      index.entries[existingIdx] = entry;
    } else {
      index.entries.push(entry);
    }

    saveMemoryIndex(index, this.indexPath);
  }

  delete(slug: string): void {
    const filePath = join(this.topicsDir, `${slug}.md`);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }

    const index = loadMemoryIndex(this.indexPath);
    index.entries = index.entries.filter((e) => e.slug !== slug);
    saveMemoryIndex(index, this.indexPath);
  }

  list(filter?: { type?: MemoryType }): MemoryIndexEntry[] {
    const index = loadMemoryIndex(this.indexPath);
    if (filter?.type) {
      return index.entries.filter((e) => e.type === filter.type);
    }
    return index.entries;
  }

  search(query: string): MemoryIndexEntry[] {
    if (!query.trim()) return [];

    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const index = loadMemoryIndex(this.indexPath);

    const scored: Array<{ entry: MemoryIndexEntry; score: number }> = [];

    for (const entry of index.entries) {
      let score = 0;
      const title = entry.title.toLowerCase();
      const desc =
        (entry as MemoryIndexEntry & { description?: string }).description?.toLowerCase() ?? "";

      const topic = loadTopic(entry.slug, this.topicsDir);
      const bodyText = topic?.body.toLowerCase() ?? "";

      for (const term of terms) {
        if (title.includes(term)) score += 2;
        if (desc.includes(term)) score += 1;
        if (bodyText.includes(term)) score += 1;
      }

      if (score > 0) {
        scored.push({ entry, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.entry);
  }

  stats(): MemoryStats {
    return getMemoryStats(this.indexPath, this.topicsDir);
  }

  migrate(flatContent: string): { imported: number; skipped: number } {
    let imported = 0;
    let skipped = 0;

    const existing = new Set(loadMemoryIndex(this.indexPath).entries.map((e) => e.slug));

    for (const rawLine of flatContent.split("\n")) {
      const line = rawLine.trim();

      // Skip blank lines, headings, and HTML comments
      if (!line || line.startsWith("#") || line.startsWith("<!--")) {
        continue;
      }

      // Strip list markers
      const text = line.replace(/^[-*]\s+/, "").trim();
      if (!text) {
        skipped++;
        continue;
      }

      const slug = slugify(text);
      if (!slug) {
        skipped++;
        continue;
      }

      if (existing.has(slug)) {
        skipped++;
        continue;
      }

      // Infer type from keywords
      const lower = text.toLowerCase();
      let type: MemoryType = "project";
      if (/\b(user|prefer|like)\b/.test(lower)) {
        type = "user";
      } else if (/\b(api|url|endpoint|command)\b/.test(lower)) {
        type = "reference";
      } else if (/\b(feedback|correct|stop|don't)\b/.test(lower)) {
        type = "feedback";
      }

      const now = new Date().toISOString();
      const frontmatter: MemoryTopicFrontmatter = {
        name: text,
        description: text,
        type,
        created: now,
        updated: now,
      };

      this.save(slug, frontmatter, "");
      existing.add(slug);
      imported++;
    }

    return { imported, skipped };
  }
}
