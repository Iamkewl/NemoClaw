// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Import from compiled dist/ so coverage is attributed correctly.
import {
  buildAuthenticatedDashboardUrl,
  ensureDashboardForward,
  fetchGatewayAuthTokenFromSandbox,
  getDashboardAccessInfo,
  getDashboardForwardPort,
  getDashboardForwardStartCommand,
  getDashboardForwardTarget,
  getDashboardGuidanceLines,
  getWslHostAddress,
} from "../../dist/lib/onboard-dashboard";

const originalEnv = process.env.CHAT_UI_URL;

beforeEach(() => {
  delete process.env.CHAT_UI_URL;
});

afterEach(() => {
  if (originalEnv !== undefined) {
    process.env.CHAT_UI_URL = originalEnv;
  } else {
    delete process.env.CHAT_UI_URL;
  }
});

describe("onboard-dashboard", () => {
  it("fetches a gateway auth token from a downloaded sandbox config", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dashboard-token-"));
    const sandboxDir = path.join(tmpRoot, "nested", "sandbox");
    fs.mkdirSync(sandboxDir, { recursive: true });
    fs.writeFileSync(
      path.join(sandboxDir, "openclaw.json"),
      JSON.stringify({ gateway: { auth: { token: "secret-token" } } }),
    );
    const runOpenshell = vi.fn((_args, _opts) => {
      const destDir = _args[4];
      fs.cpSync(tmpRoot, destDir, { recursive: true });
      return { status: 0 };
    });
    try {
      expect(fetchGatewayAuthTokenFromSandbox("alpha", { runOpenshell })).toBe("secret-token");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("derives dashboard forward info and authenticated URLs", () => {
    expect(getDashboardForwardPort("http://127.0.0.1:19999")).toBe("19999");
    expect(getDashboardForwardTarget("http://127.0.0.1:19999", { isWsl: false })).toBe(
      "19999",
    );
    expect(getDashboardForwardTarget("http://127.0.0.1:19999", { isWsl: true })).toBe(
      "0.0.0.0:19999",
    );
    expect(buildAuthenticatedDashboardUrl("http://127.0.0.1:19999/", "secret-token")).toBe(
      "http://127.0.0.1:19999/#token=secret-token",
    );
  });

  it("builds dashboard access info and WSL guidance", () => {
    const access = getDashboardAccessInfo("the-crucible", {
      token: "secret-token",
      chatUiUrl: "http://127.0.0.1:19999",
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      platform: "linux",
      release: "6.6.87.2-microsoft-standard-WSL2",
      runCapture: (command) => (command.includes("hostname -I") ? "172.24.240.1\n" : ""),
    });

    expect(access).toEqual([
      { label: "Dashboard", url: "http://127.0.0.1:19999/#token=secret-token" },
      { label: "VS Code/WSL", url: "http://172.24.240.1:19999/#token=secret-token" },
    ]);
    expect(
      getDashboardGuidanceLines(access, {
        chatUiUrl: "http://127.0.0.1:19999",
        env: { WSL_DISTRO_NAME: "Ubuntu" },
        platform: "linux",
        release: "6.6.87.2-microsoft-standard-WSL2",
      }),
    ).toEqual([
      "Port 19999 must be forwarded before opening these URLs.",
      "WSL detected: if localhost fails in Windows, use the WSL host IP shown by `hostname -I`.",
    ]);
  });

  it("builds dashboard forward start commands with the correct target", () => {
    const command = getDashboardForwardStartCommand("the-crucible", {
      chatUiUrl: "http://127.0.0.1:19999",
      openshellBinary: "/usr/bin/openshell",
      isWsl: false,
      openshellShellCommand: (args, options = {}) => {
        const binary = options.openshellBinary || "openshell";
        return [binary, ...args].join(" ");
      },
    });

    expect(command).toContain("forward start --background 19999 the-crucible");
  });

  it("restores the dashboard forward and warns when the background forward start fails", () => {
    const warnings: string[] = [];
    const calls: string[] = [];
    ensureDashboardForward("the-crucible", {
      chatUiUrl: "https://chat.example.com",
      runOpenshell: (args) => {
        calls.push(args.join(" "));
        return args.includes("start") ? { status: 1 } : { status: 0 };
      },
      warningWriter: (message = "") => warnings.push(message),
    });

    expect(calls).toEqual([
      "forward stop 18789",
      "forward start --background 0.0.0.0:18789 the-crucible",
    ]);
    expect(warnings).toEqual([
      "! Port 18789 forward did not start — port may be in use by another process.",
      "  Check: docker ps --format 'table {{.Names}}\\t{{.Ports}}' | grep 18789",
      "  Free the port, then reconnect: nemoclaw the-crucible connect",
    ]);
  });

  it("returns null for WSL host lookups outside WSL", () => {
    expect(getWslHostAddress({ isWsl: false })).toBeNull();
  });
});
