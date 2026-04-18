// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "./onboard-session";
import { collectResumeConfigConflicts, detectResumeSandboxConflict } from "./onboard-resume";

const NON_INTERACTIVE_PROVIDER_ALIASES = {
  cloud: "build",
  nim: "nim-local",
  vllm: "vllm",
  anthropiccompatible: "anthropicCompatible",
} as const;

const VALID_NON_INTERACTIVE_PROVIDERS = new Set([
  "build",
  "openai",
  "anthropic",
  "anthropicCompatible",
  "gemini",
  "ollama",
  "custom",
  "nim-local",
  "vllm",
]);

export interface NonInteractiveRequestDeps {
  env?: NodeJS.ProcessEnv;
  error?: (message?: string) => void;
  exit?: (code: number) => never;
  isSafeModelId?: (value: string) => boolean;
}

export function getRequestedSandboxNameHint(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.NEMOCLAW_SANDBOX_NAME;
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  return normalized || null;
}

export function getNonInteractiveProvider(
  deps: NonInteractiveRequestDeps = {},
): string | null {
  const env = deps.env ?? process.env;
  const error = deps.error ?? console.error;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const providerKey = String(env.NEMOCLAW_PROVIDER || "").trim().toLowerCase();
  if (!providerKey) return null;

  const normalized =
    NON_INTERACTIVE_PROVIDER_ALIASES[
      providerKey as keyof typeof NON_INTERACTIVE_PROVIDER_ALIASES
    ] ?? providerKey;
  if (!VALID_NON_INTERACTIVE_PROVIDERS.has(normalized)) {
    error(`  Unsupported NEMOCLAW_PROVIDER: ${providerKey}`);
    error(
      "  Valid values: build, openai, anthropic, anthropicCompatible, gemini, ollama, custom, nim-local, vllm",
    );
    exit(1);
  }

  return normalized;
}

export function getNonInteractiveModel(
  providerKey: string,
  deps: NonInteractiveRequestDeps = {},
): string | null {
  const env = deps.env ?? process.env;
  const error = deps.error ?? console.error;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const isSafeModelId = deps.isSafeModelId ?? (() => true);
  const model = String(env.NEMOCLAW_MODEL || "").trim();
  if (!model) return null;
  if (!isSafeModelId(model)) {
    error(`  Invalid NEMOCLAW_MODEL for provider '${providerKey}': ${model}`);
    error("  Model values may only contain letters, numbers, '.', '_', ':', '/', and '-'.");
    exit(1);
  }
  return model;
}

export function getRequestedProviderHint(
  nonInteractive: boolean,
  deps: NonInteractiveRequestDeps = {},
): string | null {
  return nonInteractive ? getNonInteractiveProvider(deps) : null;
}

export function getRequestedModelHint(
  nonInteractive: boolean,
  deps: NonInteractiveRequestDeps = {},
): string | null {
  if (!nonInteractive) return null;
  const providerKey = getRequestedProviderHint(nonInteractive, deps) || "cloud";
  return getNonInteractiveModel(providerKey, deps);
}

export function getEffectiveProviderName(
  providerKey: string | null,
  remoteProviderConfig: Record<string, { providerName: string }>,
): string | null {
  if (!providerKey) return null;
  if (remoteProviderConfig[providerKey]) {
    return remoteProviderConfig[providerKey].providerName;
  }

  switch (providerKey) {
    case "nim-local":
      return "nvidia-nim";
    case "ollama":
      return "ollama-local";
    case "vllm":
      return "vllm-local";
    default:
      return providerKey;
  }
}

export function getResumeSandboxConflict(
  session: Pick<Session, "sandboxName"> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
) {
  return detectResumeSandboxConflict(session, getRequestedSandboxNameHint(env));
}

export function getResumeConfigConflicts(
  session: Session | null | undefined,
  opts: {
    nonInteractive: boolean;
    fromDockerfile?: string | null;
    agent?: string | null;
    env?: NodeJS.ProcessEnv;
    error?: (message?: string) => void;
    exit?: (code: number) => never;
    isSafeModelId?: (value: string) => boolean;
    remoteProviderConfig: Record<string, { providerName: string }>;
  },
) {
  const env = opts.env ?? process.env;
  const deps: NonInteractiveRequestDeps = {
    env,
    error: opts.error,
    exit: opts.exit,
    isSafeModelId: opts.isSafeModelId,
  };
  const requestedProvider = getRequestedProviderHint(opts.nonInteractive, deps);
  return collectResumeConfigConflicts(session, {
    requestedSandboxName: getRequestedSandboxNameHint(env),
    requestedProvider: getEffectiveProviderName(requestedProvider, opts.remoteProviderConfig),
    requestedModel: getRequestedModelHint(opts.nonInteractive, deps),
    requestedFromDockerfile: opts.fromDockerfile || null,
    requestedAgent: opts.agent || env.NEMOCLAW_AGENT || null,
  });
}
