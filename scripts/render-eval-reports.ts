// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/*
 * Renders weakest-links.md and value-vs-cost.md from the structured JSON
 * output of evaluate-skills.ts. The scoreboard.md counterpart is produced
 * separately by update-skills-scoreboard.ts.
 *
 * Deterministic by default: no API calls, byte-identical output for identical
 * input. Narrative sections ("diagnosis", "quadrant commentary") are emitted
 * as <!-- slot --> HTML comments that a later narration pass can fill in.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import Anthropic from "@anthropic-ai/sdk";

import type { EvalReport, ScenarioResult, SkillResult } from "./update-skills-scoreboard.ts";

// Classification thresholds — tunable. See plan §Sprint 0.
const HURTING_DELTA = 0;
const MARGINAL_DELTA = 0.2;
const LOAD_BEARING_DELTA = 0.5;
const HEAVY_TOKEN_THRESHOLD = 2000;
const CHARS_PER_TOKEN = 3.8;

// Narration pass defaults — see plan §Sprint 3.
const DEFAULT_NARRATE_MODEL = "claude-haiku-4-5";
const DEFAULT_NARRATE_COST_CAP_USD = 0.05;
const NARRATE_MAX_TOKENS = 2048;
const NARRATE_PRICING: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
};
const NARRATE_NEUTRAL_EXIT_CODE = 78;

type SkillAssets = {
  tokens: number | null;
  /** Per-scenario assertion text, indexed [scenario_id-1][assertion_id-1]. */
  assertions: string[][];
};

type QuadrantKey = "elite" | "heavy-worth" | "marginal-cheap" | "action";

type Classified = {
  skill: SkillResult;
  tokens: number | null;
  efficiency: number | null;
  quadrant: QuadrantKey;
};

type HurtingScenario = {
  skill: string;
  scenario: ScenarioResult;
  failed: { id: number; assertion: string; evidence: string }[];
};

type MarginalScenario = {
  skill: string;
  scenario: ScenarioResult;
  failedWithout: { id: number; assertion: string; evidence: string }[];
};

type AssertionGap = {
  skill: string;
  scenario_id: number;
  assertion_id: number;
  assertion: string;
  evidence: string;
};

function fmtDelta(delta: number | null): string {
  if (delta === null) return "—";
  const sign = delta >= 0 ? "+" : "−";
  return `${sign}${Math.abs(delta).toFixed(2)}`;
}

function fmtTokens(tokens: number | null): string {
  if (tokens === null) return "???";
  if (tokens < 1000) return `~${tokens}`;
  return `~${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}K`;
}

function estimateTokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}

function slot(name: string, attrs: Record<string, string | number>): string {
  const pairs = Object.entries(attrs)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return `<!-- slot: ${name} ${pairs} -->`;
}

export function loadSkillAssets(
  skillsDir: string,
  skillNames: string[],
): Record<string, SkillAssets> {
  const out: Record<string, SkillAssets> = {};
  for (const name of skillNames) {
    const skillDir = path.join(skillsDir, name);
    const skillMdPath = path.join(skillDir, "SKILL.md");
    const evalsPath = path.join(skillDir, "evals", "evals.json");

    let tokens: number | null = null;
    if (existsSync(skillMdPath)) {
      const contents = readFileSync(skillMdPath, "utf8");
      tokens = estimateTokens(contents.length);
    }

    let assertions: string[][] = [];
    if (existsSync(evalsPath)) {
      const parsed = JSON.parse(readFileSync(evalsPath, "utf8")) as {
        evals: { id: number; assertions: string[] }[];
      };
      const ordered = [...parsed.evals].sort((a, b) => a.id - b.id);
      assertions = ordered.map((e) => e.assertions);
    }

    out[name] = { tokens, assertions };
  }
  return out;
}

function lookupAssertion(
  assets: SkillAssets,
  scenario_id: number,
  assertion_id: number,
): string {
  const row = assets.assertions[scenario_id - 1];
  if (!row) return "(assertion text unavailable)";
  return row[assertion_id - 1] ?? "(assertion text unavailable)";
}

