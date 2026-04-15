---
name: nemoclaw-maintainer-sprint-plan
description: Generates a sprint execution plan for NemoClaw. Queries the GitHub Projects iteration field for available sprints, fetches assigned issues and PRs, categorizes by label type, and writes docs/sprints/sprint-NNN.md with maintainer input. Trigger keywords: sprint plan, plan sprint, sprint execution, what's in sprint, sprint N.
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw — Sprint Execution Plan

Generate a sprint plan document, confirm scope with the maintainer, and write it to `docs/sprints/`.

## Step 1: Read Governance Context

```bash
cat docs/project-governance.md
```

This provides sprint cadence, version strategy, and role definitions. Do not skip.

## Step 2: Discover the Project and List Iterations

Find the NemoClaw Development Tracker project number:

```bash
gh project list --owner NVIDIA --limit 20
```

Then list the iteration field values:

```bash
gh api graphql -f query='
{
  organization(login: "NVIDIA") {
    projectV2(number: PROJECT_NUMBER) {
      field(name: "Iteration") {
        ... on ProjectV2IterationField {
          configuration {
            iterations {
              id
              title
              startDate
              duration
            }
            completedIterations {
              id
              title
              startDate
              duration
            }
          }
        }
      }
    }
  }
}'
```

Replace `PROJECT_NUMBER` with the number from the project list. Present the active and completed iterations to the maintainer and ask: **"Which sprint are we planning?"**

## Step 3: Fetch Items Assigned to the Sprint

Query all issues and PRs assigned to the selected iteration using the GraphQL API:

```bash
gh api graphql -f query='
{
  organization(login: "NVIDIA") {
    projectV2(number: PROJECT_NUMBER) {
      items(first: 100) {
        nodes {
          content {
            ... on Issue {
              number
              title
              url
              labels(first: 10) { nodes { name } }
              state
            }
            ... on PullRequest {
              number
              title
              url
              labels(first: 10) { nodes { name } }
              state
            }
          }
          fieldValueByName(name: "Iteration") {
            ... on ProjectV2ItemFieldIterationValue {
              title
            }
          }
          fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue {
              name
            }
          }
        }
      }
    }
  }
}'
```

Filter results to items where the Iteration field matches the selected sprint title.

## Step 4: Categorize Items by Label

Group fetched items into four buckets based on Tier 1 and Tier 2 labels:

| Bucket | Labels |
|---|---|
| Bugs and Stability | `bug`, `enhancement: reliability`, `enhancement: performance` |
| Features and Enhancements | `enhancement: *` (excluding reliability and performance) |
| Documentation | `documentation` |
| Infrastructure and CI | `enhancement: CI/CD`, `enhancement: testing` |

Items with no matching label go into the most applicable bucket by title context.

## Step 5: Ask for Sprint Metadata

Present the categorized item list and ask the maintainer:

1. **Sprint goal** — 1-2 sentences describing the focus and intended outcome
2. **Release tag target** — e.g., `v0.0.24`
3. **Items to add** — accept a comma-separated list of issue/PR numbers not yet assigned to the iteration (e.g., `#123, #456`); fetch titles and labels for each via `gh issue view <N> --repo NVIDIA/NemoClaw` or `gh pr view <N> --repo NVIDIA/NemoClaw` and place them in the appropriate bucket
4. **Items to defer** — issue/PR numbers to explicitly exclude, with a one-phrase reason for each

## Step 6: Generate the Sprint Plan Document

Determine the sprint number from the iteration title (e.g., "Sprint 3" → `003`). Write to `docs/sprints/sprint-NNN.md`:

```markdown
---
orphan: true
title: "Sprint N — [Theme]"
description: "Sprint N execution plan: scope, goals, and definition of done."
keywords: sprint, planning, execution
topics: [maintainer]
tags: [maintainer, sprint]
content_type: reference
audience: maintainers
status: active
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Sprint N — [Theme]

**Dates:** YYYY-MM-DD – YYYY-MM-DD
**Release target:** vX.Y.Z
**Iteration:** Sprint N (NemoClaw Development Tracker)

## Sprint Goal

[Sprint goal from maintainer input.]

## Scope

### Bugs and Stability

| Issue/PR | Title | Priority | Status |
|---|---|---|---|
| #N | [title] | `priority: high` | In Progress |

### Features and Enhancements

| Issue/PR | Title | Labels | Status |
|---|---|---|---|
| #N | [title] | `enhancement: inference` | Backlog |

### Documentation

| Issue/PR | Title | Status |
|---|---|---|
| #N | [title] | Backlog |

### Infrastructure and CI

| Issue/PR | Title | Status |
|---|---|---|
| #N | [title] | Backlog |

## Deferred

Items considered for this sprint but explicitly moved out:

| Issue/PR | Title | Reason |
|---|---|---|
| #N | [title] | Needs design first |

## Definition of Done

- [ ] All scoped items are `Done` or explicitly listed in Deferred with a note
- [ ] Release tag cut by engineering maintainer
- [ ] No open P0 or P1 issues against this release
- [ ] Handoff summary generated by `nemoclaw-maintainer-evening` skill
- [ ] Sprint iteration closed in GitHub Projects
```

Omit any empty sections (e.g., if there are no documentation items, omit that table).

## Step 7: Present for Review

Render the full document inline. Ask: "Want to adjust anything before I commit this?"

## Step 8: Commit

```bash
git add docs/sprints/sprint-NNN.md
git commit -m "docs: sprint N execution plan — [theme]"
```

Do NOT push or open a PR automatically. Sprint plan docs are internal working documents — push and PR are at the maintainer's discretion.
