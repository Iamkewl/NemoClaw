// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  classifyRegression,
  estimateCostUsd,
  JUDGE_MODEL,
  parseJudgeJson,
} from "../scripts/evaluate-skills";

describe("parseJudgeJson", () => {
  it("parses a valid array of grades", () => {
    const raw =
      '[{"id":1,"satisfied":true,"evidence":"q"},{"id":2,"satisfied":false,"evidence":"n"}]';
    const grades = parseJudgeJson(raw, 2);
    expect(grades).toHaveLength(2);
    expect(grades[0]).toEqual({ id: 1, satisfied: true, evidence: "q" });
    expect(grades[1]?.satisfied).toBe(false);
  });

  it("tolerates prose wrapping when the array can be extracted", () => {
    const raw = 'Here you go: [{"id":1,"satisfied":true,"evidence":""}] done.';
    const grades = parseJudgeJson(raw, 1);
    expect(grades).toHaveLength(1);
  });

  it("rejects a grade count mismatch", () => {
    const raw = '[{"id":1,"satisfied":true,"evidence":""}]';
    expect(() => parseJudgeJson(raw, 2)).toThrow(/expected 2/);
  });

  it("rejects non-array output", () => {
    expect(() => parseJudgeJson("no json here", 1)).toThrow();
  });

  it("rejects a grade object missing the satisfied key", () => {
    const raw = '[{"id":1,"evidence":"missing flag"}]';
    expect(() => parseJudgeJson(raw, 1)).toThrow(/satisfied/);
  });
});

describe("estimateCostUsd", () => {
  it("bills regular + cache-write + cache-read at the right ratios", () => {
    const cost = estimateCostUsd({
      model: JUDGE_MODEL,
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    // Haiku 4.5: $1/MTok in, $5/MTok out → $6.00 for 1M in + 1M out.
    expect(cost).toBeCloseTo(6, 5);
  });

  it("discounts cache reads to 10% of the input rate", () => {
    const cost = estimateCostUsd({
      model: JUDGE_MODEL,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1_000_000,
    });
    // Haiku 4.5: $1/MTok input × 0.1 for cache reads = $0.10.
    expect(cost).toBeCloseTo(0.1, 5);
  });
});

describe("classifyRegression", () => {
  const options = {
    rootDir: "/tmp",
    skills: null,
    changedOnly: false,
    changedBaseRef: "origin/main",
    outputFormat: "markdown" as const,
    outputPath: null,
    baselinePath: null,
    maxConcurrency: 4,
    skipWithoutSkill: false,
    costCapUsd: 2.5,
    deltaDropTolerance: 0.1,
    absoluteFloor: 0,
  };

  it("returns new_skill for skills without a baseline entry when delta ≥ 0", () => {
    const { status } = classifyRegression(
      "new-skill",
      0.25,
      { skills: {} },
      options,
    );
    expect(status.type).toBe("new_skill");
  });

  it("fails a new skill whose delta is negative", () => {
    const { status } = classifyRegression(
      "new-skill",
      -0.05,
      { skills: {} },
      options,
    );
    expect(status.type).toBe("fail");
  });

  it("fails when the delta drops by more than the tolerance", () => {
    const baseline = {
      skills: {
        foo: {
          delta: 0.4,
          with_score: 0.8,
          without_score: 0.4,
          scenarios_n: 3,
        },
      },
    };
    const { status } = classifyRegression("foo", 0.25, baseline, options);
    expect(status.type).toBe("fail");
    if (status.type === "fail") {
      expect(status.reasons.some((r) => /dropped/.test(r))).toBe(true);
    }
  });

  it("passes when delta holds within tolerance", () => {
    const baseline = {
      skills: {
        foo: {
          delta: 0.4,
          with_score: 0.8,
          without_score: 0.4,
          scenarios_n: 3,
        },
      },
    };
    const { status } = classifyRegression("foo", 0.35, baseline, options);
    expect(status.type).toBe("pass");
  });

  it("fails on absolute floor even if baseline allows the drop", () => {
    const baseline = {
      skills: {
        foo: {
          delta: -0.2,
          with_score: 0.3,
          without_score: 0.5,
          scenarios_n: 3,
        },
      },
    };
    const { status } = classifyRegression("foo", -0.15, baseline, options);
    expect(status.type).toBe("fail");
    if (status.type === "fail") {
      expect(status.reasons.some((r) => /absolute floor/.test(r))).toBe(true);
    }
  });
});
