<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Skill Evaluations

> **Want a 60-second tour first?** Read [`EVALS-README.md`](EVALS-README.md) — it's the imperative quick-start with the commands, the CI flow, and how to read the reports. This file is the deeper authoring rubric.

Skills are code. They ship to production as part of every release, they change agent behavior for every user, and — until now — we had no way to answer the question "does this skill actually help?" This system answers that question empirically, so a bad user-facing skill can't land and a regressed one can't hide.

## Scope

The shared eval system covers **`nemoclaw-user-*` skills only** — the ones end users load when they ask NemoClaw for help. Maintainer and contributor skills (`nemoclaw-maintainer-*`, `nemoclaw-contributor-*`) are deliberately out of scope: those are internal workflows whose quality is better judged by the maintainers using them day-to-day, not by a general-purpose judge measuring end-user experience. Devs are free to set up their own evals for maintainer/contributor skills; they just don't live here.

## What the system does

For each user-facing skill, we write a small set of scenarios — user-voice prompts a real person might send in Slack or a GitHub issue. For each scenario, we run the agent **twice**: once with the skill's `SKILL.md` loaded into context, once without. A judge model grades both responses against a list of assertions ("response mentions the Node.js version prerequisite", "response does NOT assume Windows", etc.) and scores each in `[0, 1]`. The **delta** — with-skill score minus without-skill score — is the skill's value:

- `delta > 0` — the skill is helping.
- `delta ≈ 0` — the skill isn't load-bearing; the agent does just as well without it.
- `delta < 0` — the skill is actively making the agent worse.

CI runs the evals for any skill touched by a PR and fails the build if the skill's delta drops more than 10pp from its nightly baseline or falls below zero. A nightly job on `main` re-establishes the baseline and updates the public scoreboard.

## Why bother

Skills are a docs problem in disguise — they're instructions that *happen* to be executed by a model instead of read by a human. Docs rot silently; so do skills. Without a measurement loop, a skill that used to raise delta by 40pp can quietly drift to 10pp over a year of "small cleanups" and nobody notices. The evals catch that drift at PR time, and the nightly history makes trends visible on the scoreboard. It's doc tests for prompt engineering.

## The pieces

| Piece | Path | What it does |
|-------|------|--------------|
| Eval files | `.agents/skills/nemoclaw-user-*/evals/evals.json` | Scenarios + assertions per user-facing skill. One required per skill. |
| Reference walkthroughs | `.agents/skills/{nemoclaw-user-get-started,nemoclaw-user-configure-security}/evals/README.md` | Annotated examples — read one before authoring your own. |
| Authoring rubric | `.agents/skills/EVALS.md` (this file, below) | How to write scenarios and assertions that grade well. |
| Runner | `scripts/evaluate-skills.ts` | Executes the with/without agent runs, calls the judge, emits per-skill JSON. |
| CI gate | `.github/workflows/skills-eval.yaml` | Runs on PRs; applies the two-rule delta-regression gate. |
| CI policy | `ci/skills-eval-policy.md` | Delta-drop tolerance, absolute floor, baseline cadence, cost caps, secret handling. |
| Nightly baseline | `.github/workflows/skills-eval-nightly.yaml` + `ci/skills-eval-baseline.json` | Re-grades `main` each night and commits the new baseline. |
| Scoreboard | `scripts/update-skills-scoreboard.ts` + `ci/skills-scoreboard-history.jsonl` | Public per-skill delta table with sparkline history. |
| Eval reports | `scripts/render-eval-reports.ts` + `ci/eval-reports/{weakest-links,value-vs-cost}.md` | Renders two markdown reports from the eval JSON: which skills are hurting/marginal (weakest-links) and which earn their context budget (value-vs-cost). Optional `--narrate` fills prose slots via Haiku. |
| Pre-push hook | `scripts/check-skills-eval-stubs.ts` | Blocks scaffold stubs (`$instructions`, `TODO:`) from landing. |
| Scaffolder | `scripts/docs-to-skills.py` | Writes a stub `evals.json` when a new skill is generated. |

## Running an eval locally

```bash
# Score a specific skill (with-skill vs without-skill, prints per-scenario deltas)
npm run eval:skills -- --skills nemoclaw-user-get-started

# Score all touched skills against the committed baseline
npm run eval:skills -- --changed-only

# Regenerate the scoreboard from ci/skills-scoreboard-history.jsonl
npx tsx scripts/update-skills-scoreboard.ts

# Render weakest-links.md + value-vs-cost.md from the latest eval JSON
npx tsx scripts/render-eval-reports.ts \
  --input ci/skills-eval-latest.json \
  --skills-dir .agents/skills \
  --output-dir ci/eval-reports

# Same, but fill the diagnosis/commentary slots with Haiku-narrated prose
npx tsx scripts/render-eval-reports.ts \
  --input ci/skills-eval-latest.json \
  --skills-dir .agents/skills \
  --output-dir ci/eval-reports \
  --narrate
```

