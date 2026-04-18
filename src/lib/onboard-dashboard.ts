// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildControlUiUrls, resolveDashboardForwardTarget } from "./dashboard";
import { DASHBOARD_PORT } from "./ports";
import { isWsl } from "./platform";

const CONTROL_UI_PORT = DASHBOARD_PORT;

function findOpenclawJsonPath(dir: string): string | null {
  const directPath = path.join(dir, ".openclaw", "openclaw.json");
  if (fs.existsSync(directPath)) return directPath;
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findOpenclawJsonPath(filePath);
      if (found) return found;
    } else if (entry.name === "openclaw.json") {
      return filePath;
    }
  }
  return null;
}

export interface FetchGatewayAuthTokenDeps {
  runOpenshell: (
    args: string[],
    opts?: { ignoreError?: boolean; stdio?: [string, string, string] },
  ) => { status: number };
}

/**
 * Pull gateway.auth.token from the sandbox image via openshell sandbox download
 * so onboard can print copy-paste Control UI URLs with #token=.
 */
export function fetchGatewayAuthTokenFromSandbox(
  sandboxName: string,
  deps: FetchGatewayAuthTokenDeps,
): string | null {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-token-"));
  try {
    const destDir = `${tmpDir}${path.sep}`;
    const result = deps.runOpenshell(
      ["sandbox", "download", sandboxName, "/sandbox/.openclaw/openclaw.json", destDir],
      { ignoreError: true, stdio: ["ignore", "ignore", "ignore"] },
    );
    if (result.status !== 0) return null;
    const jsonPath = findOpenclawJsonPath(tmpDir);
    if (!jsonPath) return null;
    const cfg = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    const token = cfg && cfg.gateway && cfg.gateway.auth && cfg.gateway.auth.token;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

export function getDashboardForwardPort(
  chatUiUrl = process.env.CHAT_UI_URL || `http://127.0.0.1:${CONTROL_UI_PORT}`,
): string {
  const forwardTarget = resolveDashboardForwardTarget(chatUiUrl);
  return forwardTarget.includes(":")
    ? (forwardTarget.split(":").pop() ?? String(CONTROL_UI_PORT))
    : forwardTarget;
}

export function getDashboardForwardTarget(
  chatUiUrl = process.env.CHAT_UI_URL || `http://127.0.0.1:${CONTROL_UI_PORT}`,
  options: { isWsl?: boolean; platform?: NodeJS.Platform; release?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const port = getDashboardForwardPort(chatUiUrl);
  return isWsl(options) ? `0.0.0.0:${port}` : resolveDashboardForwardTarget(chatUiUrl);
}

export function getDashboardForwardStartCommand(
  sandboxName: string,
  options: {
    chatUiUrl?: string;
    openshellBinary?: string;
    isWsl?: boolean;
    platform?: NodeJS.Platform;
    release?: string;
    env?: NodeJS.ProcessEnv;
    openshellShellCommand: (args: string[], options?: { openshellBinary?: string }) => string;
  },
): string {
  const chatUiUrl =
    options.chatUiUrl || process.env.CHAT_UI_URL || `http://127.0.0.1:${CONTROL_UI_PORT}`;
  const forwardTarget = getDashboardForwardTarget(chatUiUrl, options);
  return `${options.openshellShellCommand(
    ["forward", "start", "--background", forwardTarget, sandboxName],
    options,
  )}`;
}

export function buildAuthenticatedDashboardUrl(baseUrl: string, token: string | null = null): string {
  if (!token) return baseUrl;
  return `${baseUrl}#token=${encodeURIComponent(token)}`;
}

export function getWslHostAddress(
  options: {
    wslHostAddress?: string;
    isWsl?: boolean;
    platform?: NodeJS.Platform;
    release?: string;
    env?: NodeJS.ProcessEnv;
    runCapture?: (command: string, options?: { ignoreError?: boolean }) => string;
  } = {},
): string | null {
  if (options.wslHostAddress) {
    return options.wslHostAddress;
  }
  if (!isWsl(options)) {
    return null;
  }
  const runCaptureFn = options.runCapture ?? (() => "");
  const output = runCaptureFn("hostname -I 2>/dev/null", { ignoreError: true });
  const candidates = String(output || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return candidates[0] || null;
}

export interface DashboardAccessInfo {
  label: string;
  url: string;
}

export function getDashboardAccessInfo(
  sandboxName: string,
  options: {
    token?: string | null;
    chatUiUrl?: string;
    wslHostAddress?: string;
    isWsl?: boolean;
    platform?: NodeJS.Platform;
    release?: string;
    env?: NodeJS.ProcessEnv;
    runCapture?: (command: string, options?: { ignoreError?: boolean }) => string;
    fetchToken?: (sandboxName: string) => string | null;
  } = {},
): DashboardAccessInfo[] {
  const token = Object.prototype.hasOwnProperty.call(options, "token")
    ? (options.token ?? null)
    : options.fetchToken?.(sandboxName) ?? null;
  const chatUiUrl =
    options.chatUiUrl || process.env.CHAT_UI_URL || `http://127.0.0.1:${CONTROL_UI_PORT}`;
  const dashboardPort = Number(getDashboardForwardPort(chatUiUrl));
  const dashboardAccess = buildControlUiUrls(token, dashboardPort, chatUiUrl).map((url, index) => ({
    label: index === 0 ? "Dashboard" : `Alt ${index}`,
    url: buildAuthenticatedDashboardUrl(url, null),
  }));

  const wslHostAddress = getWslHostAddress(options);
  if (wslHostAddress) {
    const wslUrl = buildAuthenticatedDashboardUrl(
      `http://${wslHostAddress}:${dashboardPort}/`,
      token,
    );
    if (!dashboardAccess.some((access) => access.url === wslUrl)) {
      dashboardAccess.push({ label: "VS Code/WSL", url: wslUrl });
    }
  }

  return dashboardAccess;
}

export function getDashboardGuidanceLines(
  dashboardAccess: DashboardAccessInfo[] = [],
  options: {
    chatUiUrl?: string;
    isWsl?: boolean;
    platform?: NodeJS.Platform;
    release?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): string[] {
  const dashboardPort = getDashboardForwardPort(
    options.chatUiUrl || process.env.CHAT_UI_URL || `http://127.0.0.1:${CONTROL_UI_PORT}`,
  );
  const guidance = [`Port ${dashboardPort} must be forwarded before opening these URLs.`];
  if (isWsl(options)) {
    guidance.push(
      "WSL detected: if localhost fails in Windows, use the WSL host IP shown by `hostname -I`.",
    );
  }
  if (dashboardAccess.length === 0) {
    guidance.push("No dashboard URLs were generated.");
  }
  return guidance;
}

export function ensureDashboardForward(
  sandboxName: string,
  deps: {
    chatUiUrl?: string;
    runOpenshell: (
      args: string[],
      opts?: { ignoreError?: boolean; stdio?: [string, string, string] },
    ) => { status: number };
    warningWriter?: (message?: string) => void;
  },
): void {
  const chatUiUrl =
    deps.chatUiUrl || process.env.CHAT_UI_URL || `http://127.0.0.1:${CONTROL_UI_PORT}`;
  const portToStop = getDashboardForwardPort(chatUiUrl);
  const forwardTarget = getDashboardForwardTarget(chatUiUrl);
  deps.runOpenshell(["forward", "stop", portToStop], { ignoreError: true });
  const fwdResult = deps.runOpenshell(
    ["forward", "start", "--background", forwardTarget, sandboxName],
    { ignoreError: true, stdio: ["ignore", "ignore", "ignore"] },
  );
  if (fwdResult && fwdResult.status !== 0) {
    const warn = deps.warningWriter ?? console.warn;
    warn(`! Port ${portToStop} forward did not start — port may be in use by another process.`);
    warn(`  Check: docker ps --format 'table {{.Names}}\\t{{.Ports}}' | grep ${portToStop}`);
    warn(`  Free the port, then reconnect: nemoclaw ${sandboxName} connect`);
  }
}
