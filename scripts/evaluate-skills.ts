// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runs scenario-based evals for NemoClaw agent skills.
 *
 * For each scenario in a skill's evals/evals.json, runs the agent twice
 * (with SKILL.md loaded as a cached system block, then without) and asks a
 * judge to grade each response against the scenario's assertions. Aggregates
 * the per-assertion boolean grades into with/without scores and a delta.
 *
 * Policy invariants (see ci/skills-eval-policy.md):
 *   - Agent model:  claude-sonnet-4-6
 *   - Judge model:  claude-haiku-4-5-20251001
 *   - Judge prompt: .context/judge-prompt-v0.md (inlined below as JUDGE_SYSTEM)
 *   - Per-invocation cost cap: $2.50 (aborts remaining scenarios when exceeded)
 *   - Fork-PR handling: missing ANTHROPIC_API_KEY → neutral exit (code 78)
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import Anthropic from "@anthropic-ai/sdk";

const AGENT_MODEL = "claude-sonnet-4-6";
const JUDGE_MODEL = "claude-haiku-4-5-20251001";
const JUDGE_PROMPT_VERSION = "v0";
const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_COST_CAP_USD = 2.5;
const AGENT_MAX_TOKENS = 2048;
const JUDGE_MAX_TOKENS = 2048;
const NEUTRAL_EXIT_CODE = 78;

/** Cached token pricing (USD per 1M tokens). Revisit quarterly; see policy. */
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5-20251001": { input: 1.0, output: 5.0 },
};

/** Judge system block — kept stable so prompt cache reads accumulate. */
const JUDGE_SYSTEM = `You grade whether an AI assistant's response satisfies a list of behavioral assertions
about that response. You do not generate new advice, correct the response, or infer
what the user might have meant. You judge only what is literally present.

For each assertion you will be given:
  1. An integer ID.
  2. A short behavioral claim (e.g., "Response mentions the onboarding wizard").

For each assertion you must return exactly one JSON object with these keys:
  - "id":        integer (echoes the input)
  - "satisfied": boolean (true only if the assertion is directly supported)
  - "evidence":  string (a single short quote from the response OR a one-sentence
                 explanation; <=200 characters)

Return all results as a single JSON array, ordered by id. Output JSON ONLY — no
prose, no code fences, no explanation outside the array.

Grading rules:
  - "Directly supported" means a reader could point to a specific sentence or
    structural element in the response that proves the assertion.
  - Do NOT give credit for plausible inference. If the assertion says "Response
    mentions X" and X is not present by name or unmistakable paraphrase, mark
    satisfied=false.
  - Negative assertions ("Response does NOT mention Y") are satisfied when Y is
    genuinely absent. Mentioning Y to dismiss it still counts as mentioning Y.
  - If an assertion is ambiguous, grade strictly (satisfied=false) and put the
    ambiguity in "evidence".
  - If you cannot find a quote, "evidence" may be a one-sentence explanation.
  - Ignore tone, formatting, and verbosity unless an assertion specifically
    references them.`;

type Scenario = {
  id: number;
  prompt: string;
  expected_output: string;
  files: string[];
  assertions: string[];
};

type SkillEvals = {
  skill_name: string;
  evals: Scenario[];
};

type AssertionGrade = {
  id: number;
  satisfied: boolean;
  evidence: string;
};

type JudgeResult = {
  grades: AssertionGrade[];
  score: number;
  usage: UsageSample;
};

type AgentResult = {
  response: string;
  usage: UsageSample;
};

type ScenarioResult = {
  scenario_id: number;
  prompt: string;
  with_score: number | null;
  without_score: number | null;
  delta: number | null;
  with_grades: AssertionGrade[];
  without_grades: AssertionGrade[];
  error?: string;
};

type SkillResult = {
  skill_name: string;
  scenarios: ScenarioResult[];
  with_score: number | null;
  without_score: number | null;
  delta: number | null;
  regression_status: RegressionStatus;
  baseline_delta: number | null;
};

