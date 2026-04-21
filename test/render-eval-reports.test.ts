// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  classifyQuadrant,
  findAssertionGaps,
  findHurtingScenarios,
  findMarginalScenarios,
  loadSkillAssets,
  renderValueVsCost,
  renderWeakestLinks,
} from "../scripts/render-eval-reports";
import type { EvalReport } from "../scripts/update-skills-scoreboard";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const demoEvalPath = path.join(repoRoot, ".context", "demo-eval", "eval.json");
const skillsDir = path.join(repoRoot, ".agents", "skills");

function loadDemo(): EvalReport {
  return JSON.parse(readFileSync(demoEvalPath, "utf8")) as EvalReport;
}

describe("classifyQuadrant", () => {
  it("puts high-delta small-skill in the elite quadrant", () => {
    expect(classifyQuadrant(0.6, 1000)).toBe("elite");
  });

  it("puts high-delta heavy-skill in heavy-worth", () => {
    expect(classifyQuadrant(0.6, 3000)).toBe("heavy-worth");
  });

  it("puts low-delta heavy-skill in the action zone", () => {
    expect(classifyQuadrant(0.3, 3000)).toBe("action");
  });

  it("puts low-delta small-skill in marginal-cheap", () => {
    expect(classifyQuadrant(0.3, 1000)).toBe("marginal-cheap");
  });

  it("treats exactly-at-threshold as load-bearing / heavy", () => {
    expect(classifyQuadrant(0.5, 2000)).toBe("heavy-worth");
  });

  it("handles nulls as zero-delta, zero-cost (cheap & marginal)", () => {
    expect(classifyQuadrant(null, null)).toBe("marginal-cheap");
  });
});

describe("findHurtingScenarios (against demo-eval fixture)", () => {
  it("finds both negative-delta scenarios from today's run", () => {
    const report = loadDemo();
    const assets = loadSkillAssets(
      skillsDir,
      report.skills.map((s) => s.skill_name),
    );
    const hurting = findHurtingScenarios(report, assets);
    const ids = hurting.map((h) => `${h.skill}#${h.scenario.scenario_id}`);
    expect(ids).toEqual([
      "nemoclaw-user-reference#3",
      "nemoclaw-user-workspace#3",
    ]);
  });

  it("sorts most-negative first", () => {
    const report = loadDemo();
    const assets = loadSkillAssets(
      skillsDir,
      report.skills.map((s) => s.skill_name),
    );
    const hurting = findHurtingScenarios(report, assets);
    const deltas = hurting.map((h) => h.scenario.delta ?? 0);
    for (let i = 1; i < deltas.length; i += 1) {
      expect(deltas[i]).toBeGreaterThanOrEqual(deltas[i - 1]!);
    }
  });

  it("joins assertion text from evals.json onto failed grades", () => {
    const report = loadDemo();
    const assets = loadSkillAssets(
      skillsDir,
      report.skills.map((s) => s.skill_name),
    );
    const hurting = findHurtingScenarios(report, assets);
    const reference = hurting.find((h) => h.skill === "nemoclaw-user-reference");
    expect(reference).toBeDefined();
    expect(reference!.failed.length).toBeGreaterThan(0);
    for (const f of reference!.failed) {
      expect(f.assertion).not.toBe("(assertion text unavailable)");
      expect(f.assertion.length).toBeGreaterThan(10);
    }
  });
});

describe("findMarginalScenarios (against demo-eval fixture)", () => {
  it("finds the three marginal scenarios (0 < Δ ≤ 0.20)", () => {
    const report = loadDemo();
    const assets = loadSkillAssets(
      skillsDir,
      report.skills.map((s) => s.skill_name),
    );
    const marginal = findMarginalScenarios(report, assets);
    const ids = marginal.map((m) => `${m.skill}#${m.scenario.scenario_id}`).sort();
    expect(ids).toEqual([
      "nemoclaw-user-get-started#2",
      "nemoclaw-user-get-started#3",
      "nemoclaw-user-triage-instructions#2",
    ]);
  });

  it("excludes scenarios with delta > 0.20", () => {
    const report = loadDemo();
    const assets = loadSkillAssets(
      skillsDir,
      report.skills.map((s) => s.skill_name),
    );
    const marginal = findMarginalScenarios(report, assets);
    for (const m of marginal) {
      expect(m.scenario.delta).toBeGreaterThan(0);
      expect(m.scenario.delta).toBeLessThanOrEqual(0.2);
    }
  });
});