Requires `ANTHROPIC_API_KEY` in the environment for `eval:skills` and for `--narrate`. The deterministic `render-eval-reports.ts` path (no `--narrate`) makes no API calls and runs anywhere. CI runs use the repo-level secret.

## Where to go from here

- **Authoring a new eval?** Read one of the two reference walkthroughs above, then work through the rubric below.
- **Curious about the CI gate?** Read `ci/skills-eval-policy.md` — it documents the two-rule gate, the new-skill grace period, the cost model, and the bypass label.
- **Want the design context?** `.context/skills-eval-mvp-plan.md` has the v2 MVP plan.

---

## Authoring rubric

The rest of this file is the rubric for writing `evals/evals.json`. Scenarios measure whether the skill makes an agent **meaningfully better** at real user tasks — not whether the agent can recite the skill's keywords.

## TL;DR

- **Three scenarios minimum** per skill. More is fine; fewer is not.
- **Prompts are user scenarios**: use-case specific, implementation-vague. Write them the way a real user would phrase them in Slack or a GitHub issue.
- **Assertions are behavioral claims** a grader can check with a quote or a yes/no. Avoid "response is helpful" — that's a vibe, not an assertion.
- **Scoring is with-skill vs without-skill delta.** A skill is valuable when loading it moves the score meaningfully upward on scenarios that target it.
- **Never ship `TODO:` stubs.** CI blocks them.

## File layout

```text
.agents/skills/<skill-name>/
  SKILL.md
  evals/
    evals.json          # this file (required)
    files/              # per-scenario fixtures (optional)
      mock-config.yaml
      user-state.md
      ...
  references/
    ...
```

## Schema

