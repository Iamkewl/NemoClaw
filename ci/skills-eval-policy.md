<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Skills Evaluation CI Policy

Defines how NemoClaw's skill evaluations gate pull requests: delta-regression thresholds, baseline management, model choices, cost caps, secret handling, and the fork-PR fallback. Paired with `.agents/skills/EVALS.md` (authoring rubric) and `.context/judge-prompt-v0.md` (judge prompt + calibration).

**Scope: `nemoclaw-user-*` skills only.** The gate applies exclusively to user-facing skills. Maintainer skills (`nemoclaw-maintainer-*`) and contributor skills (`nemoclaw-contributor-*`) are out of scope for the shared eval system — those are internal workflows whose quality is better judged by the maintainers using them, not by a general-purpose judge measuring end-user experience. PRs that touch only non-user skills skip this gate entirely.

## At a glance

| Policy area | Value |
|-------------|-------|
| Agent model | `claude-sonnet-4-6` |
| Judge model | `claude-haiku-4-5-20251001` |
| Gate type | Delta-regression, not absolute |
| Delta-drop tolerance | 10 percentage points |
| Absolute floor | `delta ≥ 0` (skill must not make things worse) |
| Baseline source | Nightly run on `main`, stored in `ci/skills-eval-baseline.json` |
| Per-PR scope | Only skills whose files changed |
| Per-PR budget cap | $2.50 hard ceiling; typical run <$0.50 |
| Secret | `ANTHROPIC_API_KEY` (repo-level GitHub secret) |
| Fork PRs | Neutral status check, not a failure |
| Emergency bypass | Label `skip-skills-eval` on the PR |

## Scoring recap (from the plan)

For each scenario we run the agent twice: once with the skill's `SKILL.md` loaded, once without. The judge grades both responses against the scenario's assertions. A scenario's **delta** is the with-skill score minus the without-skill score. A skill's delta is the mean across its scenarios.

```text
scenario.with_score    = mean(assertion.satisfied for assertion in scenario.assertions  with skill)
scenario.without_score = mean(assertion.satisfied for assertion in scenario.assertions  without skill)
scenario.delta         = scenario.with_score - scenario.without_score

skill.delta            = mean(scenario.delta for scenario in skill.scenarios)
```

Scores are in `[0, 1]`; deltas are in `[-1, 1]`.

## Regression semantics

### Rule 1 — Delta-drop tolerance

A PR fails if any touched skill's delta drops by more than **10 percentage points** versus its baseline:

```text
fail_rule_1 = (skill.baseline_delta - skill.current_delta) > 0.10
```

Rationale: skills are noisy at the assertion level (one agent run vs another can swap one assertion result). A 10pp floor catches real regressions without flake-blocking every PR. Revisit after Sprint 4 when we have trend data.

### Rule 2 — Absolute floor

A PR fails if any touched skill's current delta is negative, regardless of baseline:

```text
fail_rule_2 = skill.current_delta < 0.0
```

Rationale: prevents baseline poisoning — if a broken skill landed and the baseline "normalized" to a negative delta, Rule 1 alone would never fail it again. Rule 2 is the guardrail that says: a skill that makes the agent worse must not pass CI, ever.

### Rule 3 — New skill grace period

A new skill (no baseline entry) passes if its delta is `≥ 0` on first run. The nightly baseline job establishes its baseline the next day. Rule 1 applies from day 2.

### Combined status

| Rule 1 | Rule 2 | Status |
|--------|--------|--------|
| pass | pass | ✅ pass |
| pass | fail | ❌ fail (absolute floor) |
| fail | pass | ❌ fail (regression) |
| fail | fail | ❌ fail (both) |

## Baseline management

### File: `ci/skills-eval-baseline.json`

```json
{
  "generated_at": "2026-04-20T00:00:00Z",
  "baseline_commit": "abc123...",
  "judge_prompt_version": "v0",
  "skills": {
    "nemoclaw-user-get-started": {
      "delta": 0.42,
      "with_score": 0.85,
      "without_score": 0.43,
      "scenarios_n": 3,
      "last_updated": "2026-04-20T00:00:00Z"
    }
  }
}
```

