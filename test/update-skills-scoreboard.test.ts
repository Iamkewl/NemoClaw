// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildBaseline,
  buildHistoryRow,
  detectAssertionRegressions,
  findLastRegressionDate,
  renderScoreboard,
  renderSparkline,
  type EvalReport,
  type HistoryRow,
} from "../scripts/update-skills-scoreboard";

function makeReport(overrides: Partial<EvalReport> = {}): EvalReport {
  return {
    agent_model: "claude-sonnet-4-6",
    judge_prompt_version: "v0",
    skills: [
      {
        skill_name: "skill-a",
        with_score: 0.8,
        without_score: 0.4,
        delta: 0.4,
        scenarios: [
          {
            scenario_id: 1,
            prompt: "p1",
            with_score: 1.0,
            without_score: 0.5,
            delta: 0.5,
            with_grades: [
              { id: 1, satisfied: true, evidence: "q1" },
              { id: 2, satisfied: true, evidence: "q2" },
            ],
            without_grades: [
              { id: 1, satisfied: true, evidence: "q1" },
              { id: 2, satisfied: false, evidence: "q2" },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("renderSparkline", () => {
  it("returns an em-dash when there are no points", () => {
    expect(renderSparkline([])).toBe("—");
    expect(renderSparkline([null, null])).toBe("—");
  });

  it("returns mid-level block for a single point", () => {
    expect(renderSparkline([0.5])).toBe("▅");
  });

  it("spans min→max across available blocks", () => {
    const spark = renderSparkline([0.0, 0.25, 0.5, 0.75, 1.0]);
    expect(spark).toHaveLength(5);
    expect(spark[0]).toBe("▁");
    expect(spark[spark.length - 1]).toBe("█");
  });

  it("flattens a constant series to the mid level", () => {
    expect(renderSparkline([0.3, 0.3, 0.3])).toBe("▅▅▅");
  });
});

describe("buildHistoryRow", () => {
  it("captures per-scenario assertion status bits", () => {
    const row = buildHistoryRow(makeReport(), "2026-04-20", "abc1234");
    expect(row.date).toBe("2026-04-20");
    expect(row.commit).toBe("abc1234");
    expect(row.skills["skill-a"]?.assertion_status).toEqual([[1, 1]]);
    expect(row.skills["skill-a"]?.delta).toBe(0.4);
  });

  it("skips skills whose delta never resolved (errored out)", () => {
    const report = makeReport({
      skills: [
        {
          skill_name: "broken",
          with_score: null,
          without_score: null,
          delta: null,
          scenarios: [],
        },
      ],
    });
    const row = buildHistoryRow(report, "2026-04-20", null);
    expect(row.skills).toEqual({});
  });
});

describe("detectAssertionRegressions", () => {
  it("flags a prior-passing assertion that fails today", () => {
    const report = makeReport();
    // Today assertion #2 fails.
    report.skills[0]!.scenarios[0]!.with_grades[1] = {
      id: 2,
      satisfied: false,
      evidence: "now wrong",
    };
    const today = buildHistoryRow(report, "2026-04-20", null);
    const prior: HistoryRow = {
      date: "2026-04-19",
      commit: null,
      skills: {
        "skill-a": {
          delta: 0.4,
          with_score: 0.8,
          without_score: 0.4,
          scenarios_n: 1,
          assertion_status: [[1, 1]],
        },
      },
    };
    const regressions = detectAssertionRegressions(today, prior, report);
    expect(regressions).toHaveLength(1);
    expect(regressions[0]).toMatchObject({
      skill: "skill-a",
      scenario_id: 1,
      assertion_id: 2,
      evidence: "now wrong",
    });
  });

  it("returns empty when there is no prior entry (first run)", () => {
    const report = makeReport();
    const today = buildHistoryRow(report, "2026-04-20", null);
    expect(detectAssertionRegressions(today, null, report)).toEqual([]);
  });

  it("does not flag assertions that were failing yesterday too", () => {
    const report = makeReport();
    report.skills[0]!.scenarios[0]!.with_grades[1] = {
      id: 2,
      satisfied: false,
      evidence: "still wrong",
    };
    const today = buildHistoryRow(report, "2026-04-20", null);
    const prior: HistoryRow = {
      date: "2026-04-19",
      commit: null,
      skills: {
        "skill-a": {
          delta: 0.35,
          with_score: 0.75,
          without_score: 0.4,
          scenarios_n: 1,
          assertion_status: [[1, 0]],
        },
      },
    };
    expect(detectAssertionRegressions(today, prior, report)).toEqual([]);
  });
});

describe("findLastRegressionDate", () => {
  it("returns the most recent date where skill delta dropped", () => {
    const history: HistoryRow[] = [
      mkRow("2026-04-15", "skill-a", 0.5),
      mkRow("2026-04-16", "skill-a", 0.5),
      mkRow("2026-04-17", "skill-a", 0.3),
      mkRow("2026-04-18", "skill-a", 0.35),
      mkRow("2026-04-19", "skill-a", 0.25),
    ];
    expect(findLastRegressionDate("skill-a", history)).toBe("2026-04-19");
  });

  it("returns null when the skill has only ever improved or held", () => {
    const history: HistoryRow[] = [
      mkRow("2026-04-18", "skill-a", 0.3),
      mkRow("2026-04-19", "skill-a", 0.4),
    ];
    expect(findLastRegressionDate("skill-a", history)).toBeNull();
  });
});

describe("renderScoreboard", () => {
  it("renders a row per skill with a sparkline and delta", () => {
    const report = makeReport();
    const today = buildHistoryRow(report, "2026-04-20", "abc1234");
    const out = renderScoreboard(report, [today], [], 7);
    expect(out).toContain("# NemoClaw Skills Scoreboard");
    expect(out).toContain("skill-a");
    expect(out).toContain("+0.40");
    expect(out).toContain("abc1234".slice(0, 7));
  });

  it("shows a regression block when flips are present", () => {
    const report = makeReport();
    report.skills[0]!.scenarios[0]!.with_grades[1] = {
      id: 2,
      satisfied: false,
      evidence: "flip",
    };
    const today = buildHistoryRow(report, "2026-04-20", null);
    const regressions = [
      {
        skill: "skill-a",
        scenario_id: 1,
        assertion_id: 2,
        evidence: "flip",
      },
    ];
    const out = renderScoreboard(report, [today], regressions);
    expect(out).toContain("Recent regressions");
    expect(out).toContain("scenario 1, assertion 2");
  });

  it("handles a first-ever run gracefully", () => {
    const empty = renderScoreboard(makeReport(), [], [], 7);
    expect(empty).toContain("No eval runs recorded yet");
  });
});

describe("buildBaseline", () => {
  it("mirrors the shape of ci/skills-eval-baseline.json", () => {
    const baseline = buildBaseline(makeReport(), "abc123", "2026-04-20");
    expect(baseline.generated_at).toBe("2026-04-20");
    expect(baseline.baseline_commit).toBe("abc123");
    expect(baseline.judge_prompt_version).toBe("v0");
    expect(baseline.skills["skill-a"]).toMatchObject({
      delta: 0.4,
      with_score: 0.8,
      without_score: 0.4,
      scenarios_n: 1,
      last_updated: "2026-04-20",
    });
  });
});

function mkRow(date: string, skill: string, delta: number): HistoryRow {
  return {
    date,
    commit: null,
    skills: {
      [skill]: {
        delta,
        with_score: delta + 0.4,
        without_score: 0.4,
        scenarios_n: 1,
        assertion_status: [[1]],
      },
    },
  };
}
