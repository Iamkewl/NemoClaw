---
name: nemoclaw-maintainer-community-response
description: Drafts community-facing responses to GitHub issues and PRs for NemoClaw maintainers. For each item, recommends an action (comment, close, close+comment, request changes, escalate) and drafts the response text. Handles won't-fix closures, out-of-scope closures, superseded PRs, poorly designed PR rejections, security acknowledgments, duplicate issues, feature request routing, needs-info labeling, and general triage. Logs approved responses locally to ~/development/daily-rhythm/activity/nemoclaw-community-responses.md. Tone: community first, firm and friendly. Trigger keywords - respond to issue, close issue, respond to PR, community response, won't fix, out of scope, reject PR, triage response, draft response, what should I say, needs info, duplicate issue, feature request, stale sweep, 7-day warning, 14-day close, run stale sweep, find stale.
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
| Needs info (7-day warning) | Labeled `status: needs-info`, 7 days elapsed, no response — post warning |
| Needs info (close) | Labeled `status: needs-info`, 14 days elapsed, no response — close |
| Rebase (7-day warning) | Labeled `status: rebase`, 7 days elapsed, no response — post warning |
| Rebase (close) | Labeled `status: rebase`, 14 days elapsed, no response — close |

If the situation is ambiguous, ask: "Is this a closure, a needs-info, a routing decision, or something else?"

## Step 4: Recommend an Action and Project Status

State the recommended action and **project status** clearly before drafting. The project status field must be set on every item — do not leave it as "Done" by default.

**Actions:**

| Action | When |
|---|---|
| `comment` | Post a reply, leave open (triage ack, needs-info first contact, redirect to Discussions) |
| `close` | Close with comment |
| `request changes` | PR needs revision — post comment, leave open |
| `comment + label` | Post comment AND apply a label (e.g., rebase nudge → apply `status: rebase`) |
| `escalate` | Security report that should go through PSIRT — do not respond publicly |
| `rebase nudge` | PR has **verified** merge conflicts (`mergeable_state=dirty` only) — post comment asking author to rebase, apply `status: rebase`. See rebase gate in Step 5. |
| `integration hold` | PR has any `Integration: *` label — post integration evaluation holding comment instead of rebase nudge. Never apply `status: rebase` to integration PRs regardless of merge state. |

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

Always present as: **Action:** `close` · **Project status:** `Won't Fix` (for closures)

## Step 5: Draft the Response

Write the response following the template from the guide. Apply these rules:

- **Always explain why** when closing — never close silently.
- **Acknowledge contributors** when their work informed a solution, even if it didn't land.
- **Be specific** — name the exact reason, the exact information needed, the exact problem with the PR.
- **One sentence on why.** Not a paragraph. Not a list.
- Write in second person, direct address to the contributor.
- Warm but specific — generic phrases without substance read as dismissive.
- Never reference internal systems, roadmap items, or org decisions that shouldn't be public.
- **7-day notice in first-contact comments:** When posting a `needs-info` comment or `rebase nudge`, include a one-sentence notice at the end of the comment: "If we don't hear back within 7 days, we'll post a reminder; items with no response at 14 days are closed to keep the queue healthy."
- **Hedged language for risks and impacts:** Do not assert that something IS a risk or problem. Use acknowledging, hedged language: "could be", "may", "worth noting", "potentially". Example: "unbounded CPU/memory could be an operational risk" — not "is a real operational risk". This applies to security, performance, correctness, and other concerns raised in response comments.
- **Rebase verification gate (mandatory before any rebase nudge):** Before posting a rebase nudge or applying `status: rebase`, check the PR's actual merge state:
  ```bash
  gh api repos/NVIDIA/NemoClaw/pulls/<number> --jq '"\(.mergeable) \(.mergeable_state)"'
  ```
  Only proceed with the rebase nudge if `mergeable_state` is `dirty` (actual merge conflict). Do NOT send a rebase nudge if the state is:
  - `blocked` — PR merges cleanly, needs review or CI sign-off
  - `unstable` — PR merges cleanly, CI is failing
  - `unknown` — GitHub hasn't computed yet; re-check before acting

  If the state is not `dirty`, do not apply `status: rebase`. Choose the correct action for the actual state instead.

- **Integration PRs — no rebase nudge:** If the PR already has any `Integration: *` label, post the integration evaluation holding comment instead. Do not apply `status: rebase` to integration PRs regardless of merge state.

- **PRs requiring rebase:** After posting the comment, always apply `status: rebase` via:
  ```bash
  gh pr edit <number> --repo NVIDIA/NemoClaw --add-label "status: rebase"
  ```
  This keeps rebase-blocked PRs distinct from needs-info PRs and surfaces them for follow-up separately.