### Update cadence

- **Nightly** — a scheduled workflow runs the full eval against the tip of `main` and commits an updated baseline via a bot-authored PR. Reviewable, auditable, revertable.
- **Never on PR branches** — PR runs only compare against the main-branch baseline; they do not write to it.
- **Manual override** — in a release-cut PR that legitimately changes multiple skills, a maintainer can request a baseline refresh by applying the `refresh-skills-baseline` label. The nightly workflow prioritizes that commit next run. No per-PR ad-hoc updates.

### Versioning

`judge_prompt_version` is bumped any time the system block in `.context/judge-prompt-v0.md` changes. When the version changes, the baseline is invalidated and regenerated on the next nightly run — Rule 1 is suspended for that one day (Rule 2 still applies). This is the only time Rule 1 is ever bypassed automatically.

## Model choices

### Agent — `claude-sonnet-4-6`

The agent call must simulate a realistic NemoClaw user interaction, which means following multi-step instructions, reading a SKILL.md system block, and producing a substantive response. Haiku is too weak for this; opus is overpowered for the cost. Sonnet-4-6 is the default.

Override: set `SKILLS_EVAL_AGENT_MODEL` in the workflow env to A/B a different model against baseline (useful for Sprint 0.4 experiments). Overrides do not write to the baseline.

### Judge — `claude-haiku-4-5-20251001`

See `.context/judge-prompt-v0.md`. Haiku unless calibration falls below 90% agreement, at which point escalate to sonnet-4-6.

### Prompt caching

Both the agent and judge use prompt caching on their system blocks:

- Agent: system block = SKILL.md full text (+ referenced fixtures). Changes only when the skill changes.
- Judge: system block = the fixed rubric from `.context/judge-prompt-v0.md`. Changes only when the judge prompt version bumps.

Log `cache_read_input_tokens` on every call. Expect >80% hit rate on full-suite runs after the first skill.

## Cost model

### Per-call estimate (2026-04-20 pricing, subject to pricing drift — revisit quarterly)

| Call | Model | Input tokens (typical) | Output tokens (typical) | Estimated cost |
|------|-------|------------------------|-------------------------|----------------|
| Agent with-skill | sonnet-4-6 | 4000 (SKILL.md + prompt) | 600 | $0.02 |
| Agent without-skill | sonnet-4-6 | 200 (prompt only) | 600 | $0.01 |
| Judge | haiku-4-5 | 800 (system + response + assertions) | 250 | $0.0004 |

Per scenario: 2 agent calls + 2 judge calls ≈ **$0.031**.

### Per-run estimates

| Run type | Skills × scenarios | Cost |
|----------|--------------------|------|
| Single skill, 3 scenarios | 3 | $0.09 |
| Changed-only typical PR (2 skills) | 6 | $0.19 |
| Changed-only large PR (5 skills) | 15 | $0.47 |
| Full suite (11 user skills × 3) | 33 | **~$1.05** |
| Nightly baseline (full suite) | 33 | **~$1.05** × 30 nights = ~$32/mo |

### Per-PR cap

Hard ceiling: `$2.50` per PR invocation, enforced in the evaluator via aggregated token tracking. Running past the cap aborts remaining scenarios and posts a partial-run warning. This protects against runaway scenarios (e.g., a fixture that blows up agent output length).

### Monthly budget estimate

- Nightly baseline: ~$32/mo
- Assume 40 PRs/mo touching user skills, averaging $0.20 each: ~$8/mo
- **Total: <$50/mo** at current cadence. Review when we exceed $150/mo.

## Secret handling

### Repository secret

- Name: `ANTHROPIC_API_KEY`
- Scope: repo-level, read-only access from workflows
- Owner: to be assigned in Sprint 0 follow-up (likely the NemoClaw maintainer team)

### Workflow access

`.github/workflows/skills-eval.yml` is the only workflow that reads this secret. Do not propagate it to other workflows, reusable action inputs, or artifact uploads.

### Key rotation

On a 90-day cadence, or immediately if the key leaks. When rotating, the nightly baseline job runs once on the new key before PRs resume gating, to ensure no false-negative failures from a briefly-unreachable API.

