// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/*
 * Consumes the structured JSON output from evaluate-skills.ts, appends a
 * history row to ci/skills-scoreboard-history.jsonl, and renders the public
 * scoreboard markdown (ci/skills-scoreboard.md).
 *
 * The scoreboard table columns: skill | current delta | 7-day sparkline |
 * last regression date. A collapsible "Recent regressions" block lists any
 * assertions that flipped satisfied→unsatisfied since the previous entry.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

export type AssertionGrade = {
  id: number;
  satisfied: boolean;
  evidence: string;
};

export type ScenarioResult = {
  scenario_id: number;
  prompt: string;
  with_score: number | null;
  without_score: number | null;
  delta: number | null;
  with_grades: AssertionGrade[];
  without_grades: AssertionGrade[];
  error?: string;
};

export type SkillResult = {
  skill_name: string;
  scenarios: ScenarioResult[];
  with_score: number | null;
  without_score: number | null;
  delta: number | null;
};

export type EvalReport = {
  agent_model: string;
  judge_prompt_version: string;
  skills: SkillResult[];
};

export type HistoryRow = {
  date: string;
  commit: string | null;
  skills: Record<
    string,
    {
      delta: number;
      with_score: number;
      without_score: number;
      scenarios_n: number;
      assertion_status: number[][];
    }
  >;
};

export type Regression = {
  skill: string;
  scenario_id: number;
  assertion_id: number;
  evidence: string;
};

const SPARKLINE_CHARS = "▁▂▃▄▅▆▇█";
const WINDOW_DAYS_DEFAULT = 7;

export function buildHistoryRow(
  report: EvalReport,
  date: string,
  commit: string | null,
): HistoryRow {
  const skills: HistoryRow["skills"] = {};
  for (const skill of report.skills) {
    if (skill.delta === null || skill.with_score === null || skill.without_score === null) {
      continue;
    }
    skills[skill.skill_name] = {
      delta: round4(skill.delta),
      with_score: round4(skill.with_score),
      without_score: round4(skill.without_score),
      scenarios_n: skill.scenarios.length,
      assertion_status: skill.scenarios.map((s) => s.with_grades.map((g) => (g.satisfied ? 1 : 0))),
    };
  }
  return { date, commit, skills };
}

export function readHistory(path: string): HistoryRow[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return [];
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as HistoryRow);
}

export function renderSparkline(deltas: (number | null)[]): string {
  const points = deltas.filter((d): d is number => d !== null);
  if (points.length === 0) return "—";
  if (points.length === 1) return SPARKLINE_CHARS[4]!;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min;
  return points
    .map((d) => {
      if (range === 0) return SPARKLINE_CHARS[4]!;
      const idx = Math.round(((d - min) / range) * (SPARKLINE_CHARS.length - 1));
      return SPARKLINE_CHARS[idx]!;
    })
    .join("");
}

export function detectAssertionRegressions(
  latest: HistoryRow,
  previous: HistoryRow | null,
  report: EvalReport,
): Regression[] {
  if (!previous) return [];
  const regressions: Regression[] = [];
  for (const skill of report.skills) {
    const todayEntry = latest.skills[skill.skill_name];
    const priorEntry = previous.skills[skill.skill_name];
    if (!todayEntry || !priorEntry) continue;
    for (let si = 0; si < skill.scenarios.length; si += 1) {
      const scenario = skill.scenarios[si]!;
      const priorStatuses = priorEntry.assertion_status[si];
      if (!priorStatuses) continue;
      for (let ai = 0; ai < scenario.with_grades.length; ai += 1) {
        const grade = scenario.with_grades[ai]!;
        const wasPassing = priorStatuses[ai] === 1;
        const nowFailing = !grade.satisfied;
        if (wasPassing && nowFailing) {
          regressions.push({
            skill: skill.skill_name,
            scenario_id: scenario.scenario_id,
            assertion_id: grade.id,
            evidence: grade.evidence,
          });
        }
      }
    }
  }
  return regressions;
}

export function findLastRegressionDate(skillName: string, history: HistoryRow[]): string | null {
  for (let i = history.length - 1; i >= 1; i -= 1) {
    const current = history[i]!.skills[skillName];
    const prior = history[i - 1]!.skills[skillName];
    if (!current || !prior) continue;
    if (current.delta < prior.delta - 1e-6) {
      return history[i]!.date;
    }
  }
  return null;
}

