// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

export function createOnboardImageConfigHelpers(deps) {
  const { encodeDockerJsonArg, getCredential, webSearch } = deps;

  function getSandboxInferenceConfig(model, provider = null, preferredInferenceApi = null) {
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

  function patchStagedDockerfile(
    dockerfilePath,
    model,
    chatUiUrl,
    buildId = String(Date.now()),
    provider = null,
    preferredInferenceApi = null,
    webSearchConfig = null,
    messagingChannels = [],
    messagingAllowedIds = {},
    discordGuilds = {},
  ) {
    const { providerKey, primaryModelRef, inferenceBaseUrl, inferenceApi, inferenceCompat } =
      getSandboxInferenceConfig(model, provider, preferredInferenceApi);
    let dockerfile = fs.readFileSync(dockerfilePath, "utf8");
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
      /^ARG NEMOCLAW_WEB_CONFIG_B64=.*$/m,
      `ARG NEMOCLAW_WEB_CONFIG_B64=${webSearch.buildWebSearchDockerConfig(
        webSearchConfig,
        webSearchConfig ? getCredential(webSearch.BRAVE_API_KEY_ENV) : null,
      )}`,
    );
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

  return {
    getSandboxInferenceConfig,
    patchStagedDockerfile,
  };
}