Conform exactly to the [agentskills.io evaluation spec](https://agentskills.io/skill-creation/evaluating-skills). No bespoke fields.

```json
{
  "skill_name": "nemoclaw-user-get-started",
  "evals": [
    {
      "id": 1,
      "prompt": "I'm brand new to NemoClaw, on macOS. Walk me through getting my first sandbox running.",
      "expected_output": "Step-by-step: prerequisites, install, onboarding wizard, first prompt.",
      "files": [],
      "assertions": [
        "Response mentions checking the Node.js version prerequisite",
        "Response references the onboarding wizard or `nemoclaw onboard`",
        "Response explains that the first sandbox launches inside OpenShell",
        "Response does NOT assume Windows-specific steps"
      ]
    }
  ]
}
```

Field contracts:

| Field | Required | Rule |
|-------|----------|------|
| `skill_name` | yes | Must match the skill directory name exactly |
| `evals[].id` | yes | Stable integer; never re-used or renumbered (CI baselines reference it) |
| `evals[].prompt` | yes | User-voice, implementation-vague (see rubric below) |
| `evals[].expected_output` | yes | One sentence describing the shape of a good response; grader does NOT match this literally |
| `evals[].files` | yes | Array; empty if no fixtures. Paths relative to the `evals/` directory |
| `evals[].assertions` | yes | 4–6 behavioral claims; each must be independently checkable |

## The implementation-vagueness test

Before committing a scenario, apply this test: **if you remove the skill name from the prompt, can you still tell which skill the prompt targets?**

- **Yes** → the prompt is too specific. It's testing a command, not the skill.
- **No** → good. The agent has to pick the right skill and use it well.

### Bad → Good examples

| Bad (implementation-specific) | Good (user-intent) |
|-------------------------------|--------------------|
| "Run `nemoclaw onboard` and explain each flag" | "I just cloned NemoClaw and I'm not sure what to do next. Help me get set up." |
| "Use the configure-security skill to evaluate my sandbox egress controls" | "I'm preparing to deploy a NemoClaw sandbox in a team environment. What security trade-offs should I think about?" |
| "Read .agents/skills/nemoclaw-user-deploy-remote/SKILL.md and summarize" | "I want to run NemoClaw on a Brev GPU instance. Is that still supported?" |
| "Invoke the manage-policy TUI and walk me through approving a blocked request" | "An agent action was blocked and I need to decide whether to allow it. What should I look at?" |

## Writing good assertions

An assertion is a **claim about the response** that a judge (LLM or human) can grade 1/0. It should be:

- **Specific** — quote-checkable or yes/no.
- **Behavioral** — about what the response does, not what it says about itself.
- **Independent** — doesn't depend on another assertion's outcome to evaluate.
- **Implementation-relevant** — captures something the skill is supposed to cause.

### Bad → Good assertions

| Bad | Why it's bad | Good |
|-----|--------------|------|
| "Response is accurate" | Not gradable | "Response names Node.js 22.16+ as the required version" |
| "Response is helpful" | Vibes | "Response lists at least three concrete next steps" |
| "Response covers everything important" | What's important? | "Response mentions both the CLI install and the onboarding wizard" |
| "Response is formatted nicely" | Format ≠ value | "Response uses numbered steps when describing a sequence" |
| "Agent uses the skill" | You can't observe that directly; only behavior | "Response mirrors the skill's recommended ordering: prerequisites → install → onboard → first prompt" |

### Negative assertions are fine (and useful)

| Example |
|---------|
| "Response does NOT recommend running `npm install -g` as root" |
| "Response does NOT assume the user is on Windows" |
| "Response does NOT mention the deprecated Brev compatibility path unless the user asks about it" |

Negative assertions catch skills that leak irrelevant or unsafe advice.

## Picking scenarios per skill

Three is the floor. Aim for scenarios that span:

1. **Happy-path primary use** — what most users will ask.
2. **Edge case or partial state** — user has some config, something went wrong, etc.
3. **Adjacent-wrong** — a prompt that *sounds* like this skill but shouldn't trigger it. Tests that the skill doesn't over-fire.

### Example breakdown for `nemoclaw-user-get-started`

| # | Type | Prompt shape |
|---|------|--------------|
| 1 | Happy path | "I'm new to NemoClaw on macOS. Get me running." |
| 2 | Partial state | "I ran `npm install` and now I'm not sure what to do." |
| 3 | Adjacent-wrong | "I want to customize which model a running NemoClaw sandbox uses." *(this is configure-inference territory, not get-started)* |

For adjacent-wrong scenarios, assertions should state what the response should **not** do ("Response does NOT walk the user through first-time installation steps") and optionally what it should do ("Response redirects to inference configuration").

## Fixtures (`files/`)

Most NemoClaw skills are docs- and journey-oriented. Fixtures are usually short **user-state descriptions** or **mock configs**, not large code files.

Use fixtures when the scenario needs the user to have a specific starting state.

### Example fixtures

`evals/files/user-state-partial-install.md`:

```markdown
# User state

- OS: macOS 14.3
- Node.js: 22.16 installed
- NemoClaw: cloned from GitHub, `npm install` completed
- NOT yet run: onboarding wizard, first sandbox launch
- Errors seen: none
```

`evals/files/mock-policy-blocking.yaml`:

```yaml
# What the user has in their policy file at the moment of the scenario
egress:
  allow: []
  deny: ["*"]
```

Reference fixtures in `files[]` with paths relative to `evals/`. The agent loads them as-is.

## What NOT to put in scenarios

- **Internal tool invocations.** If your prompt says "call the X CLI with flag Y", you're testing the CLI, not the skill.
- **Expected-output copy-paste.** `expected_output` is a shape hint for reviewers, not a string the grader matches.
- **Secrets, keys, or real customer data.** Fixtures are public — treat them that way.
- **Skill-name giveaways.** If your prompt names the skill explicitly, you're short-circuiting routing.
- **Multi-skill scenarios.** One scenario targets one skill. If you need a cross-skill test, that belongs in a separate chain-eval layer (not part of the MVP).

## Review checklist (before opening a PR)

- [ ] `evals.json` parses with `jq .`
- [ ] `skill_name` matches the directory name
- [ ] At least 3 scenarios
- [ ] Every scenario has ≥4 assertions
- [ ] Implementation-vagueness test passes for every prompt
- [ ] No `TODO:` markers remain
- [ ] At least one adjacent-wrong or negative-assertion scenario
- [ ] Fixtures in `files/` are self-contained (no repo-internal path assumptions)

## Lifecycle

1. **Scaffold** — `scripts/docs-to-skills.py` writes a stub when a skill is first generated. Stubs are `TODO:` placeholders.
2. **Author** — skill owner replaces stubs with real scenarios using this guide.
3. **Local run** — `npm run eval:skills -- --skills <name>` grades scenarios with and without the skill loaded.
4. **CI gate** — `.github/workflows/skills-eval.yml` blocks merges when a skill's delta regresses below baseline tolerance.
5. **Nightly baseline** — main branch is re-graded; `ci/skills-eval-baseline.json` updates.

See `ci/skills-eval-policy.md` for the exact delta tolerances, agent/judge model choices, and cost caps.

## Changelog

| Date | Change |
|------|--------|
| 2026-04-20 | Initial draft (Sprint 0 Task 0.1) |