- **Same contributor on multiple PRs needing rebase:** If the contributor who owns this PR also has another open PR that needs a rebase, note it in the comment — suggest a joint rebase on both at once. Example addition: "Note this is from the same contributor as #[N] — a joint rebase on both would be ideal." Apply `status: rebase` to both PRs. Check for contributor overlap before sending any rebase nudge.

- **Author identification:** For every PR, check whether the author is an NVIDIA org member before drafting:
  ```bash
  gh api orgs/NVIDIA/members/<username> --silent 2>/dev/null && echo "NVIDIA member" || echo "external"
  ```
  Include in the draft presentation header as: **Author:** username (NVIDIA) or **Author:** username (external).

- **Git fetch rule:** Always run `git fetch origin` before any supersession check, especially in long sessions. Re-fetch at the start of any session that resumes after more than 2 hours of inactivity.

- **Session resume validation:** When resuming after a break:
  1. Run `git fetch origin` to get the latest main
  2. For any PRs already queued but not yet actioned, verify they are still open before proceeding:
     ```bash
     gh api repos/NVIDIA/NemoClaw/pulls/<number> --jq '.state'
     ```
     Skip any PR that returns `"closed"`.

## Step 6: Present for Approval

Show the user:

1. **Recommended action and project status** (e.g., `close` · project status: `Won't Fix`)
   **Author:** username (NVIDIA) or username (external)
   **Opened:** YYYY-MM-DD (N days ago)
2. **Draft response** (ready to paste into GitHub)
3. Any follow-up note (e.g., "add the label before closing")

Ask: "Want me to adjust the tone or any specific wording?"

## Step 7: Log the Approved Response

When the user approves, append to `~/development/daily-rhythm/activity/nemoclaw-community-responses.md`.

Use the absolute path — this file lives in the daily-rhythm activity folder so it is persisted to GitLab over time, not in the NemoClaw repo.

```
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

## Batch Mode

When processing multiple PRs in one session, present a batch analysis table before drafting any individual responses:

```
┌───────┬──────────┬──────────┬────────┬──────────────┬───────┐
│  PR   │  Author  │   NV?    │ Opened │    Action    │ Notes │
├───────┼──────────┼──────────┼────────┼──────────────┼───────┤
│ #1234 │ username │ external │ Apr 10 │ rebase nudge │ dirty │
└───────┴──────────┴──────────┴────────┴──────────────┴───────┘
```

Columns:
- **PR** — number with #
- **Author** — GitHub username
- **NV?** — `NVIDIA` or `external`
- **Opened** — `Mon DD` format
- **Action** — recommended action from Step 4
- **Notes** — merge state (dirty/blocked/unknown), label flags, or other relevant context

Ask the user to confirm or adjust the batch plan before proceeding to draft responses one by one.

## Stale Sweep

**Trigger phrases:** "stale sweep", "run stale sweep", "7-day warnings", "14-day closures", "find stale", "stale check"

Runs Stage 2 (7-day warning) and/or Stage 3 (14-day close) for items carrying `status: needs-info` or `status: rebase`. Ask the user which stage(s) to run if not specified.

### Step A: Discover candidates

Run all queries:

```bash
# Issues with status: needs-info
gh issue list --repo NVIDIA/NemoClaw --label "status: needs-info" --state open \
  --json number,title,author,url --limit 200

# PRs with status: needs-info
gh pr list --repo NVIDIA/NemoClaw --label "status: needs-info" --state open \
  --json number,title,author,url --limit 200

# PRs with status: rebase
gh pr list --repo NVIDIA/NemoClaw --label "status: rebase" --state open \
  --json number,title,author,url --limit 200
```

### Step B: Determine label age and author activity

For each candidate, check when the relevant label was last applied:

```bash
gh api repos/NVIDIA/NemoClaw/issues/<number>/events \
  --jq '[.[] | select(.event == "labeled" and .label.name == "status: needs-info")] | last | .created_at'
```

Use `"status: rebase"` for rebase items. Compute age in days from today.

**For `status: needs-info` items only** — also check when the author last commented:

```bash
gh api repos/NVIDIA/NemoClaw/issues/<number>/comments \
  --jq '[.[] | select(.user.login == "<author>")] | last | .created_at'
