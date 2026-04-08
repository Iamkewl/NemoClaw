#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""
Generate Hermes config.yaml and .env from NemoClaw build-arg env vars.

Called at Docker image build time. Reads NEMOCLAW_* env vars and writes:
  ~/.hermes/config.yaml  — Hermes configuration (immutable at runtime)
  ~/.hermes/.env         — API keys and secrets (immutable at runtime)
"""

import base64
import json
import os
import secrets

import yaml


def main():
    model = os.environ["NEMOCLAW_MODEL"]
    base_url = os.environ["NEMOCLAW_INFERENCE_BASE_URL"]
    api_key = os.environ.get("NEMOCLAW_API_SERVER_KEY", "")

    msg_channels = json.loads(
        base64.b64decode(
            os.environ.get("NEMOCLAW_MESSAGING_CHANNELS_B64", "W10=") or "W10="
        ).decode("utf-8")
    )
    allowed_ids = json.loads(
        base64.b64decode(
            os.environ.get("NEMOCLAW_MESSAGING_ALLOWED_IDS_B64", "e30=") or "e30="
        ).decode("utf-8")
    )

    # Core config
    config = {
        "_config_version": 12,
        "model": {
            "default": model,
            "provider": "custom",
            "base_url": base_url,
        },
        "terminal": {
            "backend": "local",
            "timeout": 180,
        },
        "agent": {
            "max_turns": 60,
            "reasoning_effort": "medium",
        },
        "memory": {
            "memory_enabled": True,
            "user_profile_enabled": True,
        },
        "skills": {
            "creation_nudge_interval": 15,
        },
        "display": {
            "compact": False,
            "tool_progress": "all",
        },
    }

    # Messaging platforms
    token_env = {
        "telegram": "TELEGRAM_BOT_TOKEN",
        "discord": "DISCORD_BOT_TOKEN",
        "slack": "SLACK_BOT_TOKEN",
    }
    platforms_config = {}
    for ch in msg_channels:
        if ch in token_env:
            p_cfg = {
                "enabled": True,
                "token": f"openshell:resolve:env:{token_env[ch]}",
            }
            if ch in allowed_ids and allowed_ids[ch]:
                p_cfg["allowed_users"] = ",".join(
                    str(uid) for uid in allowed_ids[ch]
                )
            platforms_config[ch] = p_cfg

    if platforms_config:
        config["platforms"] = platforms_config

    # API server config
    api_server_key = api_key or secrets.token_hex(32)
    # Hermes binds to 127.0.0.1 regardless of host config (upstream bug).
    # Use an internal port (18642); the startup script's socat forwarder
    # exposes 0.0.0.0:8642 -> 127.0.0.1:18642 for OpenShell port forwarding.
    config.setdefault("platforms", {})["api_server"] = {
        "enabled": True,
        "extra": {
            "port": 18642,
            "host": "127.0.0.1",
            "key": api_server_key,
        },
    }

    # Write config.yaml
    config_path = os.path.expanduser("~/.hermes/config.yaml")
    with open(config_path, "w") as f:
        yaml.dump(config, f, default_flow_style=False, sort_keys=False)
    os.chmod(config_path, 0o600)

    # Write .env
    env_lines = [
        f"API_SERVER_KEY={api_server_key}",
        "API_SERVER_PORT=18642",
        "API_SERVER_HOST=127.0.0.1",
    ]
    for ch in msg_channels:
        if ch in token_env:
            env_lines.append(
                f"{token_env[ch]}=openshell:resolve:env:{token_env[ch]}"
            )

    env_path = os.path.expanduser("~/.hermes/.env")
    with open(env_path, "w") as f:
        f.write("\n".join(env_lines) + "\n")
    os.chmod(env_path, 0o600)

    print(f"[config] Wrote {config_path} (model={model}, provider=custom)")
    print(f"[config] Wrote {env_path} ({len(env_lines)} entries)")


if __name__ == "__main__":
    main()