describe("findAssertionGaps (against demo-eval fixture)", () => {
  it("finds per-assertion gaps in otherwise-healthy scenarios", () => {
    const report = loadDemo();
    const assets = loadSkillAssets(
      skillsDir,
      report.skills.map((s) => s.skill_name),
    );
    const gaps = findAssertionGaps(report, assets);
    // Hand-written fixture cited these three gaps.
    const triples = gaps.map((g) => `${g.skill}#${g.scenario_id}#${g.assertion_id}`);
    expect(triples).toContain("nemoclaw-user-manage-policy#3#6");
    expect(triples).toContain("nemoclaw-user-agent-skills#2#6");
    expect(triples).toContain("nemoclaw-user-triage-instructions#3#5");
  });
});

describe("loadSkillAssets", () => {
  it("measures SKILL.md size in tokens using the 3.8-chars heuristic", () => {
    const assets = loadSkillAssets(skillsDir, ["nemoclaw-user-reference"]);
    const tokens = assets["nemoclaw-user-reference"]?.tokens;
    expect(tokens).not.toBeNull();
    expect(tokens!).toBeGreaterThan(300);
    expect(tokens!).toBeLessThan(500);
  });

  it("returns null tokens for a skill with no SKILL.md on disk", () => {
    const assets = loadSkillAssets(skillsDir, ["does-not-exist"]);
    expect(assets["does-not-exist"]?.tokens).toBeNull();
    expect(assets["does-not-exist"]?.assertions).toEqual([]);
  });

  it("indexes assertion text by [scenario-1][assertion-1]", () => {
    const assets = loadSkillAssets(skillsDir, ["nemoclaw-user-reference"]);
    const row = assets["nemoclaw-user-reference"]!.assertions[2]; // scenario 3
    expect(row).toBeDefined();
    expect(row!.length).toBeGreaterThan(0);
  });
});

describe("renderWeakestLinks (against demo-eval fixture)", () => {
  it("renders every hurting / marginal / gap finding", () => {
    const report = loadDemo();
    const assets = loadSkillAssets(
      skillsDir,
      report.skills.map((s) => s.skill_name),
    );
    const out = renderWeakestLinks(report, assets, "2026-04-21");

    // Headings
    expect(out).toContain("# NemoClaw Skills — Weakest Links");
    expect(out).toContain("## 1. Skill is *hurting* the agent");
    expect(out).toContain("## 2. Skill is barely earning its context budget");
    expect(out).toContain("## 3. Specific assertion gaps");

    // Specific findings
    expect(out).toContain("`nemoclaw-user-reference` — scenario 3");
    expect(out).toContain("`nemoclaw-user-workspace` — scenario 3");
    expect(out).toContain("`nemoclaw-user-get-started` — scenario 2");

    // Summary counts line up with the hand-written fixture.
    expect(out).toContain("Hurting scenarios (Δ < 0): **2**");
    expect(out).toContain("Marginal scenarios (0 < Δ ≤ 0.20): **3**");
    expect(out).toContain("Assertion-level gaps in healthy scenarios: **3**");
  });

  it("emits slot placeholders for every narrative section", () => {
    const report = loadDemo();
    const assets = loadSkillAssets(
      skillsDir,
      report.skills.map((s) => s.skill_name),
    );
    const out = renderWeakestLinks(report, assets, "2026-04-21");

    // Diagnosis slots — one per hurting scenario.
    expect(out).toContain(
      "<!-- slot: weakest-links.diagnosis skill=nemoclaw-user-reference scenario=3 -->",
    );
    expect(out).toContain(
      "<!-- slot: weakest-links.diagnosis skill=nemoclaw-user-workspace scenario=3 -->",
    );

    // Assertion-gap-fix slots for the three table rows.
    expect(out).toContain(
      "<!-- slot: weakest-links.assertion-gap-fix skill=nemoclaw-user-manage-policy scenario=3 assertion=6 -->",
    );
  });

  it("is deterministic across two calls with the same input", () => {
    const report = loadDemo();
    const assets = loadSkillAssets(
      skillsDir,
      report.skills.map((s) => s.skill_name),
    );
    const a = renderWeakestLinks(report, assets, "2026-04-21");
    const b = renderWeakestLinks(report, assets, "2026-04-21");
    expect(a).toBe(b);
  });
});

