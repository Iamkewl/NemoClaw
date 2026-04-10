#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test for TypedMemoryProvider.
 * Exercises the full provider lifecycle against a real filesystem (temp dir).
 *
 * Run: node test/integration/memory-index.mjs
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Import compiled TypedMemoryProvider
import { TypedMemoryProvider } from "../../nemoclaw/dist/memory/typed-provider.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}`);
    failed++;
  }
}

function section(name) {
  console.log(`\n--- ${name} ---`);
}

// ---------------------------------------------------------------------------
// Setup temp workspace
// ---------------------------------------------------------------------------

const tmpDir = mkdtempSync(join(tmpdir(), "nemoclaw-memory-test-"));
const indexPath = join(tmpDir, "MEMORY.md");
const topicsDir = join(tmpDir, "memory", "topics");

console.log(`\nTemp workspace: ${tmpDir}\n`);

try {
  const provider = new TypedMemoryProvider(indexPath, topicsDir);

  // -------------------------------------------------------------------------
  // 1. context() returns empty string on init
  // -------------------------------------------------------------------------

  section("context() on empty workspace");

  assert(provider.context() === "", "context() returns empty string when no index file exists");

  // -------------------------------------------------------------------------
  // 2. save() + load() round-trip
  // -------------------------------------------------------------------------

  section("save() + load() round-trip");

  const fm1 = {
    name: "Preferred Editor",
    description: "User prefers VS Code with vim keybindings",
    type: "user",
    created: "2026-03-20T10:00:00.000Z",
    updated: "2026-03-20T10:00:00.000Z",
  };
  provider.save("preferred-editor", fm1, "\nUser strongly prefers VS Code with vim keybindings.\n");
  assert(true, "save() succeeded without throwing");

  const loaded = provider.load("preferred-editor");
  assert(loaded !== null, "load() returns non-null for saved slug");
  assert(loaded.frontmatter.name === "Preferred Editor", "Round-trip: name matches");
  assert(loaded.frontmatter.type === "user", "Round-trip: type matches");
  assert(
    loaded.frontmatter.description === "User prefers VS Code with vim keybindings",
    "Round-trip: description matches",
  );
  assert(loaded.body.includes("vim keybindings"), "Round-trip: body content preserved");

  // -------------------------------------------------------------------------
  // 3. load() returns null for missing slug
  // -------------------------------------------------------------------------

  section("load() for missing slug");

  assert(provider.load("nonexistent-slug") === null, "load() returns null for missing slug");

  // -------------------------------------------------------------------------
  // 4. list() with multiple entries and type filter
  // -------------------------------------------------------------------------

  section("list() with multiple entries and type filter");

  const fm2 = {
    name: "API Rate Limits",
    description: "Rate limits for the inference API",
    type: "reference",
    created: "2026-03-19T08:00:00.000Z",
    updated: "2026-03-19T14:00:00.000Z",
  };
  provider.save("api-rate-limits", fm2, "\nDefault: 60 req/min. Burst: 120 req/min.\n");

  const fm3 = {
    name: "Use TypeScript",
    description: "Feedback to always use TypeScript for new modules",
    type: "feedback",
    created: "2026-03-18T09:00:00.000Z",
    updated: "2026-03-18T09:00:00.000Z",
  };
  provider.save("use-typescript", fm3, "\nAll new plugin modules must be TypeScript.\n");

  const fm4 = {
    name: "Core Inference Blueprint",
    description: "Core project blueprint for inference stack",
    type: "project",
    created: "2026-03-17T09:00:00.000Z",
    updated: "2026-03-17T09:00:00.000Z",
  };
  provider.save("core-inference-blueprint", fm4, "\nBlueprint details for the inference stack.\n");

  const allEntries = provider.list();
  assert(allEntries.length === 4, `list() returns all 4 entries (got ${allEntries.length})`);

  const userEntries = provider.list({ type: "user" });
  assert(
    userEntries.length === 1,
    `list({ type: "user" }) returns 1 entry (got ${userEntries.length})`,
  );
  assert(userEntries[0].slug === "preferred-editor", "list({ type: 'user' }) returns correct slug");

  const feedbackEntries = provider.list({ type: "feedback" });
  assert(feedbackEntries.length === 1, `list({ type: "feedback" }) returns 1 entry`);

  const projectEntries = provider.list({ type: "project" });
  assert(projectEntries.length === 1, `list({ type: "project" }) returns 1 entry`);

  // -------------------------------------------------------------------------
  // 5. context() returns table content after saves
  // -------------------------------------------------------------------------

  section("context() returns table content after saves");

  const ctx = provider.context();
  assert(ctx.includes("| Topic | Type | Updated |"), "context() includes table header");
  assert(ctx.includes("Preferred Editor"), "context() includes entry title");
  assert(ctx.includes("preferred-editor"), "context() includes entry slug");
  assert(ctx.length > 0, "context() is non-empty after saves");

  // -------------------------------------------------------------------------
  // 6. search() — find by keyword, empty for no match, empty for blank query
  // -------------------------------------------------------------------------

  section("search()");

  const searchResults = provider.search("TypeScript");
  assert(searchResults.length > 0, "search('TypeScript') returns at least one result");
  assert(
    searchResults.some((e) => e.slug === "use-typescript"),
    "search('TypeScript') includes 'use-typescript'",
  );

  const noMatchResults = provider.search("xyzzy-no-such-keyword");
  assert(noMatchResults.length === 0, "search() returns empty array for no match");

  assert(provider.search("").length === 0, "search('') returns empty array");
  assert(provider.search("   ").length === 0, "search('   ') returns empty array for blank query");

  // -------------------------------------------------------------------------
  // 7. delete() — removes topic + index entry, no-op for missing slug
  // -------------------------------------------------------------------------

  section("delete()");

  const fmTmp = {
    name: "Temporary Topic",
    description: "A topic that will be deleted",
    type: "project",
    created: "2026-03-20T10:00:00.000Z",
    updated: "2026-03-20T10:00:00.000Z",
  };
  provider.save("temporary-topic", fmTmp, "\nThis will be removed.\n");
  const countBeforeDelete = provider.list().length;

  provider.delete("temporary-topic");

  assert(
    provider.load("temporary-topic") === null,
    "delete() removes topic: load() returns null after delete",
  );
  assert(
    provider.list().length === countBeforeDelete - 1,
    "delete() removes index entry: list() count decremented",
  );

  const countBeforeNoOp = provider.list().length;
  let noOpThrew = false;
  try {
    provider.delete("nonexistent-slug-to-delete");
  } catch {
    noOpThrew = true;
  }
  assert(!noOpThrew, "delete() is a no-op for missing slug (does not throw)");
  assert(
    provider.list().length === countBeforeNoOp,
    "delete() for missing slug does not affect existing entries",
  );

  // -------------------------------------------------------------------------
  // 8. stats() — correct counts and type breakdown
  // -------------------------------------------------------------------------

  section("stats()");

  // At this point: preferred-editor (user), api-rate-limits (reference),
  // use-typescript (feedback), core-inference-blueprint (project)
  const stats = provider.stats();
  assert(
    stats.indexEntryCount === 4,
    `stats().indexEntryCount = 4 (got ${stats.indexEntryCount})`,
  );
  assert(stats.topicCount === 4, `stats().topicCount = 4 (got ${stats.topicCount})`);
  assert(
    stats.topicsByType.user === 1,
    `stats().topicsByType.user = 1 (got ${stats.topicsByType.user})`,
  );
  assert(stats.topicsByType.reference === 1, `stats().topicsByType.reference = 1`);
  assert(stats.topicsByType.feedback === 1, `stats().topicsByType.feedback = 1`);
  assert(stats.topicsByType.project === 1, `stats().topicsByType.project = 1`);
  assert(stats.indexOverCap === false, "stats().indexOverCap = false (4 < 200)");
  assert(stats.oversizedTopics.length === 0, "stats().oversizedTopics is empty");

  // -------------------------------------------------------------------------
  // 9. migrate() — convert flat content, verify import count, type inference
  // -------------------------------------------------------------------------

  section("migrate()");

  const migrateDir = mkdtempSync(join(tmpdir(), "nemoclaw-migrate-test-"));
  const migrateIndexPath = join(migrateDir, "MEMORY.md");
  const migrateTopicsDir = join(migrateDir, "memory", "topics");
  const migrateProvider = new TypedMemoryProvider(migrateIndexPath, migrateTopicsDir);

  const flatContent = [
    "# Old Memory File",
    "",
    "<!-- legacy comment -->",
    "- user prefers dark mode",
    "- api endpoint is https://api.example.com",
    "- feedback: stop using var keyword",
    "- project uses nemotron inference stack",
  ].join("\n");

  const migrateResult = migrateProvider.migrate(flatContent);
  assert(
    migrateResult.imported === 4,
    `migrate() imports 4 entries (got ${migrateResult.imported})`,
  );

  const migratedEntries = migrateProvider.list();
  assert(
    migratedEntries.length === 4,
    `list() shows 4 entries after migrate (got ${migratedEntries.length})`,
  );

  const migratedUser = migrateProvider.list({ type: "user" });
  assert(migratedUser.length >= 1, "migrate() infers type=user for 'user prefers...' entry");

  const migratedRef = migrateProvider.list({ type: "reference" });
  assert(migratedRef.length >= 1, "migrate() infers type=reference for 'api endpoint...' entry");

  const migratedFeedback = migrateProvider.list({ type: "feedback" });
  assert(migratedFeedback.length >= 1, "migrate() infers type=feedback for 'feedback:...' entry");

  const migrateResult2 = migrateProvider.migrate(flatContent);
  assert(migrateResult2.imported === 0, "migrate() re-run imports 0 (all already exist)");
  assert(
    migrateResult2.skipped === 4,
    `migrate() re-run skips 4 (got ${migrateResult2.skipped})`,
  );

  rmSync(migrateDir, { recursive: true, force: true });
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