### Never-log rule

The evaluator must never echo the key, token counts for an individual call including the key, or any header containing the key. CI logs are public on open-source PRs.

## Fork-PR fallback

External contributor PRs from forks cannot access `secrets.ANTHROPIC_API_KEY` (GitHub policy for good reason). The workflow must handle this gracefully:

1. If the secret is empty, the workflow exits early with a **neutral** check-run conclusion (not `failure`), posting a PR comment:

   > The skills-eval check is skipped for fork PRs because it requires an API key we cannot expose to third parties. A maintainer will rerun this check after an initial review.

2. Maintainers rerun the check manually by (a) checking out the fork branch locally and running `npm run eval:skills --changed-only`, or (b) pushing the branch to an internal fork and letting CI run there.

3. The branch may not merge until a maintainer-triggered run posts passing results on the PR. Enforced via branch-protection rules on `main`.

## Emergency bypass

The `skip-skills-eval` label on a PR marks the check as passed without running. Intended only for:

- Incident-response merges where a regression is known and accepted.
- Docs-only PRs that accidentally touch `.agents/skills/**` path globs (e.g., fixing a typo in EVALS.md).

Applying the label logs a line in the workflow run with the PR author and the labeler. Reviewed in weekly maintainer meetings; abuse gets the label removed.

## Nightly baseline refresh

`.github/workflows/skills-eval-nightly.yaml` runs every day at 08:00 UTC on `main`:

1. Full run of `evaluate-skills.ts` across every skill with an authored `evals.json` — no `--changed-only` scoping, `--cost-cap 25` to absorb a whole-catalog run.
2. Writes the raw structured output to `ci/skills-eval-latest.json` (also uploaded as a 30-day artifact).
3. Runs `scripts/update-skills-scoreboard.ts`, which:
   - Appends one row to `ci/skills-scoreboard-history.jsonl` (append-only; preserves per-assertion pass/fail bits for trend and regression diffs).
   - Rewrites `ci/skills-scoreboard.md` with the current delta table, 7-day sparkline, and last-regression date per skill.
   - Rewrites `ci/skills-eval-baseline.json` with today's numbers.
4. Updates the pinned GitHub issue titled **"NemoClaw Skills Scoreboard"** with the new markdown body (creates the issue the first time it runs, labelled `skills-scoreboard`).
5. Opens a PR on branch `chore/skills-eval-nightly-refresh` via `peter-evans/create-pull-request` containing only the three `ci/` files. The PR is the audit trail for baseline shifts — **merging it is what actually moves the baseline**; until merged, PR-side `skills-eval` still compares against the previously-merged baseline.

The cron job is no-op on forks (`if: github.repository == 'NVIDIA/NemoClaw'`) and exits cleanly if `ANTHROPIC_API_KEY` is unset.

### History file retention

`ci/skills-scoreboard-history.jsonl` is append-only and checked into git. It is not pruned automatically; at ~200 bytes per skill per day, a year of daily runs for 11 user skills is ~800 KB — acceptable in-repo. If it grows large enough to matter, write a second workflow that rotates rows older than 90 days into `ci/skills-scoreboard-history-archive.jsonl`.

### Manual trigger

Maintainers can run the nightly flow on demand via **Actions → skills-eval-nightly → Run workflow** (`workflow_dispatch`). Use this after a batch rewrite of several skills to refresh the baseline without waiting for 08:00 UTC.

## Relationship to `ci/coverage-threshold-*.json`

`ci/coverage-threshold-cli.json` and `ci/coverage-threshold-plugin.json` already implement a delta-regression gate for test coverage. The skills-eval gate follows the same philosophy (baseline-relative, not absolute), with different inputs. Future consolidation into a shared CI framework is worth considering but out of scope for the MVP.

## Changelog

| Date | Change |
|------|--------|
| 2026-04-20 | Initial draft (Sprint 0 Tasks 0.3 + 0.4 combined) |
| 2026-04-20 | Sprint 4 — document nightly refresh, scoreboard issue, history file |
| 2026-04-20 | Scope narrowed to `nemoclaw-user-*` skills; maintainer/contributor skills excluded |