export function renderScoreboard(
  report: EvalReport,
  history: HistoryRow[],
  regressions: Regression[],
  windowDays: number = WINDOW_DAYS_DEFAULT,
): string {
  const latest = history[history.length - 1];
  if (!latest) {
    return "# NemoClaw Skills Scoreboard\n\n_No eval runs recorded yet._\n";
  }
  const window = history.slice(-windowDays);
  const commitLine = latest.commit ? `commit \`${latest.commit.slice(0, 7)}\`` : "commit unknown";

  const lines: string[] = [];
  lines.push("# NemoClaw Skills Scoreboard");
  lines.push("");
  lines.push(`_Last updated: ${latest.date} · ${commitLine}_`);
  lines.push("");
  lines.push(
    "Scores come from `scripts/evaluate-skills.ts`, which runs each skill's " +
      "scenarios with and without the SKILL.md injected. **Delta** is the " +
      "with-skill minus without-skill assertion-pass rate — a positive delta " +
      "means the skill actually helps the agent. Judge: " +
      `\`${report.judge_prompt_version}\`, agent: \`${report.agent_model}\`.`,
  );
  lines.push("");
  lines.push("| Skill | Delta | " + `${windowDays}-day trend | Last regression |`);
  lines.push("|-------|-------|--------------|-----------------|");

  const skills = Object.keys(latest.skills).sort();
  for (const skill of skills) {
    const entry = latest.skills[skill]!;
    const deltas = window.map((row) => row.skills[skill]?.delta ?? null);
    const spark = renderSparkline(deltas);
    const lastRegression = findLastRegressionDate(skill, history) ?? "—";
    const deltaStr = fmtDelta(entry.delta);
    lines.push(`| ${skill} | ${deltaStr} | ${spark} | ${lastRegression} |`);
  }

  lines.push("");
  if (regressions.length > 0) {
    lines.push("<details><summary>Recent regressions</summary>");
    lines.push("");
    lines.push(
      `Assertions that were satisfied in the prior run and failed today (${regressions.length} total):`,
    );
    lines.push("");
    for (const r of regressions) {
      lines.push(
        `- **${r.skill}** scenario ${r.scenario_id}, assertion ${r.assertion_id}: ${r.evidence || "(no evidence)"}`,
      );
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  } else if (history.length >= 2) {
    lines.push("_No assertion regressions versus the previous run._");
    lines.push("");
  }
  return lines.join("\n");
}

function fmtDelta(delta: number): string {
  const sign = delta >= 0 ? "+" : "";
  return `${sign}${delta.toFixed(2)}`;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function buildBaseline(
  report: EvalReport,
  commit: string | null,
  date: string,
): {
  generated_at: string;
  baseline_commit: string | null;
  judge_prompt_version: string;
  skills: Record<
    string,
    {
      delta: number;
      with_score: number;
      without_score: number;
      scenarios_n: number;
      last_updated: string;
    }
  >;
} {
  const skills: Record<
    string,
    {
      delta: number;
      with_score: number;
      without_score: number;
      scenarios_n: number;
      last_updated: string;
    }
  > = {};
  for (const skill of report.skills) {
    if (skill.delta === null || skill.with_score === null || skill.without_score === null) {
      continue;
    }
    skills[skill.skill_name] = {
      delta: round4(skill.delta),
      with_score: round4(skill.with_score),
      without_score: round4(skill.without_score),
      scenarios_n: skill.scenarios.length,
      last_updated: date,
    };
  }
  return {
    generated_at: date,
    baseline_commit: commit,
    judge_prompt_version: report.judge_prompt_version,
    skills,
  };
}

type CliOptions = {
  latestPath: string;
  historyPath: string;
  outputPath: string;
  baselinePath: string | null;
  commit: string | null;
  date: string;
  windowDays: number;
  appendHistory: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    latestPath: "",
    historyPath: "ci/skills-scoreboard-history.jsonl",
    outputPath: "ci/skills-scoreboard.md",
    baselinePath: null,
    commit: null,
    date: new Date().toISOString().slice(0, 10),
    windowDays: WINDOW_DAYS_DEFAULT,
    appendHistory: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--latest") options.latestPath = argv[++i]!;
    else if (arg === "--history") options.historyPath = argv[++i]!;
    else if (arg === "--output") options.outputPath = argv[++i]!;
    else if (arg === "--baseline") options.baselinePath = argv[++i]!;
    else if (arg === "--commit") options.commit = argv[++i]!;
    else if (arg === "--date") options.date = argv[++i]!;
    else if (arg === "--window-days") options.windowDays = Number(argv[++i]);
    else if (arg === "--no-append-history") options.appendHistory = false;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.latestPath) {
    throw new Error("--latest <path> is required (structured eval JSON)");
  }
  return options;
}

function printHelp(): void {
  process.stdout.write(
    [
      "update-skills-scoreboard — render ci/skills-scoreboard.md from eval output",
      "",
      "  --latest <path>        structured JSON from evaluate-skills (required)",
      "  --history <path>       append-only JSONL history (default: ci/skills-scoreboard-history.jsonl)",
      "  --output <path>        scoreboard markdown output (default: ci/skills-scoreboard.md)",
      "  --baseline <path>      when set, also refresh the baseline JSON at this path",
      "  --commit <sha>         commit SHA to record in the history row",
      "  --date <YYYY-MM-DD>    override today's date (defaults to UTC today)",
      "  --window-days <n>      sparkline window (default: 7)",
      "  --no-append-history    render only; do not append a new history row",
      "",
    ].join("\n"),
  );
}

function main(): number {
  const options = parseArgs(process.argv.slice(2));
  const report = JSON.parse(readFileSync(options.latestPath, "utf8")) as EvalReport;

  const priorHistory = readHistory(options.historyPath);
  const todayRow = buildHistoryRow(report, options.date, options.commit);
  const priorEntry = priorHistory[priorHistory.length - 1] ?? null;
  const regressions = detectAssertionRegressions(todayRow, priorEntry, report);

  const history = options.appendHistory
    ? [...priorHistory, todayRow]
    : priorHistory.length > 0
      ? priorHistory
      : [todayRow];

  if (options.appendHistory) {
    appendFileSync(options.historyPath, JSON.stringify(todayRow) + "\n", "utf8");
  }

  const scoreboard = renderScoreboard(report, history, regressions, options.windowDays);
  writeFileSync(options.outputPath, scoreboard, "utf8");
  if (options.baselinePath) {
    const baseline = buildBaseline(report, options.commit, options.date);
    writeFileSync(options.baselinePath, JSON.stringify(baseline, null, 2) + "\n", "utf8");
  }
  process.stdout.write(
    `Scoreboard written to ${options.outputPath} (${Object.keys(todayRow.skills).length} skills, ${regressions.length} regressions)\n`,
  );
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("update-skills-scoreboard.ts")) {
  process.exit(main());
}