export function findHurtingScenarios(
  report: EvalReport,
  assets: Record<string, SkillAssets>,
): HurtingScenario[] {
  const results: HurtingScenario[] = [];
  for (const skill of report.skills) {
    for (const scenario of skill.scenarios) {
      if (scenario.delta === null || scenario.delta >= HURTING_DELTA) continue;
      const skillAssets = assets[skill.skill_name];
      const failed = scenario.with_grades
        .filter((g) => !g.satisfied)
        .map((g) => ({
          id: g.id,
          assertion: skillAssets
            ? lookupAssertion(skillAssets, scenario.scenario_id, g.id)
            : "(assertion text unavailable)",
          evidence: g.evidence,
        }));
      results.push({ skill: skill.skill_name, scenario, failed });
    }
  }
  return results.sort((a, b) => (a.scenario.delta ?? 0) - (b.scenario.delta ?? 0));
}

export function findMarginalScenarios(
  report: EvalReport,
  assets: Record<string, SkillAssets>,
): MarginalScenario[] {
  const results: MarginalScenario[] = [];
  for (const skill of report.skills) {
    for (const scenario of skill.scenarios) {
      if (scenario.delta === null) continue;
      if (scenario.delta <= HURTING_DELTA) continue;
      if (scenario.delta > MARGINAL_DELTA) continue;
      const skillAssets = assets[skill.skill_name];
      const failedWithout = scenario.without_grades
        .filter((g) => !g.satisfied)
        .map((g) => ({
          id: g.id,
          assertion: skillAssets
            ? lookupAssertion(skillAssets, scenario.scenario_id, g.id)
            : "(assertion text unavailable)",
          evidence: g.evidence,
        }));
      results.push({ skill: skill.skill_name, scenario, failedWithout });
    }
  }
  return results.sort((a, b) => {
    const byDelta = (a.scenario.delta ?? 0) - (b.scenario.delta ?? 0);
    if (byDelta !== 0) return byDelta;
    if (a.skill !== b.skill) return a.skill.localeCompare(b.skill);
    return a.scenario.scenario_id - b.scenario.scenario_id;
  });
}

export function findAssertionGaps(
  report: EvalReport,
  assets: Record<string, SkillAssets>,
): AssertionGap[] {
  const results: AssertionGap[] = [];
  for (const skill of report.skills) {
    for (const scenario of skill.scenarios) {
      if (scenario.delta === null) continue;
      if (scenario.delta <= MARGINAL_DELTA) continue;
      const skillAssets = assets[skill.skill_name];
      for (const grade of scenario.with_grades) {
        if (grade.satisfied) continue;
        results.push({
          skill: skill.skill_name,
          scenario_id: scenario.scenario_id,
          assertion_id: grade.id,
          assertion: skillAssets
            ? lookupAssertion(skillAssets, scenario.scenario_id, grade.id)
            : "(assertion text unavailable)",
          evidence: grade.evidence,
        });
      }
    }
  }
  return results.sort((a, b) => {
    if (a.skill !== b.skill) return a.skill.localeCompare(b.skill);
    if (a.scenario_id !== b.scenario_id) return a.scenario_id - b.scenario_id;
    return a.assertion_id - b.assertion_id;
  });
}

export function classifyQuadrant(
  delta: number | null,
  tokens: number | null,
): QuadrantKey {
  const loadBearing = (delta ?? 0) >= LOAD_BEARING_DELTA;
  const heavy = (tokens ?? 0) >= HEAVY_TOKEN_THRESHOLD;
  if (loadBearing && !heavy) return "elite";
  if (loadBearing && heavy) return "heavy-worth";
  if (!loadBearing && !heavy) return "marginal-cheap";
  return "action";
}

function classifyAll(
  report: EvalReport,
  assets: Record<string, SkillAssets>,
): Classified[] {
  return report.skills.map((skill) => {
    const tokens = assets[skill.skill_name]?.tokens ?? null;
    const efficiency =
      skill.delta !== null && tokens !== null && tokens > 0
        ? (skill.delta / tokens) * 1000
        : null;
    return {
      skill,
      tokens,
      efficiency,
      quadrant: classifyQuadrant(skill.delta, tokens),
    };
  });
}