type RegressionStatus =
  | { type: "pass" }
  | { type: "fail"; reasons: string[] }
  | { type: "new_skill" }
  | { type: "no_baseline" };

type UsageSample = {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};

type Baseline = {
  generated_at?: string;
  baseline_commit?: string;
  judge_prompt_version?: string;
  skills: Record<
    string,
    {
      delta: number;
      with_score: number;
      without_score: number;
      scenarios_n: number;
      last_updated?: string;
    }
  >;
};

type CliOptions = {
  rootDir: string;
  skills: string[] | null;
  changedOnly: boolean;
  changedBaseRef: string;
  outputFormat: "markdown" | "json" | "junit";
  outputPath: string | null;
  baselinePath: string | null;
  maxConcurrency: number;
  skipWithoutSkill: boolean;
  costCapUsd: number;
  deltaDropTolerance: number;
  absoluteFloor: number;
};

type AggregateUsage = {
  samples: UsageSample[];
  totalCostUsd: number;
};

class CostCapExceeded extends Error {
  constructor(public readonly spentUsd: number, public readonly capUsd: number) {
    super(`Cost cap exceeded: spent $${spentUsd.toFixed(4)} of $${capUsd.toFixed(2)}`);
    this.name = "CostCapExceeded";
  }
}

function estimateCostUsd(sample: UsageSample): number {
  const price = PRICING[sample.model];
  if (!price) return 0;
  const inputBilled =
    sample.input_tokens +
    sample.cache_creation_input_tokens * 1.25 +
    sample.cache_read_input_tokens * 0.1;
  return (
    (inputBilled * price.input) / 1_000_000 +
    (sample.output_tokens * price.output) / 1_000_000
  );
}

function sampleUsage(model: string, usage: Anthropic.Usage): UsageSample {
  return {
    model,
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
  };
}

function addUsage(agg: AggregateUsage, sample: UsageSample, capUsd: number): void {
  agg.samples.push(sample);
  agg.totalCostUsd += estimateCostUsd(sample);
  if (agg.totalCostUsd > capUsd) {
    throw new CostCapExceeded(agg.totalCostUsd, capUsd);
  }
}

