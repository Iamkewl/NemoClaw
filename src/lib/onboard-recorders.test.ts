// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const recordersDistPath = require.resolve("../../dist/lib/onboard-recorders");
const driverDistPath = require.resolve("../../dist/lib/onboard-persistent-driver");
const sessionDistPath = require.resolve("../../dist/lib/onboard-session");
const distModulePaths = [recordersDistPath, driverDistPath, sessionDistPath] as const;
const originalHome = process.env.HOME;
let tmpDir: string;

const clearDistModuleCache = () => {
  for (const modulePath of distModulePaths) {
    delete require.cache[modulePath];
  }
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-recorders-"));
  process.env.HOME = tmpDir;
  clearDistModuleCache();
});

afterEach(() => {
  clearDistModuleCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

describe("createTrackedOnboardRun", () => {
  it("keeps the caller's session reference in sync with persisted driver updates", () => {
    const onboardSession = require("../../dist/lib/onboard-session");
    const { PersistentOnboardDriver } = require("../../dist/lib/onboard-persistent-driver");
    const { createTrackedOnboardRun } = require("../../dist/lib/onboard-recorders");

    const initialSession = onboardSession.saveSession(
      onboardSession.createSession({ sandboxName: "alpha" }),
    );
    const driver = new PersistentOnboardDriver({ resume: true, requestedSandboxName: "alpha" });
    const trackedRun = createTrackedOnboardRun(driver, initialSession);

    trackedRun.startStep("preflight");
    expect(trackedRun.session.lastStepStarted).toBe("preflight");

    trackedRun.completeStep("preflight");
    trackedRun.completeStep("gateway");
    trackedRun.completeStep("provider_selection", {
      provider: "openai-api",
      model: "gpt-5.4",
    });
    trackedRun.completeStep("inference", {
      provider: "openai-api",
      model: "gpt-5.4",
    });
    trackedRun.completeStep("messaging", {
      messagingChannels: ["telegram"],
    });

    expect(trackedRun.session.steps.messaging.status).toBe("complete");
    expect(trackedRun.session.messagingChannels).toEqual(["telegram"]);
    expect(driver.requiredSession.messagingChannels).toEqual(["telegram"]);
  });
});