export function renderWeakestLinks(
  report: EvalReport,
  assets: Record<string, SkillAssets>,
  date: string,
): string {
  const lines: string[] = [];
  const hurting = findHurtingScenarios(report, assets);
  const marginal = findMarginalScenarios(report, assets);
  const gaps = findAssertionGaps(report, assets);

  lines.push("# NemoClaw Skills — Weakest Links");
  lines.push("");
  lines.push(
    `_Generated ${date} · agent: \`${report.agent_model}\` · judge: \`${report.judge_prompt_version}\`._`,
  );
  lines.push("");
  lines.push(
    "A scoreboard tells you which skills are healthy. This report tells you " +
      "which ones to **fix first**, and why. Three buckets, ordered by severity.",
  );
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push("## 1. Skill is *hurting* the agent (Δ < 0)");
  lines.push("");
  if (hurting.length === 0) {
    lines.push("_No scenarios with a negative delta this run._");
    lines.push("");
  } else {
    lines.push(
      "These are the highest-priority findings. The agent gave a *better* " +
        "answer without the skill loaded than with it. Loading the skill made " +
        "things worse.",
    );
    lines.push("");
    for (const h of hurting) {
      lines.push(
        `### \`${h.skill}\` — scenario ${h.scenario.scenario_id} · Δ = **${fmtDelta(h.scenario.delta)}**`,
      );
      lines.push("");
      lines.push(`> *"${h.scenario.prompt}"*`);
      lines.push("");
      if (h.failed.length > 0) {
        lines.push("**With-skill failures:**");
        for (const f of h.failed) {
          lines.push(
            `- Asserted: *"${f.assertion}"* → **failed**. ${f.evidence}`,
          );
        }
        lines.push("");
      }
      lines.push("**Diagnosis:**");
      lines.push("");
      lines.push(
        slot("weakest-links.diagnosis", {
          skill: h.skill,
          scenario: h.scenario.scenario_id,
        }),
      );
      lines.push("");
      lines.push("**Suggested action:**");
      lines.push("");
      lines.push(
        slot("weakest-links.suggested-action", {
          skill: h.skill,
          scenario: h.scenario.scenario_id,
        }),
      );
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  lines.push("## 2. Skill is barely earning its context budget (0 < Δ ≤ 0.20)");
  lines.push("");
  if (marginal.length === 0) {
    lines.push("_No scenarios in the marginal band this run._");
    lines.push("");
  } else {
    lines.push(
      "The skill helps, but only marginally. Worth asking: is the scenario " +
        "testing something the skill uniquely provides, or is generic " +
        "knowledge already strong?",
    );
    lines.push("");
    for (const m of marginal) {
      lines.push(
        `### \`${m.skill}\` — scenario ${m.scenario.scenario_id} · Δ = **${fmtDelta(m.scenario.delta)}**`,
      );
      lines.push("");
      lines.push(`> *"${m.scenario.prompt}"*`);
      lines.push("");
      const totalAssertions = m.scenario.without_grades.length;
      const passingWithout = totalAssertions - m.failedWithout.length;
      lines.push(
        `**Why low delta:** Without the skill, the agent already passes ` +
          `${passingWithout}/${totalAssertions} assertions. The skill only ` +
          `moves the needle on ${m.failedWithout.length} failing assertion${m.failedWithout.length === 1 ? "" : "s"}.`,
      );
      if (m.failedWithout.length > 0) {
        lines.push("");
        lines.push("**Failing without the skill:**");
        for (const f of m.failedWithout) {
          lines.push(`- *"${f.assertion}"* — ${f.evidence}`);
        }
      }
      lines.push("");
      lines.push("**Suggested action:**");
      lines.push("");
      lines.push(
        slot("weakest-links.suggested-action", {
          skill: m.skill,
          scenario: m.scenario.scenario_id,
        }),
      );
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  lines.push("## 3. Specific assertion gaps in otherwise-strong skills");
  lines.push("");
  if (gaps.length === 0) {
    lines.push("_No assertion-level gaps in otherwise-healthy scenarios._");
    lines.push("");
  } else {
    lines.push(
      "Even in scenarios where the skill helps a lot overall, individual " +
        "assertions failed *with-skill* — i.e. the skill itself doesn't cover " +
        "them. Each is a small, scoped content gap to patch.",
    );
    lines.push("");
    lines.push("| Skill | Scenario | Failed assertion | Suggested fix |");
    lines.push("|-------|----------|------------------|---------------|");
    for (const g of gaps) {
      const fixSlot = slot("weakest-links.assertion-gap-fix", {
        skill: g.skill,
        scenario: g.scenario_id,
        assertion: g.assertion_id,
      });
      lines.push(
        `| \`${g.skill}\` | #${g.scenario_id} | *"${g.assertion}"* | ${fixSlot} |`,
      );
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("## Summary counts");
  lines.push("");
  lines.push(`- Hurting scenarios (Δ < 0): **${hurting.length}**`);
  lines.push(`- Marginal scenarios (0 < Δ ≤ 0.20): **${marginal.length}**`);
  lines.push(`- Assertion-level gaps in healthy scenarios: **${gaps.length}**`);
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push("## What this report is *not*");
  lines.push("");
  lines.push(
    "- **Not a quality ranking.** A skill with a lower Δ isn't \"worse\" — " +
      "it's load-bearing in different ways.",
  );
  lines.push(
    "- **Not a generation gate.** These are *suggestions*, not blockers. " +
      "The CI gate fires on regression-from-baseline, not on absolute weakness.",
  );
  lines.push(
    "- **Not the last word on assertion quality.** A low-delta scenario may " +
      "mean the assertions are bad, not the skill.",
  );
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push("## Companion files");
  lines.push("");
  lines.push("- `eval.json` — full structured report (input to this analysis)");
  lines.push("- `scoreboard.md` — the high-level dashboard");
  lines.push("- `value-vs-cost.md` — efficiency view (Δ per 1K tokens, quadrants)");
  lines.push("");

  return lines.join("\n");
}

export function renderValueVsCost(
  report: EvalReport,
  assets: Record<string, SkillAssets>,
  date: string,
): string {
  const lines: string[] = [];
  const classified = classifyAll(report, assets);
  const byEfficiency = [...classified].sort((a, b) => {
    const ae = a.efficiency ?? -Infinity;
    const be = b.efficiency ?? -Infinity;
    return be - ae;
  });

  lines.push("# NemoClaw Skills — Value vs Cost");
  lines.push("");
  lines.push(
    `_Generated ${date} · agent: \`${report.agent_model}\` · judge: \`${report.judge_prompt_version}\`._`,
  );
  lines.push("");
  lines.push(
    "The scoreboard answers **\"does this skill help?\"** via Δ. This view " +
      "answers **\"is the help worth what the skill costs to carry?\"** Skills " +
      "aren't free — every loaded `SKILL.md` consumes context the model could " +
      "use for the user's actual problem.",
  );
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push("## The numbers");
  lines.push("");
  lines.push(
    `Skill size measured directly from \`SKILL.md\` (chars ÷ ~${CHARS_PER_TOKEN} chars/token).` +
      " **Δ/1K tokens** is the efficiency ratio — assertion-pass-rate gain per 1,000 tokens.",
  );
  lines.push("");
  lines.push("| Skill | Δ | SKILL.md tokens | Δ per 1K tokens | Verdict |");
  lines.push("|-------|-----:|---------------:|---------------:|---------|");
  for (const c of byEfficiency) {
    const effStr = c.efficiency === null ? "—" : c.efficiency.toFixed(2);
    const verdictSlot = slot("value-vs-cost.per-skill-verdict", {
      skill: c.skill.skill_name,
    });
    lines.push(
      `| \`${c.skill.skill_name}\` | ${fmtDelta(c.skill.delta)} | ${fmtTokens(c.tokens)} | ${effStr} | ${verdictSlot} |`,
    );
  }
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push("## The cost quadrants");
  lines.push("");
  lines.push(
    `Cutoffs: **Δ ≥ ${LOAD_BEARING_DELTA.toFixed(2)}** = "load-bearing", ` +
      `**tokens ≥ ${HEAVY_TOKEN_THRESHOLD.toLocaleString()}** = "heavy".`,
  );
  lines.push("");

  const quadrants: { key: QuadrantKey; title: string }[] = [
    { key: "elite", title: "Elite — high delta, small footprint (auto-load)" },
    {
      key: "heavy-worth",
      title: "Heavy but worth it — high delta, large footprint",
    },
    {
      key: "marginal-cheap",
      title: "Marginal & cheap — low delta, small footprint",
    },
    { key: "action", title: "Action zone — low delta, large footprint" },
  ];
  for (const q of quadrants) {
    const members = classified
      .filter((c) => c.quadrant === q.key)
      .sort((a, b) => a.skill.skill_name.localeCompare(b.skill.skill_name));
    lines.push(`### ${q.title}`);
    lines.push("");
    if (members.length === 0) {
      lines.push("_No skills in this quadrant._");
    } else {
      for (const m of members) {
        lines.push(
          `- \`${m.skill.skill_name}\` — Δ ${fmtDelta(m.skill.delta)}, ${fmtTokens(m.tokens)} tokens`,
        );
      }
    }
    lines.push("");
    lines.push(slot("value-vs-cost.quadrant-commentary", { quadrant: q.key }));
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("## What this report is *not*");
  lines.push("");
  lines.push(
    "- **Not a deletion list.** A skill in the action-zone might be there " +
      "because *its scenarios under-test it*, not because the skill is weak. " +
      "Always check the scenarios first.",
  );
  lines.push(
    "- **Not a static-size dogma.** A 5K-token skill is fine if it earns its " +
      "weight on critical user paths. Look at *what* it costs for *what* it earns.",
  );
  lines.push(
    "- **Not a substitute for runtime measurement.** SKILL.md size is one " +
      "cost dimension. Response tokens, latency, and tool-call count all " +
      "matter and need eval-harness instrumentation.",
  );
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push("## Companion files");
  lines.push("");
  lines.push("- `scoreboard.md` — the daily dashboard");
  lines.push("- `weakest-links.md` — actionable failure modes");
  lines.push("- `eval.json` — structured input data");
  lines.push("");

  return lines.join("\n");
}

// --- Narration pass -----------------------------------------------------

const NARRATE_SLOT_RE = /<!-- slot: ([^>]+?) -->/g;

export type SlotFill = Record<string, string>;

const NARRATE_SYSTEM = [
  "You fill narrative slots in a markdown eval report about AI agent skills.",
  "Each slot is an HTML comment like <!-- slot: name attr=value ... -->.",
  "You will receive the full rendered report and the structured eval data.",
  "",
  "Return a single JSON object mapping each slot's identifier (the text",
  "between 'slot: ' and ' -->') to its replacement string. Return only",
  "that JSON object — no prose, no code fences.",
  "",
  "Style rules for replacement text:",
  "- Match the tone of the surrounding report: concrete, slightly dry,",
  "  skeptical but not cynical. No cheerleading, no hedging.",
  "- Ground every claim in the evidence shown in the report. If the",
  "  evidence does not support a specific diagnosis, write:",
  "  'Needs human review — evidence insufficient for a confident call.'",
  "- 'diagnosis' slots: 1–2 sentences naming the failure mode (e.g.",
  "  'wrong-altitude bias', 'cross-skill drag', 'assertions already",
  "  pass on general knowledge').",
  "- 'suggested-action' slots: a short markdown bullet list (2–4 bullets).",
  "  Each bullet is a concrete edit to the skill's SKILL.md, evals.json,",
  "  or description — not generic advice.",
  "- 'assertion-gap-fix' slots: a single sentence, table-cell length.",
  "- 'quadrant-commentary' slots: 1–2 sentences about what skills in the",
  "  quadrant have in common and what to do with them.",
  "- 'per-skill-verdict' slots: 3–8 words, table-cell short. Examples:",
  "  'Tiny + load-bearing', 'Heavy but earns it', 'Prune candidate'.",
].join("\n");

type NarrateOptions = {
  model: string;
  costCapUsd: number;
};

type NarrateResult = {
  filled: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  costUsd: number;
};

function collectSlotIds(markdown: string): string[] {
  const ids: string[] = [];
  for (const match of markdown.matchAll(NARRATE_SLOT_RE)) {
    ids.push(match[1]!.trim());
  }
  return ids;
}

function estimateNarrateCost(
  model: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheCreate: number,
): number {
  const price = NARRATE_PRICING[model];
  if (!price) return 0;
  const billedInput = input + cacheCreate * 1.25 + cacheRead * 0.1;
  return (billedInput * price.input) / 1_000_000 + (output * price.output) / 1_000_000;
}

function parseSlotMap(raw: string): SlotFill {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Narration output contained no JSON object");
  }
  const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Narration output was not a JSON object");
  }
  const out: SlotFill = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new Error(`Narration slot ${key} was not a string`);
    }
    out[key] = value;
  }
  return out;
}

export function applySlotFills(markdown: string, fills: SlotFill): string {
  return markdown.replace(NARRATE_SLOT_RE, (full, id: string) => {
    const replacement = fills[id.trim()];
    if (replacement === undefined) return full;
    return replacement;
  });
}

export async function narrateReport(
  client: Anthropic,
  markdown: string,
  reportContext: unknown,
  options: NarrateOptions,
): Promise<NarrateResult> {
  const slotIds = collectSlotIds(markdown);
  if (slotIds.length === 0) {
    return {
      filled: markdown,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      costUsd: 0,
    };
  }

  const userBlock = [
    "SLOT IDS TO FILL (return one entry per id):",
    ...slotIds.map((id) => `- ${id}`),
    "",
    "STRUCTURED EVAL DATA (source of truth for diagnoses):",
    "```json",
    JSON.stringify(reportContext, null, 2),
    "```",
    "",
    "RENDERED REPORT WITH SLOT MARKERS:",
    "```markdown",
    markdown,
    "```",
    "",
    "Return a single JSON object {slot_id: replacement_string}.",
  ].join("\n");

  const response = await client.messages.create({
    model: options.model,
    max_tokens: NARRATE_MAX_TOKENS,
    system: [
      {
        type: "text",
        text: NARRATE_SYSTEM,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userBlock }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const fills = parseSlotMap(text);
  const usage = {
    input_tokens: response.usage.input_tokens ?? 0,
    output_tokens: response.usage.output_tokens ?? 0,
    cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
  };
  const costUsd = estimateNarrateCost(
    options.model,
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_read_input_tokens,
    usage.cache_creation_input_tokens,
  );
  if (costUsd > options.costCapUsd) {
    throw new Error(
      `Narration cost cap exceeded: spent $${costUsd.toFixed(4)} of $${options.costCapUsd.toFixed(2)}`,
    );
  }

  return {
    filled: applySlotFills(markdown, fills),
    usage,
    costUsd,
  };
}

/** Trim the eval report to only the fields the narration pass needs. */
function narrationContext(
  report: EvalReport,
  assets: Record<string, SkillAssets>,
): unknown {
  return {
    skills: report.skills.map((s) => ({
      skill_name: s.skill_name,
      delta: s.delta,
      tokens: assets[s.skill_name]?.tokens ?? null,
      scenarios: s.scenarios.map((sc) => ({
        scenario_id: sc.scenario_id,
        prompt: sc.prompt,
        delta: sc.delta,
        failed_with_skill: sc.with_grades
          .filter((g) => !g.satisfied)
          .map((g) => ({
            id: g.id,
            assertion:
              assets[s.skill_name]?.assertions[sc.scenario_id - 1]?.[g.id - 1] ?? "",
            evidence: g.evidence,
          })),
        failed_without_skill: sc.without_grades
          .filter((g) => !g.satisfied)
          .map((g) => ({
            id: g.id,
            assertion:
              assets[s.skill_name]?.assertions[sc.scenario_id - 1]?.[g.id - 1] ?? "",
            evidence: g.evidence,
          })),
      })),
    })),
  };
}

// --- CLI -----------------------------------------------------------------

type CliOptions = {
  inputPath: string;
  skillsDir: string;
  outputDir: string;
  date: string;
  narrate: boolean;
  narrateModel: string;
  narrateCostCapUsd: number;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    inputPath: "",
    skillsDir: ".agents/skills",
    outputDir: "",
    date: new Date().toISOString().slice(0, 10),
    narrate: false,
    narrateModel: DEFAULT_NARRATE_MODEL,
    narrateCostCapUsd: DEFAULT_NARRATE_COST_CAP_USD,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--input") options.inputPath = argv[++i]!;
    else if (arg === "--skills-dir") options.skillsDir = argv[++i]!;
    else if (arg === "--output-dir") options.outputDir = argv[++i]!;
    else if (arg === "--date") options.date = argv[++i]!;
    else if (arg === "--narrate") options.narrate = true;
    else if (arg === "--narrate-model") options.narrateModel = argv[++i]!;
    else if (arg === "--narrate-cost-cap-usd") {
      const next = argv[++i]!;
      const parsed = Number.parseFloat(next);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--narrate-cost-cap-usd expected a positive number, got: ${next}`);
      }
      options.narrateCostCapUsd = parsed;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.inputPath) {
    throw new Error("--input <path> is required (structured eval JSON)");
  }
  if (!options.outputDir) {
    throw new Error("--output-dir <path> is required");
  }
  return options;
}

function printHelp(): void {
  process.stdout.write(
    [
      "render-eval-reports — emit weakest-links.md and value-vs-cost.md from eval JSON",
      "",
      "  --input <path>                 structured JSON from evaluate-skills (required)",
      "  --skills-dir <path>            skills root for SKILL.md sizes + evals.json (default: .agents/skills)",
      "  --output-dir <path>            where to write the two markdown files (required)",
      "  --date <YYYY-MM-DD>            override report date (defaults to UTC today)",
      "  --narrate                      fill <!-- slot --> placeholders via Haiku (needs ANTHROPIC_API_KEY)",
      `  --narrate-model <id>           override narration model (default: ${DEFAULT_NARRATE_MODEL})`,
      `  --narrate-cost-cap-usd <num>   per-report spend cap (default: $${DEFAULT_NARRATE_COST_CAP_USD.toFixed(2)})`,
      "",
      `Without ANTHROPIC_API_KEY, --narrate exits ${NARRATE_NEUTRAL_EXIT_CODE} (neutral) and leaves slot markers in place.`,
      "",
    ].join("\n"),
  );
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const report = JSON.parse(readFileSync(options.inputPath, "utf8")) as EvalReport;
  const skillNames = report.skills.map((s) => s.skill_name);
  const assets = loadSkillAssets(options.skillsDir, skillNames);

  if (!existsSync(options.outputDir)) {
    mkdirSync(options.outputDir, { recursive: true });
  }

  const weakestLinksPath = path.join(options.outputDir, "weakest-links.md");
  const valueVsCostPath = path.join(options.outputDir, "value-vs-cost.md");

  let weakestLinks = renderWeakestLinks(report, assets, options.date);
  let valueVsCost = renderValueVsCost(report, assets, options.date);

  if (options.narrate) {
    if (!process.env.ANTHROPIC_API_KEY) {
      process.stderr.write(
        "--narrate requires ANTHROPIC_API_KEY. Skipping narration; writing reports with slot markers intact.\n",
      );
      writeFileSync(weakestLinksPath, weakestLinks + "\n", "utf8");
      writeFileSync(valueVsCostPath, valueVsCost + "\n", "utf8");
      return NARRATE_NEUTRAL_EXIT_CODE;
    }
    const client = new Anthropic();
    const context = narrationContext(report, assets);
    const narrateOptions: NarrateOptions = {
      model: options.narrateModel,
      costCapUsd: options.narrateCostCapUsd,
    };
    const wlResult = await narrateReport(client, weakestLinks, context, narrateOptions);
    const vcResult = await narrateReport(client, valueVsCost, context, narrateOptions);
    weakestLinks = wlResult.filled;
    valueVsCost = vcResult.filled;
    const totalCost = wlResult.costUsd + vcResult.costUsd;
    process.stdout.write(
      `Narration: $${totalCost.toFixed(4)} (weakest-links $${wlResult.costUsd.toFixed(4)}, ` +
        `value-vs-cost $${vcResult.costUsd.toFixed(4)}) using ${options.narrateModel}\n`,
    );
  }

  writeFileSync(weakestLinksPath, weakestLinks + "\n", "utf8");
  writeFileSync(valueVsCostPath, valueVsCost + "\n", "utf8");

  process.stdout.write(
    `Wrote ${weakestLinksPath} and ${valueVsCostPath} (${report.skills.length} skills)\n`,
  );
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("render-eval-reports.ts")) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`render-eval-reports failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