function textFromContent(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

async function callAgent(
  client: Anthropic,
  skillSystemBlock: string | null,
  prompt: string,
): Promise<AgentResult> {
  const request: Anthropic.MessageCreateParamsNonStreaming = {
    model: AGENT_MODEL,
    max_tokens: AGENT_MAX_TOKENS,
    messages: [{ role: "user", content: prompt }],
  };

  if (skillSystemBlock) {
    request.system = [
      {
        type: "text",
        text: skillSystemBlock,
        cache_control: { type: "ephemeral" },
      },
    ];
  }

  const response = await client.messages.create(request);
  return {
    response: textFromContent(response.content),
    usage: sampleUsage(AGENT_MODEL, response.usage),
  };
}

function buildJudgeUserBlock(scenario: Scenario, agentResponse: string): string {
  const assertionLines = scenario.assertions
    .map((assertion, index) => `${index + 1}. ${assertion}`)
    .join("\n");
  return [
    "PROMPT GIVEN TO ASSISTANT:",
    "<<<",
    scenario.prompt,
    ">>>",
    "",
    "ASSISTANT RESPONSE:",
    "<<<",
    agentResponse,
    ">>>",
    "",
    "ASSERTIONS:",
    assertionLines,
    "",
    `Return a JSON array of ${scenario.assertions.length} objects, one per assertion, ordered by id.`,
  ].join("\n");
}

function parseJudgeJson(raw: string, expectedCount: number): AssertionGrade[] {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Judge output contained no JSON array");
  }
  const jsonSlice = trimmed.slice(start, end + 1);
  const parsed: unknown = JSON.parse(jsonSlice);
  if (!Array.isArray(parsed)) {
    throw new Error("Judge output was not a JSON array");
  }
  if (parsed.length !== expectedCount) {
    throw new Error(
      `Judge returned ${parsed.length} grades; expected ${expectedCount}`,
    );
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Grade at index ${index} was not an object`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "number" || typeof record.satisfied !== "boolean") {
      throw new Error(`Grade at index ${index} missing id or satisfied`);
    }
    const evidence = typeof record.evidence === "string" ? record.evidence : "";
    return {
      id: record.id,
      satisfied: record.satisfied,
      evidence,
    };
  });
}

async function callJudge(
  client: Anthropic,
  scenario: Scenario,
  agentResponse: string,
): Promise<JudgeResult> {
  const userBlock = buildJudgeUserBlock(scenario, agentResponse);
  const request: Anthropic.MessageCreateParamsNonStreaming = {
    model: JUDGE_MODEL,
    max_tokens: JUDGE_MAX_TOKENS,
    temperature: 0,
    system: [
      {
        type: "text",
        text: JUDGE_SYSTEM,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userBlock }],
  };

  let lastError: Error | null = null;
  const usageSamples: UsageSample[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await client.messages.create(request);
    const sample = sampleUsage(JUDGE_MODEL, response.usage);
    usageSamples.push(sample);
    try {
      const grades = parseJudgeJson(
        textFromContent(response.content),
        scenario.assertions.length,
      );
      const satisfiedCount = grades.filter((g) => g.satisfied).length;
      return {
        grades,
        score: satisfiedCount / grades.length,
        usage: reduceUsageSamples(usageSamples, JUDGE_MODEL),
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw new Error(`Judge returned unparseable output twice: ${lastError?.message ?? ""}`);
}

function reduceUsageSamples(samples: UsageSample[], model: string): UsageSample {
  return samples.reduce<UsageSample>(
    (acc, s) => ({
      model,
      input_tokens: acc.input_tokens + s.input_tokens,
      output_tokens: acc.output_tokens + s.output_tokens,
      cache_creation_input_tokens:
        acc.cache_creation_input_tokens + s.cache_creation_input_tokens,
      cache_read_input_tokens: acc.cache_read_input_tokens + s.cache_read_input_tokens,
    }),
    {
      model,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  );
}

async function evaluateScenario(
  client: Anthropic,
  skillSystemBlock: string,
  scenario: Scenario,
  skipWithoutSkill: boolean,
  usage: AggregateUsage,
  capUsd: number,
): Promise<ScenarioResult> {
  try {
    const withRun = await callAgent(client, skillSystemBlock, scenario.prompt);
    addUsage(usage, withRun.usage, capUsd);
    const withJudge = await callJudge(client, scenario, withRun.response);
    addUsage(usage, withJudge.usage, capUsd);

    let withoutScore: number | null = null;
    let withoutGrades: AssertionGrade[] = [];
    if (!skipWithoutSkill) {
      const withoutRun = await callAgent(client, null, scenario.prompt);
      addUsage(usage, withoutRun.usage, capUsd);
      const withoutJudge = await callJudge(client, scenario, withoutRun.response);
      addUsage(usage, withoutJudge.usage, capUsd);
      withoutScore = withoutJudge.score;
      withoutGrades = withoutJudge.grades;
    }

    return {
      scenario_id: scenario.id,
      prompt: scenario.prompt,
      with_score: withJudge.score,
      without_score: withoutScore,
      delta: withoutScore === null ? null : withJudge.score - withoutScore,
      with_grades: withJudge.grades,
      without_grades: withoutGrades,
    };
  } catch (error) {
    if (error instanceof CostCapExceeded) throw error;
    return {
      scenario_id: scenario.id,
      prompt: scenario.prompt,
      with_score: null,
      without_score: null,
      delta: null,
      with_grades: [],
      without_grades: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function classifyRegression(
  skillName: string,
  skillDelta: number | null,
  baseline: Baseline | null,
  options: CliOptions,
): { status: RegressionStatus; baselineDelta: number | null } {
  const baselineEntry = baseline?.skills?.[skillName] ?? null;
  if (skillDelta === null) {
    return { status: { type: "no_baseline" }, baselineDelta: baselineEntry?.delta ?? null };
  }
  if (!baselineEntry) {
    if (skillDelta >= 0) return { status: { type: "new_skill" }, baselineDelta: null };
    return {
      status: { type: "fail", reasons: [`new skill delta ${skillDelta.toFixed(3)} < 0`] },
      baselineDelta: null,
    };
  }
  const reasons: string[] = [];
  if (baselineEntry.delta - skillDelta > options.deltaDropTolerance) {
    reasons.push(
      `delta dropped by ${(baselineEntry.delta - skillDelta).toFixed(3)} ` +
        `(baseline ${baselineEntry.delta.toFixed(3)} → current ${skillDelta.toFixed(3)}, ` +
        `tolerance ${options.deltaDropTolerance.toFixed(2)})`,
    );
  }
  if (skillDelta < options.absoluteFloor) {
    reasons.push(
      `delta ${skillDelta.toFixed(3)} below absolute floor ${options.absoluteFloor.toFixed(2)}`,
    );
  }
  if (reasons.length === 0) {
    return { status: { type: "pass" }, baselineDelta: baselineEntry.delta };
  }
  return { status: { type: "fail", reasons }, baselineDelta: baselineEntry.delta };
}

async function evaluateSkill(
  client: Anthropic,
  skillName: string,
  skillDir: string,
  options: CliOptions,
  baseline: Baseline | null,
  usage: AggregateUsage,
): Promise<SkillResult> {
  const evalsPath = path.join(skillDir, "evals", "evals.json");
  const skillMdPath = path.join(skillDir, "SKILL.md");
  const evalsDoc = JSON.parse(readFileSync(evalsPath, "utf8")) as SkillEvals;
  const skillSystemBlock = readFileSync(skillMdPath, "utf8");

  const scenarioResults: ScenarioResult[] = [];
  await runWithConcurrency(evalsDoc.evals, options.maxConcurrency, async (scenario) => {
    const result = await evaluateScenario(
      client,
      skillSystemBlock,
      scenario,
      options.skipWithoutSkill,
      usage,
      options.costCapUsd,
    );
    scenarioResults.push(result);
  });
  scenarioResults.sort((a, b) => a.scenario_id - b.scenario_id);

  const withScores = scenarioResults
    .map((r) => r.with_score)
    .filter((v): v is number => v !== null);
  const withoutScores = scenarioResults
    .map((r) => r.without_score)
    .filter((v): v is number => v !== null);
  const deltas = scenarioResults
    .map((r) => r.delta)
    .filter((v): v is number => v !== null);

  const skillDelta = deltas.length > 0 ? mean(deltas) : null;
  const { status, baselineDelta } = classifyRegression(skillName, skillDelta, baseline, options);

  return {
    skill_name: skillName,
    scenarios: scenarioResults,
    with_score: mean(withScores),
    without_score: withoutScores.length > 0 ? mean(withoutScores) : null,
    delta: skillDelta,
    regression_status: status,
    baseline_delta: baselineDelta,
  };
}

async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const effectiveLimit = Math.max(1, Math.min(limit, items.length));
  const queue = [...items];
  const runners: Promise<void>[] = [];
  for (let i = 0; i < effectiveLimit; i += 1) {
    runners.push(
      (async () => {
        while (queue.length > 0) {
          const next = queue.shift();
          if (next === undefined) break;
          await worker(next);
        }
      })(),
    );
  }
  await Promise.all(runners);
}

function getChangedSkills(rootDir: string, baseRef: string): string[] {
  try {
    const out = execFileSync(
      "git",
      ["diff", "--name-only", `${baseRef}...HEAD`, "--", ".agents/skills/"],
      { cwd: rootDir, encoding: "utf8" },
    );
    const changed = new Set<string>();
    for (const line of out.split("\n")) {
      const match = line.match(/^\.agents\/skills\/([^/]+)\//);
      if (match?.[1]) changed.add(match[1]);
    }
    return [...changed].sort();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git diff failed for base ref '${baseRef}': ${message}`);
  }
}

