// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import YAML from "yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoryType = "user" | "project" | "feedback" | "reference";

export interface MemoryIndexEntry {
  slug: string;
  title: string;
  type: MemoryType;
  updatedAt: string; // ISO 8601 date (YYYY-MM-DD)
}

export interface MemoryIndex {
  entries: MemoryIndexEntry[];
}

export interface MemoryTopicFrontmatter {
  name: string;
  description: string;
  type: MemoryType;
  created: string; // ISO 8601 datetime
  updated: string; // ISO 8601 datetime
}

export interface MemoryStats {
  indexEntryCount: number;
  indexLineCount: number;
  indexOverCap: boolean;
  topicCount: number;
  topicsByType: Record<MemoryType, number>;
  oversizedTopics: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MEMORY_TYPES: readonly MemoryType[] = ["user", "project", "feedback", "reference"];

export const INDEX_SOFT_CAP = 200;
export const TOPIC_SOFT_CAP = 500;

export const WORKSPACE_DIR = "/sandbox/.openclaw/workspace";
export const MEMORY_INDEX_PATH = join(WORKSPACE_DIR, "MEMORY.md");
export const TOPICS_DIR = join(WORKSPACE_DIR, "memory", "topics");

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function isValidMemoryType(value: string): value is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(value);
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function parseTopicFrontmatter(
  content: string,
): { frontmatter: MemoryTopicFrontmatter; body: string } | null {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return null;

  try {
    const raw = YAML.parse(match[1]) as Record<string, unknown>;
    if (
      typeof raw.name !== "string" ||
      typeof raw.description !== "string" ||
      typeof raw.type !== "string" ||
      !isValidMemoryType(raw.type)
    ) {
      return null;
    }
    const frontmatter: MemoryTopicFrontmatter = {
      name: raw.name,
      description: raw.description,
      type: raw.type,
      created: typeof raw.created === "string" ? raw.created : "",
      updated: typeof raw.updated === "string" ? raw.updated : "",
    };
    return { frontmatter, body: match[2] };
  } catch {
    return null;
  }
}

function renderTopicFile(frontmatter: MemoryTopicFrontmatter, body: string): string {
  const fm = YAML.stringify({
    name: frontmatter.name,
    description: frontmatter.description,
    type: frontmatter.type,
    created: frontmatter.created,
    updated: frontmatter.updated,
  }).trimEnd();
  return `---\n${fm}\n---\n${body}`;
}

// ---------------------------------------------------------------------------
// Index persistence
// ---------------------------------------------------------------------------

const TABLE_HEADER_RE = /^\|\s*Topic\s*\|\s*Type\s*\|\s*Updated\s*\|/m;
const TABLE_ROW_RE =
  /^\|\s*\[([^\]]+)\]\(memory\/topics\/([^)]+)\.md\)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|$/;

export function loadMemoryIndex(indexPath: string = MEMORY_INDEX_PATH): MemoryIndex {
  if (!existsSync(indexPath)) return { entries: [] };

  const content = readFileSync(indexPath, "utf-8");
  if (!TABLE_HEADER_RE.test(content)) return { entries: [] };

  const entries: MemoryIndexEntry[] = [];
  for (const line of content.split("\n")) {
    const m = TABLE_ROW_RE.exec(line.trim());
    if (!m) continue;
    const [, title, slug, type, updatedAt] = m;
    if (isValidMemoryType(type)) {
      entries.push({ slug, title, type, updatedAt });
    }
  }
  return { entries };
}

export function saveMemoryIndex(index: MemoryIndex, indexPath: string = MEMORY_INDEX_PATH): void {
  const sorted = [...index.entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const lines = [
    "<!-- Memory Index — each row links to a topic file in memory/topics/ -->",
    "<!-- Soft cap: ~200 entries. Prefer curating over appending. -->",
    "<!-- For session notes, use daily notes (memory/YYYY-MM-DD.md) instead. -->",
    "",
    "| Topic | Type | Updated |",
    "|---|---|---|",
  ];

  for (const e of sorted) {
    lines.push(`| [${e.title}](memory/topics/${e.slug}.md) | ${e.type} | ${e.updatedAt} |`);
  }

  lines.push(""); // trailing newline
  writeFileSync(indexPath, lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Topic CRUD
// ---------------------------------------------------------------------------

function ensureTopicsDir(topicsDir: string = TOPICS_DIR): void {
  if (!existsSync(topicsDir)) {
    mkdirSync(topicsDir, { recursive: true });
  }
}

export function loadTopic(
  slug: string,
  topicsDir: string = TOPICS_DIR,
): { frontmatter: MemoryTopicFrontmatter; body: string } | null {
  const filePath = join(topicsDir, `${slug}.md`);
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, "utf-8");
  return parseTopicFrontmatter(content);
}

export function saveTopic(
  slug: string,
  frontmatter: MemoryTopicFrontmatter,
  body: string,
  topicsDir: string = TOPICS_DIR,
): void {
  ensureTopicsDir(topicsDir);
  const filePath = join(topicsDir, `${slug}.md`);
  writeFileSync(filePath, renderTopicFile(frontmatter, body));
}

export function listTopicSlugs(topicsDir: string = TOPICS_DIR): string[] {
  if (!existsSync(topicsDir)) return [];
  return readdirSync(topicsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => basename(f, ".md"));
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function countLines(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  return readFileSync(filePath, "utf-8").split("\n").length;
}

export function getMemoryStats(
  indexPath: string = MEMORY_INDEX_PATH,
  topicsDir: string = TOPICS_DIR,
): MemoryStats {
  const index = loadMemoryIndex(indexPath);
  const indexLineCount = existsSync(indexPath)
    ? readFileSync(indexPath, "utf-8").split("\n").length
    : 0;

  const topicsByType: Record<MemoryType, number> = {
    user: 0,
    project: 0,
    feedback: 0,
    reference: 0,
  };
  for (const entry of index.entries) {
    topicsByType[entry.type]++;
  }

  const slugs = listTopicSlugs(topicsDir);
  const oversizedTopics: string[] = [];
  for (const slug of slugs) {
    const lines = countLines(join(topicsDir, `${slug}.md`));
    if (lines > TOPIC_SOFT_CAP) {
      oversizedTopics.push(slug);
    }
  }

  return {
    indexEntryCount: index.entries.length,
    indexLineCount,
    indexOverCap: index.entries.length > INDEX_SOFT_CAP,
    topicCount: slugs.length,
    topicsByType,
    oversizedTopics,
  };
}

// ---------------------------------------------------------------------------
// Re-exports for provider API
// ---------------------------------------------------------------------------

export type { MemoryProvider } from "./provider.js";
export { TypedMemoryProvider } from "./typed-provider.js";
