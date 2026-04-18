// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import type { WebSearchConfig } from "./web-search";

export const SANDBOX_BASE_IMAGE = "ghcr.io/nvidia/nemoclaw/sandbox-base";
export const SANDBOX_BASE_TAG = "latest";

export interface SandboxBaseImageDeps {
  run: (
    command: string | string[],
    opts?: { suppressOutput?: boolean },
  ) => { status: number; stdout?: string; stderr?: string };
  runCapture: (
    command: string | string[],
    opts?: { ignoreError?: boolean },
  ) => string;
}

export interface SandboxBuildConfigDeps {
  sandboxBaseImage: string;
}

function encodeDockerJsonArg(value: unknown): string {
  return Buffer.from(JSON.stringify(value || {}), "utf8").toString("base64");
}

/**
 * Pull sandbox-base:latest from GHCR and resolve its repo digest.
 * Returns { digest, ref } on success, or null when the pull or
 * inspect fails (offline, GHCR outage, local-only build).
 */
export function pullAndResolveBaseImageDigest(
  deps: SandboxBaseImageDeps,
): { digest: string; ref: string } | null {
  const imageWithTag = `${SANDBOX_BASE_IMAGE}:${SANDBOX_BASE_TAG}`;
  try {
    deps.run(["docker", "pull", imageWithTag], { suppressOutput: true });
  } catch {
    // Pull failed — caller should fall back to unpin :latest
    return null;
  }

  let inspectOutput;
  try {
    inspectOutput = deps.runCapture(
      ["docker", "inspect", "--format", "{{json .RepoDigests}}", imageWithTag],
      { ignoreError: false },
    );
  } catch {
    return null;
  }

  // RepoDigests is a JSON array like ["ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:abc..."].
  // Filter to the entry matching our registry — index ordering is not guaranteed.
  let repoDigests;
  try {
    repoDigests = JSON.parse(inspectOutput || "[]");
  } catch {
    return null;
  }
  const repoDigest = Array.isArray(repoDigests)
    ? repoDigests.find((entry) => entry.startsWith(`${SANDBOX_BASE_IMAGE}@sha256:`))
    : null;
  if (!repoDigest) return null;

  const digest = repoDigest.slice(repoDigest.indexOf("@") + 1);
  const ref = `${SANDBOX_BASE_IMAGE}@${digest}`;
  return { digest, ref };
}

export function getSandboxInferenceConfig(
  model: string,
  provider: string | null = null,
  preferredInferenceApi: string | null = null,
): {
  providerKey: string;
  primaryModelRef: string;
  inferenceBaseUrl: string;
  inferenceApi: string;
  inferenceCompat: { supportsStore: boolean } | null;
} {
  let providerKey;
  let primaryModelRef;
  let inferenceBaseUrl = "https://inference.local/v1";
  let inferenceApi = preferredInferenceApi || "openai-completions";
  let inferenceCompat = null;

  switch (provider) {
    case "openai-api":
      providerKey = "openai";
      primaryModelRef = `openai/${model}`;
      break;
    case "anthropic-prod":
    case "compatible-anthropic-endpoint":
      providerKey = "anthropic";
      primaryModelRef = `anthropic/${model}`;
      inferenceBaseUrl = "https://inference.local";
      inferenceApi = "anthropic-messages";
      break;
    case "gemini-api":
      providerKey = "inference";
      primaryModelRef = `inference/${model}`;
      inferenceCompat = {
        supportsStore: false,
      };
      break;
    case "compatible-endpoint":
      providerKey = "inference";
      primaryModelRef = `inference/${model}`;
      inferenceCompat = {
        supportsStore: false,
      };
      break;
    case "nvidia-prod":
    case "nvidia-nim":
    default:
      providerKey = "inference";
      primaryModelRef = `inference/${model}`;
      break;
  }

  return { providerKey, primaryModelRef, inferenceBaseUrl, inferenceApi, inferenceCompat };
}

