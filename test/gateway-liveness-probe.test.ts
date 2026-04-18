// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Verify that onboarding probes the gateway Docker container before trusting
// "healthy" metadata from the openshell CLI. Without this, a stale local
// state file causes step 2 to skip gateway startup even when the container
// has been removed, leading to "Connection refused" in step 4.
//
// See: https://github.com/NVIDIA/NemoClaw/issues/2020

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

describe("gateway liveness probe (#2020)", () => {
  const content = fs.readFileSync(path.join(ROOT, "src/lib/onboard.ts"), "utf-8");
  const depsContent = fs.readFileSync(
    path.join(ROOT, "src/lib/onboard-orchestrator-deps.ts"),
    "utf-8",
  );
  const helperContent = fs.readFileSync(
    path.join(ROOT, "src/lib/onboard-host-flow.ts"),
    "utf-8",
  );

  it("verifyGatewayContainerRunning() helper exists and checks Docker state", () => {
    expect(content).toContain("function verifyGatewayContainerRunning()");
    // Must use docker inspect to probe container state
    expect(content).toContain("docker inspect --type container");
    // Must check .State.Running, not just container existence
    expect(content).toContain("{{.State.Running}}");
  });

  it("preflight probes the container when gatewayReuseState is 'healthy'", () => {
    // The preflight section must call the probe before entering the port loop.
    // Find the first gatewayReuseState assignment and the port loop.
    const preflightProbe = content.match(
      /let gatewayReuseState = getGatewayReuseState[\s\S]*?verifyGatewayContainerRunning\(\)[\s\S]*?gatewayReuseState = "missing"/,
    );
    expect(preflightProbe).toBeTruthy();
  });

  it("main onboard flow delegates the probe to the extracted host preparation helper", () => {
    expect(depsContent).toContain("run: runHostPreparationFlow");
    const mainFlowProbe = helperContent.match(
      /let gatewayReuseState = deps\.getGatewayReuseState[\s\S]*?deps\.verifyGatewayContainerRunning\(\)[\s\S]*?const canReuseHealthyGateway/,
    );
    expect(mainFlowProbe).toBeTruthy();
  });

  it("returns tri-state: running, missing, or unknown", () => {
    // The helper must distinguish container-removed from Docker-unavailable
    expect(content).toContain('return "running"');
    expect(content).toContain('return "missing"');
    expect(content).toContain('return "unknown"');
  });

  it("only downgrades to 'missing' when container is confirmed missing", () => {
    // Both probe sites must check containerState === "missing" before cleanup.
    const preflightDowngrades = content.match(/containerState === "missing"/g) ?? [];
    const helperDowngrades = helperContent.match(/containerState === "missing"/g) ?? [];
    expect(preflightDowngrades.length).toBeGreaterThanOrEqual(1);
    expect(helperDowngrades.length).toBeGreaterThanOrEqual(1);
  });

  it("cleans up stale metadata when container is confirmed missing", () => {
    // After detecting a removed container, the code must clean up forwarding
    // and destroy the gateway via the shared destroyGateway() helper.
    const cleanupAfterProbe = helperContent.match(
      /containerState === "missing"[\s\S]*?stopDashboardForward\(\)[\s\S]*?destroyGateway\(\)/,
    );
    expect(cleanupAfterProbe).toBeTruthy();
  });

  it("does not modify isGatewayHealthy() in gateway-state.ts", () => {
    // isGatewayHealthy() must remain a pure function — no I/O.
    // Scope the check to the function body so unrelated helpers don't cause false failures.
    const gsContent = fs.readFileSync(
      path.join(ROOT, "src/lib/gateway-state.ts"),
      "utf-8",
    );
    const fnMatch = gsContent.match(
      /(?:function isGatewayHealthy|const isGatewayHealthy\b)[\s\S]*?\n\}/,
    );
    expect(fnMatch).toBeTruthy();
    const fnBody = fnMatch[0];
    expect(fnBody).not.toContain("docker");
    expect(fnBody).not.toContain("spawn");
    expect(fnBody).not.toContain("exec");
  });
});
