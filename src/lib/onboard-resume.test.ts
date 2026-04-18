// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
// Import from compiled dist/ so coverage is attributed correctly.
import { createSession } from "../../dist/lib/onboard-session";
import {
  buildResumeConflictLines,
  collectResumeConfigConflicts,
  detectResumeSandboxConflict,
} from "../../dist/lib/onboard-resume";

describe("onboard-resume", () => {
  it("detects sandbox conflicts only when requested and recorded names differ", () => {
    const session = createSession({ sandboxName: "alpha" });

    expect(detectResumeSandboxConflict(session, null)).toBeNull();
    expect(detectResumeSandboxConflict(session, "alpha")).toBeNull();
    expect(detectResumeSandboxConflict(session, "beta")).toEqual({
      requestedSandboxName: "beta",
      recordedSandboxName: "alpha",
    });
  });

  it("collects provider/model/from/agent resume conflicts", () => {
    const session = createSession({
      sandboxName: "alpha",
      provider: "nvidia-prod",
      model: "meta/llama-3.3-70b-instruct",
      agent: "hermes",
      metadata: { gatewayName: "nemoclaw", fromDockerfile: "/tmp/Recorded.Dockerfile" },
    });

    expect(
      collectResumeConfigConflicts(session, {
        requestedSandboxName: "beta",
        requestedProvider: "openai-api",
        requestedModel: "gpt-5.4",
        requestedFromDockerfile: "/tmp/Requested.Dockerfile",
        requestedAgent: "openclaw",
      }),
    ).toEqual([
      { field: "sandbox", requested: "beta", recorded: "alpha" },
      { field: "provider", requested: "openai-api", recorded: "nvidia-prod" },
      {
        field: "model",
        requested: "gpt-5.4",
        recorded: "meta/llama-3.3-70b-instruct",
      },
      {
        field: "fromDockerfile",
        requested: "/tmp/Requested.Dockerfile",
        recorded: "/tmp/Recorded.Dockerfile",
      },
      { field: "agent", requested: "openclaw", recorded: "hermes" },
    ]);
  });

  it("formats resume conflict guidance consistently", () => {
    const lines = buildResumeConflictLines([
      { field: "sandbox", requested: "beta", recorded: "alpha" },
      { field: "fromDockerfile", requested: null, recorded: "/tmp/Recorded.Dockerfile" },
      { field: "provider", requested: "openai-api", recorded: "nvidia-prod" },
    ]);

    expect(lines).toEqual([
      "  Resumable state belongs to sandbox 'alpha', not 'beta'.",
      "  Session was started with --from '/tmp/Recorded.Dockerfile'; rerun with that path to resume it.",
      "  Resumable state recorded provider 'nvidia-prod', not 'openai-api'.",
      "  Run: nemoclaw onboard              # start a fresh onboarding session",
      "  Or rerun with the original settings to continue that session.",
    ]);
  });

  it("tells users to resume without --from when the recorded session omitted it", () => {
    const lines = buildResumeConflictLines([
      { field: "fromDockerfile", requested: "/tmp/Requested.Dockerfile", recorded: null },
    ]);

    expect(lines).toEqual([
      "  Session was started without --from; rerun without --from to resume it.",
      "  Run: nemoclaw onboard              # start a fresh onboarding session",
      "  Or rerun with the original settings to continue that session.",
    ]);
  });
});
