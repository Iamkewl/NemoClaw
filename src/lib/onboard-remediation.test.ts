// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
// Import from compiled dist/ so coverage is attributed correctly.
import {
  getContainerRuntime,
  getFutureShellPathHint,
  getPortConflictServiceHints,
  printRemediationActions,
} from "../../dist/lib/onboard-remediation";

describe("onboard-remediation", () => {
  it("formats remediation steps for the operator", () => {
    const lines: string[] = [];
    printRemediationActions(
      [
        {
          title: "Install Docker",
          reason: "Docker is required.",
          commands: ["sudo apt-get install docker-ce", "nemoclaw onboard"],
        },
      ],
      (message = "") => lines.push(message),
    );

    expect(lines).toEqual([
      "",
      "  Suggested fix:",
      "",
      "  - Install Docker: Docker is required.",
      "    sudo apt-get install docker-ce",
      "    nemoclaw onboard",
    ]);
  });

  it("returns a future-shell PATH hint only when the bin dir is not already present", () => {
    expect(getFutureShellPathHint("/home/test/.local/bin", "/usr/local/bin:/usr/bin")).toBe(
      'export PATH="/home/test/.local/bin:$PATH"',
    );
    expect(
      getFutureShellPathHint(
        "/home/test/.local/bin",
        "/home/test/.local/bin:/usr/local/bin:/usr/bin",
      ),
    ).toBeNull();
  });

  it("renders platform-specific port conflict service hints", () => {
    expect(getPortConflictServiceHints("darwin", "/tmp/agent.plist").join("\n")).toContain(
      "launchctl unload /tmp/agent.plist",
    );
    expect(getPortConflictServiceHints("darwin", "/tmp/agent.plist").join("\n")).not.toContain(
      "systemctl --user",
    );
    expect(getPortConflictServiceHints("linux").join("\n")).toContain(
      "systemctl --user stop openclaw-gateway.service",
    );
  });

  it("derives the container runtime from docker info output", () => {
    const runCapture = vi.fn(() => "Docker Desktop 4.0");
    const inferContainerRuntime = vi.fn((info: string) => info.toLowerCase().includes("desktop") ? "docker-desktop" : "docker");
    expect(getContainerRuntime({ runCapture, inferContainerRuntime })).toBe("docker-desktop");
    expect(runCapture).toHaveBeenCalledWith("docker info 2>/dev/null", { ignoreError: true });
  });
});