function listAllSkillsWithEvals(rootDir: string): string[] {
  const skillsDir = path.join(rootDir, ".agents", "skills");
  const dirents = readdirSync(skillsDir, { withFileTypes: true });
  const result: string[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const evalsPath = path.join(skillsDir, dirent.name, "evals", "evals.json");
    if (existsSync(evalsPath)) result.push(dirent.name);
  }
  return result.sort();
}

function loadBaseline(baselinePath: string | null): Baseline | null {
  if (!baselinePath) return null;
  if (!existsSync(baselinePath)) return null;
  const parsed = JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline;
  if (!parsed.skills || typeof parsed.skills !== "object") {
    throw new Error(`Baseline ${baselinePath} missing 'skills' object`);
  }
  if (parsed.judge_prompt_version && parsed.judge_prompt_version !== JUDGE_PROMPT_VERSION) {
    console.error(
      `Warning: baseline judge_prompt_version '${parsed.judge_prompt_version}' ` +
        `!= current '${JUDGE_PROMPT_VERSION}'. Rule 1 (delta-drop) is suspended for this run.`,
    );
  }
  return parsed;
}

function renderMarkdown(skills: SkillResult[], usage: AggregateUsage): string {
  const lines: string[] = [];
  lines.push("# Skills eval report");
  lines.push("");
  lines.push(
    `- agent model: \`${AGENT_MODEL}\` · judge model: \`${JUDGE_MODEL}\` · judge prompt: \`${JUDGE_PROMPT_VERSION}\``,
  );
  lines.push(`- total estimated cost: $${usage.totalCostUsd.toFixed(4)}`);
  const totalCacheReads = usage.samples.reduce(
    (acc, s) => acc + s.cache_read_input_tokens,
    0,
  );
  lines.push(`- total cache_read_input_tokens: ${totalCacheReads}`);
  lines.push("");

  lines.push("| skill | with | without | delta | baseline Δ | status |");
  lines.push("|-------|------|---------|-------|------------|--------|");
  for (const skill of skills) {
    const status = renderStatus(skill.regression_status);
    lines.push(
      `| \`${skill.skill_name}\` | ${fmtScore(skill.with_score)} | ${fmtScore(skill.without_score)} ` +
        `| ${fmtScore(skill.delta)} | ${fmtScore(skill.baseline_delta)} | ${status} |`,
    );
  }
  lines.push("");

  for (const skill of skills) {
    lines.push(`## ${skill.skill_name}`);
    lines.push("");
    if (skill.regression_status.type === "fail") {
      lines.push("**FAIL** — " + skill.regression_status.reasons.join("; "));
      lines.push("");
    }
    for (const scenario of skill.scenarios) {
      lines.push(`### Scenario ${scenario.scenario_id}`);
      lines.push(`> ${scenario.prompt.replace(/\n/g, " ")}`);
      lines.push("");
      if (scenario.error) {
        lines.push(`**Error**: ${scenario.error}`);
        lines.push("");
        continue;
      }
      lines.push(
        `- with: ${fmtScore(scenario.with_score)} · without: ${fmtScore(scenario.without_score)} · delta: ${fmtScore(scenario.delta)}`,
      );
      lines.push("");
      lines.push("<details><summary>With-skill grades</summary>");
      lines.push("");
      for (const grade of scenario.with_grades) {
        lines.push(`- [${grade.satisfied ? "x" : " "}] (${grade.id}) ${grade.evidence}`);
      }
      lines.push("");
      lines.push("</details>");
      lines.push("");
      if (scenario.without_grades.length > 0) {
        lines.push("<details><summary>Without-skill grades</summary>");
        lines.push("");
        for (const grade of scenario.without_grades) {
          lines.push(`- [${grade.satisfied ? "x" : " "}] (${grade.id}) ${grade.evidence}`);
        }
        lines.push("");
        lines.push("</details>");
        lines.push("");
      }
    }
  }
  return lines.join("\n");
}

