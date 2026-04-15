---
name: nemoclaw-maintainer-community-response
description: Drafts community-facing responses to GitHub issues and PRs for NemoClaw maintainers. For each item, recommends an action (comment, close, request changes, escalate) and drafts the response text. Handles won't-fix closures, out-of-scope closures, superseded PRs, poorly designed PR rejections, security acknowledgments, duplicate issues, feature request routing, needs-info labeling, and general triage. Tone: community first, firm and friendly. Trigger keywords - respond to issue, close issue, respond to PR, community response, won't fix, out of scope, reject PR, triage response, draft response, what should I say, needs info, duplicate issue, feature request.
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Maintainer — Community Response

Draft a response to a GitHub issue or PR, recommend an action, and log the approved response.

**Tone:** Community first, firm and friendly. Lead with acknowledgment. Hold the line when needed. Never dismissive.

## Step 1: Read the Guides

Before drafting, read both reference docs:

```bash
cat docs/maintainer-guide-snippet.md
cat docs/project-workflow.md
```

Do not draft from memory. The guides may have been updated. `maintainer-guide-snippet.md` has the response templates. `project-workflow.md` has the status semantics and full label structure.

## Step 2: Gather Context

Ask the user (or infer from context) for:

- Issue or PR number and title
- Body text (or summary if long)
- Any existing comments relevant to the response
- Whether this is an issue or a PR

If the user provides a URL or number only, ask for the body text — don't assume.

## Step 3: Identify the Situation

Map the item to one of the situations in the guide:

| Situation | When |
|---|---|
| Won't fix / out of scope / needs design | Valid item, but won't be addressed or is outside scope |
| Superseded PR | Another PR was merged that covers the same ground |
| Security acknowledgment | Contributor reported or fixed a vulnerability |
| Poorly designed PR | PR cannot merge as-is; needs specific changes |
| Duplicate | Same issue or PR already exists |
| Feature request | Valid suggestion, not a bug — route to parking |
| Redirect to Discussions | Open-ended question or design topic, not actionable |
| Triage acknowledgment | Valid open issue, confirmed, no timeline yet |
| Needs info (first contact) | Can't investigate without more information from contributor |
| Needs info (day-7 warning) | Labeled `status: needs-info`, 7 days elapsed, no response yet |
| Needs info (close) | Labeled `status: needs-info`, 14 days elapsed, no response |

If the situation is ambiguous, ask: "Is this a closure, a needs-info, a routing decision, or something else?"

## Step 4: Recommend an Action and Project Status

State the recommended action and **project status** clearly before drafting. The project status field must be set on every item — do not leave it as "Done" by default.

**Actions:**

| Action | When |
|---|---|
| `comment` | Post a reply, leave open (triage ack, needs-info first contact, redirect to Discussions) |
| `warning` | Day-7 reminder on needs-info or needs-rebase items — post friendly heads-up, do NOT close |
| `close` | Close with comment |
| `request changes` | PR needs revision — post comment, leave open |
| `comment + label` | Post comment AND apply a label (e.g., rebase nudge → apply `status: rebase`) |
| `escalate` | Security report that should go through PSIRT — do not respond publicly |
| `rebase nudge` | PR has merge conflicts or is significantly out of date — post comment asking author to rebase, apply `status: rebase` |

**Project status mapping (NemoClaw Development Tracker):**

| Situation | Project Status |
|---|---|
| Won't fix | `Won't Fix` |
| Out of scope / needs design | `Won't Fix` |
| Duplicate / superseded PR | `Duplicate` |
| Feature request (new, unreviewed) | `No Status` |
| Feature request (approved for future) | `Backlog` — only set this if maintainer has explicitly approved |
| Needs review / poorly designed PR | `Needs Review` |
| Triage acknowledgment (confirmed, backlogged) | `Backlog` |
| Needs info (first contact or close) | `No Status` |
| Completed / merged | `Done` |
| NVQA-tracked item | `NVQA` |

**For feature requests — also suggest labels** (read label structure from `project-workflow.md`):

1. Always suggest `enhancement` as the base label
2. Suggest the most specific Tier 2 sub-label that fits (e.g., `enhancement: inference`, `enhancement: ui`)
3. Suggest Tier 3 dimension label(s) if platform-, integration-, or provider-specific (e.g., `Integration: Slack`, `Platform: MacOS`)

Present as: **Action:** `comment` · **Project status:** `No Status` · **Suggested labels:** `enhancement`, `enhancement: inference`

For closures, use the project status from the mapping table above — `Won't Fix`, `Duplicate`, or `No Status` depending on the situation.

## Step 5: Draft the Response

Write the response following the template from the guide. Apply these rules:

- **Always explain why** when closing — never close silently.
- **Acknowledge contributors** when their work informed a solution, even if it didn't land.
- **Be specific** — name the exact reason, the exact information needed, the exact problem with the PR.
- **One sentence on why.** Not a paragraph. Not a list.
- Write in second person, direct address to the contributor.
- Warm but specific — generic phrases without substance read as dismissive.
- Never reference internal systems, roadmap items, or org decisions that shouldn't be public.
- **PRs requiring rebase:** After posting the comment, always apply `status: rebase` via:

  ```bash
  gh pr edit <number> --repo NVIDIA/NemoClaw --add-label "status: rebase"
  ```

  This keeps rebase-blocked PRs distinct from needs-info PRs and surfaces them for follow-up separately.
- **Same contributor on multiple PRs needing rebase:** If the contributor who owns this PR also has another open PR that needs a rebase, note it in the comment — suggest a joint rebase on both at once. Example addition: "Note this is from the same contributor as #[N] — a joint rebase on both would be ideal." Apply `status: rebase` to both PRs. Check for contributor overlap before sending any rebase nudge.

## Step 6: Present for Approval

Show the user:

1. **Recommended action and project status** (e.g., `close` · project status: `Won't Fix`)
2. **Draft response** (ready to paste into GitHub)
3. Any follow-up note (e.g., "add the label before closing")

Ask: "Want me to adjust the tone or any specific wording?"

## Step 7: Log the Approved Response

When the user approves, append to `~/development/daily-rhythm/activity/nemoclaw-community-responses.md`.

Use the absolute path — this file lives in the daily-rhythm activity folder so it is persisted to GitLab over time, not in the NemoClaw repo.

```markdown
## [ISSUE|PR] NVIDIA/NemoClaw#<number> — <title>
**Date:** YYYY-MM-DD
**Action:** comment | close | request changes | escalate
**Project status:** <status>
**Labels:** <suggested or applied labels>

**Response:**
<approved response text>

---
```

Create the file if it doesn't exist. Never stage or commit this file to the NemoClaw repo.