export function patchStagedDockerfile(
  dockerfilePath: string,
  model: string,
  chatUiUrl: string,
  buildId = String(Date.now()),
  provider: string | null = null,
  preferredInferenceApi: string | null = null,
  webSearchConfig: WebSearchConfig | null = null,
  messagingChannels: string[] = [],
  messagingAllowedIds: Record<string, string[]> = {},
  discordGuilds: Record<string, { requireMention: boolean; users?: string[] }> = {},
  baseImageRef: string | null = null,
  deps: SandboxBuildConfigDeps,
): void {
  const { providerKey, primaryModelRef, inferenceBaseUrl, inferenceApi, inferenceCompat } =
    getSandboxInferenceConfig(model, provider, preferredInferenceApi);
  let dockerfile = fs.readFileSync(dockerfilePath, "utf8");
  // Pin the base image to a specific digest when available (#1904).
  // The ref must come from pullAndResolveBaseImageDigest() — never from
  // blueprint.yaml, whose digest belongs to a different registry.
  // Only rewrite when the current value already points at our sandbox-base
  // image — custom --from Dockerfiles may use a different base.
  if (baseImageRef) {
    dockerfile = dockerfile.replace(/^ARG BASE_IMAGE=(.*)$/m, (line, currentValue) => {
      const trimmed = String(currentValue).trim();
      if (
        trimmed.startsWith(`${deps.sandboxBaseImage}:`) ||
        trimmed.startsWith(`${deps.sandboxBaseImage}@`)
      ) {
        return `ARG BASE_IMAGE=${baseImageRef}`;
      }
      return line;
    });
  }
  dockerfile = dockerfile.replace(/^ARG NEMOCLAW_MODEL=.*$/m, `ARG NEMOCLAW_MODEL=${model}`);
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_PROVIDER_KEY=.*$/m,
    `ARG NEMOCLAW_PROVIDER_KEY=${providerKey}`,
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_PRIMARY_MODEL_REF=.*$/m,
    `ARG NEMOCLAW_PRIMARY_MODEL_REF=${primaryModelRef}`,
  );
  dockerfile = dockerfile.replace(/^ARG CHAT_UI_URL=.*$/m, `ARG CHAT_UI_URL=${chatUiUrl}`);
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_INFERENCE_BASE_URL=.*$/m,
    `ARG NEMOCLAW_INFERENCE_BASE_URL=${inferenceBaseUrl}`,
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_INFERENCE_API=.*$/m,
    `ARG NEMOCLAW_INFERENCE_API=${inferenceApi}`,
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_INFERENCE_COMPAT_B64=.*$/m,
    `ARG NEMOCLAW_INFERENCE_COMPAT_B64=${encodeDockerJsonArg(inferenceCompat)}`,
  );
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_BUILD_ID=.*$/m,
    `ARG NEMOCLAW_BUILD_ID=${buildId}`,
  );
  // Honor NEMOCLAW_CONTEXT_WINDOW / NEMOCLAW_MAX_TOKENS / NEMOCLAW_REASONING
  // so the user can tune model metadata without editing the Dockerfile.
  const POSITIVE_INT_RE = /^[1-9][0-9]*$/;
  const contextWindow = process.env.NEMOCLAW_CONTEXT_WINDOW;
  if (contextWindow && POSITIVE_INT_RE.test(contextWindow)) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_CONTEXT_WINDOW=.*$/m,
      `ARG NEMOCLAW_CONTEXT_WINDOW=${contextWindow}`,
    );
  }
  const maxTokens = process.env.NEMOCLAW_MAX_TOKENS;
  if (maxTokens && POSITIVE_INT_RE.test(maxTokens)) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_MAX_TOKENS=.*$/m,
      `ARG NEMOCLAW_MAX_TOKENS=${maxTokens}`,
    );
  }
  const reasoning = process.env.NEMOCLAW_REASONING;
  if (reasoning === "true" || reasoning === "false") {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_REASONING=.*$/m,
      `ARG NEMOCLAW_REASONING=${reasoning}`,
    );
  }
  // Honor NEMOCLAW_PROXY_HOST / NEMOCLAW_PROXY_PORT exported in the host
  // shell so the sandbox-side nemoclaw-start.sh sees them via $ENV at runtime.
  // Without this, the host export is silently dropped at image build time and
  // the sandbox falls back to the default 10.200.0.1:3128 proxy. See #1409.
  const PROXY_HOST_RE = /^[A-Za-z0-9._:-]+$/;
  const PROXY_PORT_RE = /^[0-9]{1,5}$/;
  const proxyHostEnv = process.env.NEMOCLAW_PROXY_HOST;
  if (proxyHostEnv && PROXY_HOST_RE.test(proxyHostEnv)) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_PROXY_HOST=.*$/m,
      `ARG NEMOCLAW_PROXY_HOST=${proxyHostEnv}`,
    );
  }
  const proxyPortEnv = process.env.NEMOCLAW_PROXY_PORT;
  if (proxyPortEnv && PROXY_PORT_RE.test(proxyPortEnv)) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_PROXY_PORT=.*$/m,
      `ARG NEMOCLAW_PROXY_PORT=${proxyPortEnv}`,
    );
  }
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_WEB_SEARCH_ENABLED=.*$/m,
    `ARG NEMOCLAW_WEB_SEARCH_ENABLED=${webSearchConfig ? "1" : "0"}`,
  );
  // Onboard flow expects immediate dashboard access without device pairing,
  // so disable device auth for images built during onboard (see #1217).
  dockerfile = dockerfile.replace(
    /^ARG NEMOCLAW_DISABLE_DEVICE_AUTH=.*$/m,
    `ARG NEMOCLAW_DISABLE_DEVICE_AUTH=1`,
  );
  if (messagingChannels.length > 0) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_MESSAGING_CHANNELS_B64=.*$/m,
      `ARG NEMOCLAW_MESSAGING_CHANNELS_B64=${encodeDockerJsonArg(messagingChannels)}`,
    );
  }
  if (Object.keys(messagingAllowedIds).length > 0) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_MESSAGING_ALLOWED_IDS_B64=.*$/m,
      `ARG NEMOCLAW_MESSAGING_ALLOWED_IDS_B64=${encodeDockerJsonArg(messagingAllowedIds)}`,
    );
  }
  if (Object.keys(discordGuilds).length > 0) {
    dockerfile = dockerfile.replace(
      /^ARG NEMOCLAW_DISCORD_GUILDS_B64=.*$/m,
      `ARG NEMOCLAW_DISCORD_GUILDS_B64=${encodeDockerJsonArg(discordGuilds)}`,
    );
  }
  fs.writeFileSync(dockerfilePath, dockerfile);
}
