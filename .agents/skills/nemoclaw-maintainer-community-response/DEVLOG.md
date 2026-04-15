<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Community Response Skill — Development Log

A living record of decisions, changes, and context for this skill.
Auto-maintained via [claude-devlog-skill](https://github.com/code-katz/claude-devlog-skill). Entries are reverse-chronological.

---

## [2026-04-13] NemoClaw community response skill and project workflow established

**Category:** `milestone`
**Tags:** `community`, `maintainer-tooling`, `github-projects`, `skill`, `workflow`
**Risk Level:** `low`
**Breaking Change:** `no`

### Summary

Built a complete community response workflow for NemoClaw maintainers, including this agent skill, updated maintainer guide docs, a project workflow reference, and a feature request parking system using the existing label structure.

### Detail

- Created `SKILL.md` — drafts community-facing responses to GitHub issues and PRs. For each item it recommends an action (comment, close, request changes, escalate), a project board status, and suggested labels. Reads `docs/maintainer-guide-snippet.md` and `docs/project-workflow.md` at runtime so it never works from stale memory.
- Added `docs/maintainer-guide.md` and `docs/maintainer-guide-snippet.md` (previously untracked local files) — covers 9 response situations: won't-fix, superseded PR, poorly designed PR, duplicates, feature requests, Discussion redirects, triage acknowledgment, needs-info (label + close), and response time norms.
- Added `docs/project-workflow.md` — defines project board status semantics, the three-tier label structure (Type + Sub-type + Dimension), board setup instructions for Enhancement Parking and Platform/Integration views, and the promotion flow from `No Status` → `Backlog` → `In Progress`.
- Approved responses are logged to `~/development/daily-rhythm/activity/nemoclaw-community-responses.md` for long-term record keeping (persisted via GitLab through the daily-rhythm repo).
- 44+ issues closed in the first session using the skill.

### Decisions Made

- **Log location:** Response log moved from `.nemoclaw-maintainer/community-responses.md` (gitignored, local to NemoClaw repo) to `daily-rhythm/activity/nemoclaw-community-responses.md` so it persists to GitLab and is available for long-term reporting and activity summaries.
- **Feature request status:** New feature requests get `No Status` (unreviewed) not `Backlog`. Only a maintainer who has explicitly reviewed and approved an item sets `Backlog`. This prevents the false signal of "added to backlog" in community responses.
- **Label structure over custom Project field:** Used the existing three-tier label system (`enhancement` + `enhancement: *` sub-labels + `Platform/Integration/Provider: *` dimension labels) for categorization instead of adding a custom field to the GitHub Project. No new infrastructure needed.
- **Skill reads live docs:** The skill reads guide files at runtime rather than encoding templates in the skill itself. Updating the guide updates skill behavior without touching the skill file.
- **Tone:** Community first, firm and friendly — lead with acknowledgment, hold the line when needed, never dismissive.

### Related

- Skill: [SKILL.md](SKILL.md)
- Guide: [docs/maintainer-guide.md](../../../docs/maintainer-guide.md)
- Workflow: [docs/project-workflow.md](../../../docs/project-workflow.md)
- Response log: `~/development/daily-rhythm/activity/nemoclaw-community-responses.md`
- Branch: `feat/community-response-skill` (based on `cv/maintainer-skills`)
