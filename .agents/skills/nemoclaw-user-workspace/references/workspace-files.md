<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
# Workspace Files

OpenClaw stores its personality, user context, and behavioral configuration in a set of Markdown files inside the sandbox.
These files live at `/sandbox/.openclaw/workspace/` and are collectively called **workspace files**.

## File Reference

| File | Purpose |
|---|---|
| `SOUL.md` | Defines the agent's persona, tone, and communication style. |
| `USER.md` | Stores information about the human the agent assists. |
| `IDENTITY.md` | Short identity card — name, language, emoji, creature type. |
| `AGENTS.md` | Behavioral rules, memory conventions, safety guidelines, and session workflow. |
| `MEMORY.md` | Memory index table pointing to individual topic files in `memory/topics/`. |
| `memory/` | Directory of daily note files (`YYYY-MM-DD.md`) for session continuity. |
| `memory/topics/` | Individual curated memory entries with typed YAML frontmatter. |

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

## Persistence Behavior

Understanding when these files persist and when they are lost is critical.

### Survives: Sandbox Restart

Sandbox restarts (`openshell sandbox restart`) preserve workspace files.
The sandbox uses a **Persistent Volume Claim (PVC)** that outlives individual container restarts.

### Lost: Sandbox Destroy

Running `nemoclaw <name> destroy` **deletes the sandbox and its PVC**.
All workspace files are permanently lost unless you back them up first.

> **Warning:** Always back up your workspace files before running `nemoclaw <name> destroy`.
> See Backup and Restore (see the `nemoclaw-user-workspace` skill) for instructions.

## Editing Workspace Files

The agent reads these files at the start of every session.
You can edit them in two ways:

1. **Let the agent do it** — Ask your agent to update its persona, memory, or user context.
2. **Edit manually** — Use `openshell sandbox shell` to open a terminal inside the sandbox and edit files directly, or use `openshell sandbox upload` to push edited files from your host.

## Memory Index and Topic Files

`MEMORY.md` serves as a curated index of one-line entries, each pointing to a topic file under `memory/topics/`.
Topic files use YAML frontmatter with a typed schema.

Each topic file has a `type` field that categorizes the memory entry:

| Type | When to use |
|---|---|
| `user` | Preferences, habits, and context about the user. |
| `project` | Project structure, conventions, and tooling choices. |
| `feedback` | Guidance on how to approach work, corrections, and confirmations. |
| `reference` | Frequently-referenced facts, APIs, or commands. |

**Daily notes vs curated memory:**
Use daily notes (`memory/YYYY-MM-DD.md`) for ephemeral session context.
Use topic files (`memory/topics/`) for durable facts that should persist across sessions.

The index has a soft cap of ~200 entries and individual topic files have a soft cap of ~500 lines.
Use `/nemoclaw memory` inside the agent chat to view memory stats.

## Next Steps

- Backup and Restore workspace files (see the `nemoclaw-user-workspace` skill)
- Commands reference (see the `nemoclaw-user-reference` skill)