describe("renderValueVsCost (against demo-eval fixture)", () => {
  it("sorts the numbers table by efficiency descending", () => {
    const report = loadDemo();
    const assets = loadSkillAssets(
      skillsDir,
      report.skills.map((s) => s.skill_name),
    );
    const out = renderValueVsCost(report, assets, "2026-04-21");

    // `agent-skills` has the highest Δ per 1K tokens (~223 tokens, Δ +0.59 → 2.64 Δ/1K).
    const lines = out.split("\n");
    const tableStart = lines.findIndex((l) => l.startsWith("| `nemoclaw-user-"));
    expect(tableStart).toBeGreaterThan(0);
    expect(lines[tableStart]).toContain("nemoclaw-user-agent-skills");
  });

  it("places each skill into the expected cost quadrant", () => {
    const report = loadDemo();
    const assets = loadSkillAssets(
      skillsDir,
      report.skills.map((s) => s.skill_name),
    );
    const out = renderValueVsCost(report, assets, "2026-04-21");

    // Sanity-check the four quadrants. SKILL.md sizes are read live, so these
    // expectations track current on-disk sizes — update if a skill is rewritten.
    const eliteSection = sectionOf(out, "### Elite");
    expect(eliteSection).toContain("nemoclaw-user-monitor-sandbox");
    expect(eliteSection).toContain("nemoclaw-user-overview");
    expect(eliteSection).toContain("nemoclaw-user-manage-policy");

    const heavyWorth = sectionOf(out, "### Heavy but worth it");
    expect(heavyWorth).toContain("nemoclaw-user-deploy-remote");

    const actionZone = sectionOf(out, "### Action zone");
    expect(actionZone).toContain("nemoclaw-user-configure-inference");

    const marginalCheap = sectionOf(out, "### Marginal & cheap");
    expect(marginalCheap).toContain("nemoclaw-user-reference");
    expect(marginalCheap).toContain("nemoclaw-user-get-started");
    expect(marginalCheap).toContain("nemoclaw-user-workspace");
    expect(marginalCheap).toContain("nemoclaw-user-configure-security");
  });

  it("emits a slot for each quadrant commentary", () => {
    const report = loadDemo();
    const assets = loadSkillAssets(
      skillsDir,
      report.skills.map((s) => s.skill_name),
    );
    const out = renderValueVsCost(report, assets, "2026-04-21");
    expect(out).toContain(
      "<!-- slot: value-vs-cost.quadrant-commentary quadrant=elite -->",
    );
    expect(out).toContain(
      "<!-- slot: value-vs-cost.quadrant-commentary quadrant=heavy-worth -->",
    );
    expect(out).toContain(
      "<!-- slot: value-vs-cost.quadrant-commentary quadrant=marginal-cheap -->",
    );
    expect(out).toContain(
      "<!-- slot: value-vs-cost.quadrant-commentary quadrant=action -->",
    );
  });
});

/** Return a substring of `text` starting at a heading that starts with `headingPrefix`. */
function sectionOf(text: string, headingPrefix: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(headingPrefix));
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && l.startsWith("### "));
  const slice = end > start ? lines.slice(start, end) : lines.slice(start);
  return slice.join("\n");
}
