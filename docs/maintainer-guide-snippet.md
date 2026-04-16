---
orphan: true
title: "NemoClaw Community Engagement Quick Reference"
description: "Quick reference card for NemoClaw maintainers — closing, merging, rejecting, duplicates, feature requests, triage, and needs-info flows."
keywords: maintainer, community, triage, quick reference
topics: [maintainer, community]
tags: [maintainer, community]
content_type: reference
difficulty: beginner
audience: maintainers
status: active
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw — Community Engagement Quick Reference

> - **Always explain why** when closing — never close silently.
> - **Acknowledge contributors** when their work informs a merged solution, even if their PR didn't land.
> - **Security reporters get credit** — even when the fix goes through PSIRT, not GitHub.
> - **Be specific when declining** — vague feedback wastes everyone's time and damages trust.
> - **Route, don't reject** feature requests — backlog or Discussions, never silence.
> - **Name what you need** when asking for info — and give the contributor 7 days to respond.

---

## Closing Won't Fix / Out of Scope

| Reason | Label | Board status |
|---|---|---|
| Valid issue, won't address | `wontfix` | `Won't Fix` |
| Outside project design/scope | `wontfix` | `Won't Fix` |
| Good idea, needs a proposal first | `wontfix` | `Won't Fix` |

> Thanks for raising this.
> After review, we're closing as **[label]** because [one sentence].
> See [CONTRIBUTING.md](https://github.com/NVIDIA/NemoClaw/blob/main/CONTRIBUTING.md) for scope guidance.
> We appreciate you taking the time.

---

## When Your Merge Supersedes Another PR

Comment on the closed PR before you merge:

> Closing in favor of #[N], which was merged and covers the same ground. Your [approach / test cases / edge case] helped shape the solution that landed — thanks for working on this.

**Security PRs:** Always acknowledge the finding explicitly, even when the fix went through PSIRT:

> Thanks for identifying this. The fix followed our [coordinated disclosure process](https://github.com/NVIDIA/NemoClaw/blob/main/SECURITY.md), but your report is a real contribution and we want to recognize it.

---

## Rejecting a Poorly Designed PR

1. **Acknowledge intent** — one sentence on what they were solving
2. **Name the specific problem** — don't say "not quite right," say why
3. **Give a path forward** — what would need to change, or ask them to start in an issue first

> Thanks for tackling [X] — it's a real gap. The approach here [specific problem]. Before we could accept this, we'd need [specific ask]. Happy to discuss the right approach in the issue first.

---

## Closing Duplicates

> Thanks for the report.
> This is a duplicate of #[N] — all discussion is happening there.
> Closing in favor of the original thread.
> Feel free to add context or subscribe to #[N] to follow along.

**Label:** `duplicate` · **Board status:** `Duplicate`

---

## Feature Requests

> Thanks for the suggestion. We've noted this and will review it — we'll update this issue if it moves forward. We don't have a timeline to share yet.

**Project status:** `No Status` (do NOT say "added to backlog" — that implies approval)

**Labels:** Always apply `enhancement` + the most specific sub-label (`enhancement: inference`, `enhancement: ui`, etc.) + any Tier 3 dimension labels (`Integration: Slack`, `Platform: macOS`, `Provider: NVIDIA`, etc.)

*Full label reference: [docs/project-workflow.md](project-workflow.md)*

---

## Redirecting to Discussions

> This looks like a great topic for an open conversation rather than a bug or feature request. I've moved this to Discussions here: [link]. Closing the issue to keep the tracker focused on actionable items.

---

## Triage Acknowledgment

> Thanks for the detailed report — we've confirmed this and added it to our backlog. We don't have a timeline to share yet, but we've got it on our radar. We'll update this issue when work begins.

---

## Needs Info

**Day 0 — first contact:** label `status: needs-info`, leave open:

> Thanks for the report. To move forward, we need: [specific ask]. We'll keep this open for 14 days.

**Day 7 — warning** (no response yet):

> We haven't heard back yet. If this is still affecting you, please share [repeat specific ask]. We'll close this in 7 days if we don't hear back.

**Day 14 — close:**

> Closing due to no response. If this is still happening, please open a new issue and include [repeat the specific ask]. Happy to take another look.

## Needs Rebase

**Day 0 — rebase nudge:** apply `status: rebase`, post comment asking to rebase.

**Day 7 — warning** (no rebase yet):

> This PR still needs a rebase. Please rebase against `main` within the next 7 days.

**Day 14 — close:**

> Closing due to inactivity — please open a new PR rebased against `main` if you'd like to continue.

---

## Response Time Commitments

| Situation | Target |
|---|---|
| New issue | First response < 3 business days |
| Open PR, no review | First comment < 5 business days |
| Contributor asks for update | Reply ≤ 3 business days |

If you'll miss a window — post an update before it lapses.

---

*Full guide: [docs/maintainer-guide.md](maintainer-guide.md) · Scope: [CONTRIBUTING.md](https://github.com/NVIDIA/NemoClaw/blob/main/CONTRIBUTING.md) · Security: [SECURITY.md](https://github.com/NVIDIA/NemoClaw/blob/main/SECURITY.md)*

---

## Next Steps

- [Maintainer Guide](maintainer-guide.md) — full workflows, decision trees, and templates
- [Project Workflow](project-workflow.md) — board status semantics and label taxonomy