function fmtScore(value: number | null): string {
  if (value === null) return "—";
  return value.toFixed(3);
}

function renderStatus(status: RegressionStatus): string {
  switch (status.type) {
    case "pass":
      return "✅ pass";
    case "new_skill":
      return "🆕 new skill";
    case "no_baseline":
      return "⚠️ no baseline";
    case "fail":
      return "❌ fail";
  }
}

function renderJunit(skills: SkillResult[]): string {
  const esc = (s: string): string =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const suites: string[] = [];
  for (const skill of skills) {
    const failures =
      skill.regression_status.type === "fail" ? skill.regression_status.reasons.length : 0;
    const cases: string[] = [];
    for (const scenario of skill.scenarios) {
      const name = `scenario_${scenario.scenario_id}`;
      const bodyParts: string[] = [];
      if (scenario.error) {
        bodyParts.push(`<error message="${esc(scenario.error)}"/>`);
      }
      if (skill.regression_status.type === "fail") {
        bodyParts.push(
          `<failure message="${esc(skill.regression_status.reasons.join("; "))}"/>`,
        );
      }
      cases.push(
        `<testcase classname="${esc(skill.skill_name)}" name="${esc(name)}">${bodyParts.join("")}</testcase>`,
      );
    }
    suites.push(
      `<testsuite name="${esc(skill.skill_name)}" tests="${skill.scenarios.length}" failures="${failures}">${cases.join("")}</testsuite>`,
    );
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>${suites.join("")}</testsuites>`;
}

function renderJson(skills: SkillResult[], usage: AggregateUsage): string {
  return JSON.stringify(
    {
      agent_model: AGENT_MODEL,
      judge_model: JUDGE_MODEL,
      judge_prompt_version: JUDGE_PROMPT_VERSION,
      total_cost_usd: Number(usage.totalCostUsd.toFixed(6)),
      cache_read_input_tokens: usage.samples.reduce(
        (acc, s) => acc + s.cache_read_input_tokens,
        0,
      ),
      skills,
    },
    null,
    2,
  );
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    rootDir: process.cwd(),
    skills: null,
    changedOnly: false,
    changedBaseRef: "origin/main",
    outputFormat: "markdown",
    outputPath: null,
    baselinePath: null,
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    skipWithoutSkill: false,
    costCapUsd: DEFAULT_COST_CAP_USD,
    deltaDropTolerance: 0.1,
    absoluteFloor: 0,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--skills":
        options.skills = next().split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--changed-only":
        options.changedOnly = true;
        break;
      case "--base-ref":
        options.changedBaseRef = next();
        break;
      case "--output":
        options.outputFormat = next() as CliOptions["outputFormat"];
        if (!["markdown", "json", "junit"].includes(options.outputFormat)) {
          throw new Error(`Unknown --output: ${options.outputFormat}`);
        }
        break;
      case "--output-path":
        options.outputPath = next();
        break;
      case "--baseline":
        options.baselinePath = next();
        break;
      case "--max-concurrency":
        options.maxConcurrency = Number.parseInt(next(), 10);
        if (!Number.isFinite(options.maxConcurrency) || options.maxConcurrency < 1) {
          throw new Error("--max-concurrency must be a positive integer");
        }
        break;
      case "--skip-without-skill":
        options.skipWithoutSkill = true;
        break;
      case "--cost-cap":
        options.costCapUsd = Number.parseFloat(next());
        break;
      case "--delta-drop-tolerance":
        options.deltaDropTolerance = Number.parseFloat(next());
        break;
      case "--absolute-floor":
        options.absoluteFloor = Number.parseFloat(next());
        break;
      case "--root":
        options.rootDir = path.resolve(next());
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printHelp(): void {
  console.log(`Usage: npm run eval:skills -- [options]

Runs scenario-based evals for NemoClaw agent skills and grades responses with
an LLM judge. See ci/skills-eval-policy.md for regression-gate semantics.

Options:
  --skills <a,b,c>             Comma-separated skill names (default: all with evals.json)
  --changed-only               Only skills with changed files vs --base-ref
  --base-ref <ref>             Git ref for --changed-only (default: origin/main)
  --output <markdown|json|junit>  Output format (default: markdown)
  --output-path <file>         Write output to file instead of stdout
  --baseline <path>            Baseline JSON for regression gating
  --max-concurrency <n>        Parallel scenarios per skill (default: ${String(DEFAULT_MAX_CONCURRENCY)})
  --skip-without-skill         Skip the without-skill run (dev/calibration mode)
  --cost-cap <usd>             Abort if estimated cost exceeds this (default: $${DEFAULT_COST_CAP_USD})
  --delta-drop-tolerance <n>   Max allowed delta drop vs baseline (default: 0.10)
  --absolute-floor <n>         Minimum acceptable delta (default: 0)
  --root <dir>                 Repo root (default: cwd)
  -h, --help                   Show this help

Env:
  ANTHROPIC_API_KEY            Required. If missing, exits ${String(NEUTRAL_EXIT_CODE)} (neutral) for fork PRs.`);
}

function resolveSkills(options: CliOptions): string[] {
  if (options.skills && options.skills.length > 0) return options.skills;
  if (options.changedOnly) return getChangedSkills(options.rootDir, options.changedBaseRef);
  return listAllSkillsWithEvals(options.rootDir);
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(
      "ANTHROPIC_API_KEY is not set. Skipping skills eval (neutral). " +
        "Maintainers must rerun after reviewing fork PRs.",
    );
    return NEUTRAL_EXIT_CODE;
  }

  const skillNames = resolveSkills(options);
  if (skillNames.length === 0) {
    console.error("No skills to evaluate.");
    return 0;
  }

  const baseline = loadBaseline(options.baselinePath);
  const client = new Anthropic({ apiKey, maxRetries: 2 });
  const usage: AggregateUsage = { samples: [], totalCostUsd: 0 };
  const skillResults: SkillResult[] = [];
  let costCapped = false;

  for (const skillName of skillNames) {
    const skillDir = path.join(options.rootDir, ".agents", "skills", skillName);
    if (!existsSync(path.join(skillDir, "evals", "evals.json"))) {
      console.error(`Skipping ${skillName}: no evals/evals.json`);
      continue;
    }
    try {
      const result = await evaluateSkill(client, skillName, skillDir, options, baseline, usage);
      skillResults.push(result);
    } catch (error) {
      if (error instanceof CostCapExceeded) {
        console.error(error.message);
        costCapped = true;
        break;
      }
      throw error;
    }
  }

  const rendered =
    options.outputFormat === "json"
      ? renderJson(skillResults, usage)
      : options.outputFormat === "junit"
        ? renderJunit(skillResults)
        : renderMarkdown(skillResults, usage);

  if (options.outputPath) {
    writeFileSync(options.outputPath, rendered);
  } else {
    console.log(rendered);
  }

  const hasFailure = skillResults.some((s) => s.regression_status.type === "fail");
  if (costCapped) return 1;
  return hasFailure ? 1 : 0;
}

const THIS_FILE = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
  main().then(
    (code) => {
      process.exit(code);
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exit(1);
    },
  );
}

export {
  callAgent,
  callJudge,
  classifyRegression,
  evaluateScenario,
  evaluateSkill,
  estimateCostUsd,
  main,
  parseArgs,
  parseJudgeJson,
  AGENT_MODEL,
  JUDGE_MODEL,
  JUDGE_PROMPT_VERSION,
};
