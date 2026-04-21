<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Skills Eval — Quick Start

Skills are docs that drive an AI agent. This system measures whether each user-facing skill actually makes the agent better. CI grades touched skills on every PR; a nightly job re-grades the whole catalog and refreshes the public scoreboard.

**Scope:** `nemoclaw-user-*` skills only. Maintainer and contributor skills are out of scope.

## TL;DR

Three things to remember:

1. **Touched a `nemoclaw-user-*` skill in a PR?** CI grades it. A sticky comment shows the delta vs. the merged baseline.
2. **Want to grade a skill locally?** `npm run eval:skills -- --skills <name>`. Needs `ANTHROPIC_API_KEY`.
3. **Want the current state of every skill?** Read `ci/skills-scoreboard.md` and `ci/eval-reports/weakest-links.md`.

## I want to...

| Goal | Do this |
|------|---------|
| Grade my changed skill before pushing | `npm run eval:skills -- --skills <skill>` |
| Grade every skill I touched on this branch | `npm run eval:skills -- --changed-only` |
| See all skills' current health | open `ci/skills-scoreboard.md` |
| See which skills need fixing first | open `ci/eval-reports/weakest-links.md` |
| See which skills earn their context cost | open `ci/eval-reports/value-vs-cost.md` |
| Render the two reports locally | `npx tsx scripts/render-eval-reports.ts --input ci/skills-eval-latest.json --skills-dir .agents/skills --output-dir ci/eval-reports` |
| Add Haiku-narrated prose to the reports | append `--narrate` to the command above |
| Write evals for a new skill | read [`EVALS.md`](EVALS.md) (the rubric) |
| Bypass the gate in an emergency | label the PR `skip-skills-eval` |
| Understand the CI gate in depth | read [`ci/skills-eval-policy.md`](../../ci/skills-eval-policy.md) |

## What CI does on your PR

1. Detects which `nemoclaw-user-*` skills changed.
2. For each, runs the agent twice per scenario — with the skill's `SKILL.md` loaded, then without. The judge grades both.
3. Computes per-skill **delta** (with − without). Compares against `ci/skills-eval-baseline.json`.
4. Posts a sticky PR comment with the result.

The build fails if any touched skill drops more than **10pp** from baseline OR ends below zero. New skills (no baseline yet) pass as long as delta ≥ 0.

Fork PRs get an informational status check, not a failure — a maintainer reruns the gate after initial review.

## What the nightly job does on `main`

Daily at 08:00 UTC the `skills-eval-nightly` workflow:

- Re-grades every user skill.
- Refreshes `ci/skills-eval-baseline.json` (this *moves* the baseline).
- Updates `ci/skills-scoreboard.md` and the pinned "NemoClaw Skills Scoreboard" issue.
- Regenerates `ci/eval-reports/weakest-links.md` and `value-vs-cost.md` (Haiku-narrated when narration succeeds).
- Opens a PR (`chore/skills-eval-nightly-refresh`) for maintainer review. **Merging that PR is what commits the new baseline.**

## Reading the reports

| File | Question it answers |
|------|---------------------|
| `ci/skills-scoreboard.md` | Is each skill healthy *right now*? Delta + 7-day trend per skill. |
| `ci/eval-reports/weakest-links.md` | Which skills are hurting the agent or barely earning their place? Fix these first. |
| `ci/eval-reports/value-vs-cost.md` | Which skills give the most help per token of context they consume? |

## Common gotchas

- **`TODO:` stubs in `evals.json` are blocked at pre-push.** Write real assertions before pushing.
- **`evals[].id` must never be reused or renumbered** — the baseline references scenarios by ID.
- **First run on a new skill?** It passes the gate as long as delta ≥ 0; the next nightly establishes its baseline.
- **Cost ceiling:** typical PR-side run < $0.50, hard cap $2.50 per PR. Nightly cap $25.

## Going deeper

- [`EVALS.md`](EVALS.md) — authoring rubric (how to write scenarios + assertions that grade well)
- [`ci/skills-eval-policy.md`](../../ci/skills-eval-policy.md) — full CI policy (regression rules, baseline cadence, fork handling, bypass label, secret rotation)
- [`scripts/evaluate-skills.ts`](../../scripts/evaluate-skills.ts) — the runner
- [`scripts/render-eval-reports.ts`](../../scripts/render-eval-reports.ts) — the report renderer
- [`scripts/update-skills-scoreboard.ts`](../../scripts/update-skills-scoreboard.ts) — the scoreboard generator
