---
title:
  page: "Workspace Files"
  nav: "Workspace Files"
description: "What workspace files are, where they live, and how they persist across sandbox restarts."
keywords: ["nemoclaw workspace files", "soul.md", "user.md", "identity.md", "agents.md", "memory.md", "sandbox persistence"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "sandboxing", "workspace", "persistence", "nemoclaw"]
content:
  type: concept
  difficulty: technical_beginner
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Workspace Files

OpenClaw stores agent identity, behavior, and memory in a set of Markdown files inside the sandbox.
These files live at `/sandbox/.openclaw/workspace/` and are read by the agent at the start of every session.

## File Reference

Each file controls a distinct aspect of the agent's behavior and memory.

| File | Purpose | Upstream Docs |
|---|---|---|
| `SOUL.md` | Core personality, tone, and behavioral rules. | [SOUL template](https://docs.openclaw.ai/reference/templates/SOUL) |
| `USER.md` | Preferences, context, and facts the agent learns about you. | [USER template](https://docs.openclaw.ai/reference/templates/USER) |
| `IDENTITY.md` | Agent name, creature type, emoji, and self-presentation. | [IDENTITY template](https://docs.openclaw.ai/reference/templates/IDENTITY) |
| `AGENTS.md` | Multi-agent coordination, memory conventions, and safety guidelines. | [AGENTS template](https://docs.openclaw.ai/reference/templates/AGENTS) |
| `MEMORY.md` | Memory index table pointing to individual topic files in `memory/topics/`. | — |
| `memory/` | Directory of daily note files (`YYYY-MM-DD.md`) for session continuity. | — |
| `memory/topics/` | Individual curated memory entries with typed YAML frontmatter. | — |

## Where They Live

All workspace files reside inside the sandbox filesystem:

```text
/sandbox/.openclaw/workspace/
├── AGENTS.md
├── IDENTITY.md
├── MEMORY.md              ← index table
├── SOUL.md
├── USER.md
└── memory/
    ├── 2026-03-18.md      ← daily note
    ├── 2026-03-19.md
    └── topics/
        ├── preferred-editor.md
        └── api-rate-limits.md
```

:::{note}
The workspace directory is hidden (`.openclaw`).
The files are not at `/sandbox/SOUL.md` — use the full path when downloading or uploading.
:::

## Persistence Behavior

Understanding when these files persist and when they are lost is critical.

| Event | Workspace files |
|---|---|
| Sandbox restart | **Preserved** — the sandbox PVC retains its data. |
| `nemoclaw <name> destroy` | **Lost** — the sandbox and its PVC are deleted. |

:::{warning}
Always back up your workspace files before running `nemoclaw <name> destroy`.
See [Back Up and Restore](backup-restore.md) for instructions.
:::

## Editing Workspace Files

The agent reads these files at the start of every session.
You can edit them in two ways:

1. **Let the agent do it** — Ask your agent to update its persona, memory, or user context during a session.
2. **Edit manually** — Use `openshell sandbox connect` to open a terminal inside the sandbox and edit files directly, or use `openshell sandbox upload` to push edited files from your host.

## Memory Index and Topic Files

`MEMORY.md` serves as a curated index of one-line entries, each pointing to a topic file under `memory/topics/`.
Topic files use YAML frontmatter with a typed schema.

Each topic file has a `type` field that categorizes the memory entry:

| Type | When to use |
|---|---|
| `user` | Preferences, habits, and context about the user. |
| `project` | Project structure, conventions, and tooling choices. |
| `decision` | Architectural or design decisions with rationale. |
| `reference` | Frequently-referenced facts, APIs, or commands. |

**Daily notes vs curated memory:**
Use daily notes (`memory/YYYY-MM-DD.md`) for ephemeral session context.
Use topic files (`memory/topics/`) for durable facts that should persist across sessions.

The index has a soft cap of ~200 entries and individual topic files have a soft cap of ~500 lines.
Use `/nemoclaw memory` inside the agent chat to view memory stats.

## Next Steps

- [Back Up and Restore workspace files](backup-restore.md)
- [Commands reference](../reference/commands.md)
