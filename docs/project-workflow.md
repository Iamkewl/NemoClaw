# NemoClaw — Project Workflow Reference

A reference for maintainers and the community response skill. Covers project board status semantics, the label structure for categorizing issues, and step-by-step instructions for configuring the NemoClaw Development Tracker.

---

## 1. Project Status Semantics

| Status | Meaning |
|---|---|
| `No Status` | Unreviewed — just arrived, not yet triaged by a maintainer |
| `Backlog` | Reviewed and approved for future work — not yet scoped to a release |
| `In Progress` | Actively being worked on in the current cycle |
| `Needs Review` | PR open, awaiting maintainer review |
| `Done` | Completed and merged |
| `Won't Fix` | Declined — valid but won't be addressed |
| `Duplicate` | Duplicate of an existing item |
| `NVQA` | NVQA-tracked item |

### Promotion Flow

```
No Status → Backlog → In Progress → Done
                ↓
           Won't Fix (declined)
                ↓
           Duplicate (superseded)
```

**Rules:**
- Items only leave `No Status` when a maintainer has reviewed them.
- Items only leave `Backlog` when explicitly approved for a release cycle.
- Do not set `Backlog` in a community response — that implies maintainer approval. Set `No Status` for new incoming items.

---

## 2. Label Structure

NemoClaw uses a three-tier label system. Apply labels in combination — start with Tier 1, add Tier 2, add Tier 3 if applicable.

### Tier 1 — Issue Type (always apply one)

| Label | When |
|---|---|
| `enhancement` | Feature request — always apply this as the base label alongside any sub-label |
| `bug` | Something isn't working as expected |
| `documentation` | Documentation improvement |
| `question` | User question or clarification request |
| `duplicate` | Duplicate of an existing issue |

### Tier 2 — Sub-type (apply the most specific that fits)

For feature requests, apply `enhancement` (Tier 1) plus one of:

| Label | When |
|---|---|
| `enhancement: feature` | General new capability |
| `enhancement: inference` | Inference routing, model support, providers |
| `enhancement: security` | Security controls, policies, audit |
| `enhancement: policy` | Network policy, egress rules |
| `enhancement: ui` | CLI UX, output formatting |
| `enhancement: platform` | Cross-platform support (pair with `Platform: *`) |
| `enhancement: provider` | Cloud/inference provider support (pair with `Provider: *`) |
| `enhancement: performance` | Speed, resource usage, efficiency |
| `enhancement: reliability` | Stability, error handling, recovery |
| `enhancement: testing` | Test coverage, CI/CD quality |
| `enhancement: MCP` | MCP protocol support |
| `enhancement: CI/CD` | Pipeline, build, automation |
| `enhancement: documentation` | Documentation improvements |
| `enhancement: refactoring` | Code quality, internal cleanup |

### Tier 3 — Dimension (apply when platform-, integration-, or provider-specific)

**Platforms:**
`Platform: DGX Spark` · `Platform: MacOS` · `Platform: Ubuntu` · `Platform: Brev` · `Platform: Windows/WSL` · `Platform: ARM64` · `Platform: AGX Thor/Orin` · `Platform: Fedora`

**Integrations:**
`Integration: Telegram` · `Integration: Slack` · `Integration: Discord` · `Integration: GitHub` · `Integration: OpenClaw` · `Integration: WhatsApp` · `Integration: IRC` · `Integration: Brave` · `Integration: Feishu` · `Integration: Outlook`

**Providers:**
`Provider: NVIDIA` · `Provider: OpenAI` · `Provider: Anthropic` · `Provider: Azure` · `Provider: AWS` · `Provider: GCP` · `Provider: Oracle` · `Provider: HuggingFace`

### Labeling Examples

| Request | Labels to apply |
|---|---|
| Add Slack bridge support | `enhancement` + `enhancement: feature` + `Integration: Slack` |
| Support NVIDIA NIM inference provider | `enhancement` + `enhancement: inference` + `Provider: NVIDIA` |
| Fix macOS install failure | `bug` + `Platform: MacOS` |
| GPU flag for `nemoclaw onboard` | `enhancement` + `enhancement: ui` |
| Audio transcription routing through gateway | `enhancement` + `enhancement: inference` |

### Status Labels (GitHub labels, separate from project board status)

| Label | When |
|---|---|
| `status: triage` | Needs maintainer triage before categorization |
| `status: needs-info` | Waiting on contributor response — 7-day window, then close |
| `priority: high` | Needs to be addressed in the next release |
| `priority: medium` | Should be addressed in upcoming releases |
| `priority: low` | Nice to have, no urgency |

---

## 3. Board Setup Instructions

One-time configuration for the NemoClaw Development Tracker (GitHub Projects UI).

### View 1: Enhancement Parking

This is the holding area for all unreviewed and approved-but-unscheduled feature requests.

1. Create a new view, name it **"Enhancement Parking"**
2. Layout: Board or Table
3. Filter: `label:enhancement`
4. Group by: Label
5. Add status filter: show only `No Status` and `Backlog`

### View 2: Platform & Integration Requests

Separate view for platform-, integration-, and provider-specific requests (triaged separately from general enhancements).

1. Create a new view, name it **"Platform & Integration Requests"**
2. Layout: Board or Table
3. Filter: `label:"Platform:"` OR `label:"Integration:"` OR `label:"Provider:"`
4. Group by: Label
5. Add status filter: show only `No Status` and `Backlog`

### Main Board (update existing)

Keep the main working board clean of unreviewed enhancements.

1. Open the existing main board view
2. Add filter: exclude items where `label:enhancement` AND `status:No Status`
3. Result: unreviewed enhancements are hidden; approved enhancements (`Backlog`, `In Progress`, `Needs Review`) remain visible

### Promoting an Enhancement to Active Work

1. Open Enhancement Parking view
2. Review the issue — confirm it's worth pursuing
3. Set project status to `Backlog` (approved, unscheduled) → now appears on main board
4. When scoped to a release: set status to `In Progress`

---

## 4. Triage Checklist

When processing a new incoming issue:

- [ ] Is it a bug, feature request, question, or duplicate?
- [ ] Apply Tier 1 label
- [ ] Apply Tier 2 sub-label (for enhancements)
- [ ] Apply Tier 3 dimension label(s) if platform/integration/provider-specific
- [ ] Set project status (`No Status` for new items; maintainer sets `Backlog` when approved)
- [ ] Apply `status: needs-info` + comment if more information is needed
- [ ] Apply `priority: *` if urgency is clear

---

*Maintainer community response guide: [docs/maintainer-guide.md](maintainer-guide.md)*
*Skill reference: [.agents/skills/nemoclaw-maintainer-community-response/SKILL.md](../.agents/skills/nemoclaw-maintainer-community-response/SKILL.md)*