```

If the author's last comment is **after** the label was applied, the author has responded since labeling. Do NOT include this item in the warning or close buckets. Move it to the "responded" group (Step D) for label review. The `status: needs-info` label may no longer apply — the maintainer should re-triage.

Note: this author-activity check does not apply to `status: rebase` items. A PR comment does not resolve merge conflicts; rebase state is determined by code, not by conversation.

Bucket each item:
- **Author commented after label** → responded — review for label removal (needs-info only)
- **7–13 days, no author response** → Stage 2 candidate (warning)
- **14+ days, no author response** → Stage 3 candidate (close)
- **< 7 days, no author response** → ignore

### Step C: Check author NVIDIA membership

For every candidate:

```bash
gh api orgs/NVIDIA/members/<username> --silent 2>/dev/null && echo "NVIDIA member" || echo "external"
```

### Step D: Present candidates by stage

Present tables by category. If a category has no candidates, say so explicitly.

**Responded since labeled — review for label removal (needs-info only):**
```
┌───────┬────────┬────────────┬──────────┬──────────┬─────────────────────┐
│  #    │  Type  │  Author    │   NV?    │ Label Age│ Last Author Comment │
├───────┼────────┼────────────┼──────────┼──────────┼─────────────────────┤
│ #1234 │ issue  │ username   │ external │    8d    │ Apr 13 (after label)│
└───────┴────────┴────────────┴──────────┴──────────┴─────────────────────┘
```
These items need re-triage, not automated action. Ask the maintainer: "Author has responded — does their reply address the request? If yes, remove `status: needs-info` and re-triage. If no, leave the label in place."

**Stage 2 — Warning (7–13 days):**
```
┌───────┬────────┬────────────┬──────────┬────────────┬──────┬─────────┐
│  #    │  Type  │  Author    │   NV?    │   Label    │  Age │ Action  │
├───────┼────────┼────────────┼──────────┼────────────┼──────┼─────────┤
│ #1234 │ issue  │ username   │ external │ needs-info │  8d  │ warning │
└───────┴────────┴────────────┴──────────┴────────────┴──────┴─────────┘
```

**Stage 3 — Close (14+ days):**
```
┌───────┬────────┬────────────┬──────────┬────────────┬──────┬─────────┐
│  #    │  Type  │  Author    │   NV?    │   Label    │  Age │ Action  │
├───────┼────────┼────────────┼──────────┼────────────┼──────┼─────────┤
│ #1235 │ PR     │ username2  │ external │ rebase     │ 21d  │  close  │
└───────┴────────┴────────────┴──────────┴────────────┴──────┴─────────┘
```

Ask: "Confirm which items to action — remove any to skip."

If no candidates in either stage, report that and stop.

### Step E: Draft and post — Stage 2 (warning)

For each confirmed Stage 2 item, present the draft before posting. Leave the item **open** — do NOT close at Stage 2.

**Template — needs-info warning:**
> Just a friendly nudge — we're still waiting on the information requested above. If we don't hear back within 7 days, we'll close this to keep the queue healthy. Feel free to reopen any time if you'd like to continue.

**Template — rebase warning:**
> Just a friendly nudge — this PR still has merge conflicts. If the rebase isn't completed within 7 days, we'll close this to keep the queue healthy. Feel free to reopen once it's rebased, or open a new PR.

```bash
gh issue comment <number> --repo NVIDIA/NemoClaw --body "<warning comment>"
gh pr comment <number> --repo NVIDIA/NemoClaw --body "<warning comment>"
```

### Step F: Draft and post — Stage 3 (close)

For each confirmed Stage 3 item, present the draft before posting.

**Template — needs-info close:**
> Closing due to inactivity — it's been 14 days since we requested additional information and we haven't heard back. Feel free to reopen if you're able to follow up, or open a new issue with the requested details included. Thanks for contributing to NemoClaw.

**Template — rebase close:**
> Closing due to inactivity — this PR has had merge conflicts for 14 days without an update. Feel free to reopen once it's rebased against the latest main, or open a new PR to continue the work. Thanks for contributing to NemoClaw.

```bash
gh issue close <number> --repo NVIDIA/NemoClaw --comment "<closing comment>"
gh pr close <number> --repo NVIDIA/NemoClaw --comment "<closing comment>"
```

### Step G: Log each actioned item

For every Stage 2 warning and Stage 3 closure, append to the log using the Step 7 format:

- Stage 2: **Action:** `comment` · **Project status:** `No Status`
- Stage 3: **Action:** `close` · **Project status:** `No Status`

## Response Time Check

If the user asks whether a response window is at risk, check against:

| Situation | Target |
|---|---|
| New issue | First response ≤ 5 business days |
| Open PR, no review | First comment ≤ 7 business days |
| Contributor asks for update | Reply ≤ 3 business days |
| `status: needs-info` labeled | Warning at 7 days, close at 14 days |
| `status: rebase` labeled | Warning at 7 days, close at 14 days |

A window is "at risk" when 80% of the target has elapsed. Surface as a flag, not an alarm.
