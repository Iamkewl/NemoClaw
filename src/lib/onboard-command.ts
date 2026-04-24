// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface OnboardCommandOptions {
  nonInteractive: boolean;
  resume: boolean;
  recreateSandbox: boolean;
  fromDockerfile: string | null;
  acceptThirdPartySoftware: boolean;
  agent: string | null;
  dangerouslySkipPermissions: boolean;
  controlUiPort: number | null;
}

export interface RunOnboardCommandDeps {
  args: string[];
  noticeAcceptFlag: string;
  noticeAcceptEnv: string;
  env: NodeJS.ProcessEnv;
  runOnboard: (options: OnboardCommandOptions) => Promise<void>;
  listAgents?: () => string[];
  log?: (message?: string) => void;
  error?: (message?: string) => void;
  exit?: (code: number) => never;
}

export interface RunDeprecatedOnboardAliasCommandDeps extends RunOnboardCommandDeps {
  kind: "setup" | "setup-spark";
}

const ONBOARD_BASE_ARGS = [
  "--non-interactive",
  "--resume",
  "--recreate-sandbox",
  "--dangerously-skip-permissions",
];

function onboardUsageLines(noticeAcceptFlag: string): string[] {
  return [
    `  Usage: nemoclaw onboard [--non-interactive] [--resume] [--recreate-sandbox] [--from <Dockerfile>] [--agent <name>] [--control-ui-port <n>] [--dangerously-skip-permissions] [${noticeAcceptFlag}]`,
    "",
  ];
}

function printOnboardUsage(writer: (message?: string) => void, noticeAcceptFlag: string): void {
  for (const line of onboardUsageLines(noticeAcceptFlag)) {
    writer(line);
  }
}

export function parseOnboardArgs(
  args: string[],
  noticeAcceptFlag: string,
  noticeAcceptEnv: string,
  deps: Pick<RunOnboardCommandDeps, "env" | "error" | "exit" | "listAgents">,
): OnboardCommandOptions {
  const error = deps.error ?? console.error;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const parsedArgs = [...args];

  let fromDockerfile: string | null = null;
  const fromIdx = parsedArgs.indexOf("--from");
  if (fromIdx !== -1) {
    fromDockerfile = parsedArgs[fromIdx + 1] || null;
    if (!fromDockerfile || fromDockerfile.startsWith("--")) {
      error("  --from requires a path to a Dockerfile");
      printOnboardUsage(error, noticeAcceptFlag);
      exit(1);
    }
    parsedArgs.splice(fromIdx, 2);
  }

  let controlUiPort: number | null = null;
  const controlUiPortIdx = parsedArgs.indexOf("--control-ui-port");
  if (controlUiPortIdx !== -1) {
    const raw = parsedArgs[controlUiPortIdx + 1];
    if (typeof raw !== "string" || raw.startsWith("--")) {
      error("  --control-ui-port requires a port number");
      printOnboardUsage(error, noticeAcceptFlag);
      exit(1);
    }
    if (!/^\d+$/.test(raw)) {
      error(`  --control-ui-port '${raw}' must be an integer between 1024 and 65535`);
      exit(1);
    }
    const parsed = Number(raw);
    if (parsed < 1024 || parsed > 65535) {
      error(`  --control-ui-port '${raw}' must be an integer between 1024 and 65535`);
      exit(1);
    }
    controlUiPort = parsed;
    parsedArgs.splice(controlUiPortIdx, 2);
  }

  let agent: string | null = null;
  const agentIdx = parsedArgs.indexOf("--agent");
  if (agentIdx !== -1) {
    const agentValue = parsedArgs[agentIdx + 1];
    if (typeof agentValue !== "string" || agentValue.startsWith("--")) {
      error("  --agent requires a name");
      printOnboardUsage(error, noticeAcceptFlag);
      exit(1);
    }
    const knownAgents = deps.listAgents?.() ?? [];
    if (knownAgents.length > 0 && !knownAgents.includes(agentValue)) {
      error(`  Unknown agent '${agentValue}'. Available: ${knownAgents.join(", ")}`);
      printOnboardUsage(error, noticeAcceptFlag);
      exit(1);
    }
    agent = agentValue;
    parsedArgs.splice(agentIdx, 2);
  }

  const allowedArgs = new Set([...ONBOARD_BASE_ARGS, noticeAcceptFlag]);
  const unknownArgs = parsedArgs.filter((arg) => !allowedArgs.has(arg));
  if (unknownArgs.length > 0) {
    error(`  Unknown onboard option(s): ${unknownArgs.join(", ")}`);
    printOnboardUsage(error, noticeAcceptFlag);
    exit(1);
  }

  return {
    nonInteractive: parsedArgs.includes("--non-interactive"),
    resume: parsedArgs.includes("--resume"),
    recreateSandbox: parsedArgs.includes("--recreate-sandbox"),
    fromDockerfile,
    acceptThirdPartySoftware:
      parsedArgs.includes(noticeAcceptFlag) || String(deps.env[noticeAcceptEnv] || "") === "1",
    agent,
    dangerouslySkipPermissions: parsedArgs.includes("--dangerously-skip-permissions"),
    controlUiPort,
  };
}

export async function runOnboardCommand(deps: RunOnboardCommandDeps): Promise<void> {
  const log = deps.log ?? console.log;
  if (deps.args.includes("--help") || deps.args.includes("-h")) {
    printOnboardUsage(log, deps.noticeAcceptFlag);
    return;
  }

  const options = parseOnboardArgs(deps.args, deps.noticeAcceptFlag, deps.noticeAcceptEnv, deps);
  // --control-ui-port takes precedence over existing CHAT_UI_URL. The onboard
  // flow reads CHAT_UI_URL directly in many places, so setting it here is the
  // single seam that makes the flag effective without threading it through.
  if (options.controlUiPort !== null) {
    process.env.CHAT_UI_URL = `http://127.0.0.1:${options.controlUiPort}`;
  }
  await deps.runOnboard(options);
}

export async function runDeprecatedOnboardAliasCommand(
  deps: RunDeprecatedOnboardAliasCommandDeps,
): Promise<void> {
  const log = deps.log ?? console.log;
  log("");
  if (deps.kind === "setup") {
    log("  ⚠  `nemoclaw setup` is deprecated. Use `nemoclaw onboard` instead.");
  } else {
    log("  ⚠  `nemoclaw setup-spark` is deprecated.");
    log("  Current OpenShell releases handle the old DGX Spark cgroup issue themselves.");
    log("  Use `nemoclaw onboard` instead.");
  }
  log("");
  await runOnboardCommand(deps);
}
