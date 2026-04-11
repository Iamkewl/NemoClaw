#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""
Swarm bridge relay — polls the bus and delivers messages to agents.

For OpenClaw agents, delivers via `openclaw agent -m <msg> --session-id swarm-<sender> --json`
and posts the reply back to the bus.

Runs inside the sandbox alongside the swarm bus.
"""

import argparse
import json
import os
import subprocess
import sys
import time
from urllib.request import urlopen, Request
from urllib.error import URLError

MANIFEST_PATH = "/sandbox/.nemoclaw/swarm/manifest.json"
RELAY_INSTANCE_ID = "swarm-relay"


def log(msg):
    print(f"[relay] {msg}", file=sys.stderr, flush=True)


def bus_get(bus_url, path):
    """GET a bus endpoint, return parsed JSON or None."""
    try:
        resp = urlopen(f"{bus_url}{path}", timeout=5)
        return json.loads(resp.read())
    except (URLError, OSError, json.JSONDecodeError, ValueError):
        return None


def bus_send(bus_url, from_id, to_id, content):
    """POST a message to the bus."""
    payload = json.dumps({"from": from_id, "to": to_id, "content": content}).encode()
    req = Request(
        f"{bus_url}/send",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        urlopen(req, timeout=10)
    except (URLError, OSError) as e:
        log(f"bus_send error: {e}")


def read_manifest():
    """Read the swarm manifest to discover agents."""
    try:
        with open(MANIFEST_PATH) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def find_text_in_response(data):
    """Recursively search for text content in the agent response."""
    if isinstance(data, dict):
        if "text" in data and isinstance(data["text"], str) and data["text"].strip():
            return data["text"].strip()
        for v in data.values():
            found = find_text_in_response(v)
            if found:
                return found
    elif isinstance(data, list):
        for item in data:
            found = find_text_in_response(item)
            if found:
                return found
    return None


def deliver_openclaw(agent, message, config_dir):
    """Deliver a message to an OpenClaw agent via its CLI (retries up to 3x)."""
    session_id = f"swarm-{message['from']}"
    env = dict(os.environ)
    if config_dir:
        env["OPENCLAW_STATE_DIR"] = config_dir
        config_file = os.path.join(config_dir, "openclaw.json")
        if os.path.exists(config_file):
            env["OPENCLAW_CONFIG_PATH"] = config_file

    cmd = [
        "openclaw", "agent",
        "--message", message["content"],
        "--session-id", session_id,
        "--json",
        "--timeout", "90",
    ]
    for attempt in range(3):
        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=95, env=env,
            )
            if result.returncode != 0:
                stderr = result.stderr.strip()[-200:] if result.stderr else ""
                log(f"attempt {attempt+1}: exit {result.returncode}: {stderr}")
                time.sleep(3)
                continue

            data = json.loads(result.stdout)
            text = find_text_in_response(data)
            if text:
                return text, None
            log(f"attempt {attempt+1}: no text, keys={list(data.keys())}, stdout={result.stdout[:300]}")
            time.sleep(3)

        except subprocess.TimeoutExpired:
            log(f"attempt {attempt+1}: timeout")
            continue
        except (json.JSONDecodeError, KeyError, IndexError) as e:
            log(f"attempt {attempt+1}: parse error: {e}")
            continue
        except FileNotFoundError:
            return None, "openclaw binary not found"

    return None, "no text after 3 attempts"


def deliver_hermes(agent, message):
    """Deliver a message to a Hermes agent via its OpenAI-compatible API."""
    port = agent.get("port", 8642)
    config_dir = agent.get("configDir", "")
    url = f"http://127.0.0.1:{port}/v1/chat/completions"

    # Read API key from the agent's .env file
    api_key = ""
    env_file = os.path.join(config_dir, ".env") if config_dir else ""
    if env_file and os.path.exists(env_file):
        for line in open(env_file):
            if line.startswith("API_SERVER_KEY="):
                api_key = line.strip().split("=", 1)[1]
                break

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    payload = json.dumps({
        "model": "default",
        "messages": [
            {"role": "system", "content": "You are in a multi-agent swarm. Respond concisely to the other agent."},
            {"role": "user", "content": f"[from: {message['from']}] {message['content']}"},
        ],
        "max_tokens": 512,
    }).encode()
    req = Request(
        url, data=payload,
        headers=headers,
        method="POST",
    )
    for attempt in range(3):
        try:
            resp = urlopen(req, timeout=90)
            data = json.loads(resp.read())
            text = find_text_in_response(data)
            if not text:
                choice = data.get("choices", [{}])[0]
                text = choice.get("message", {}).get("content", "")
            if text and text.strip():
                return text.strip(), None
            log(f"hermes attempt {attempt+1}: no text, keys={list(data.keys())}")
            time.sleep(3)
        except (URLError, OSError) as e:
            log(f"hermes attempt {attempt+1}: {e}")
            time.sleep(3)
        except (json.JSONDecodeError, KeyError, IndexError) as e:
            log(f"hermes attempt {attempt+1}: parse error: {e}")
            time.sleep(3)
    return None, "no text after 3 attempts"


def relay_loop(bus_url, poll_interval):
    """Main relay loop — poll bus, deliver to agents, post replies."""
    last_ts = ""
    manifest = None
    delivered = set()  # Track delivered message keys to avoid duplicates

    log(f"started (bus={bus_url}, poll={poll_interval}s)")

    while True:
        # Refresh manifest periodically
        manifest = read_manifest() or manifest

        if not manifest:
            time.sleep(poll_interval)
            continue

        # Build agent lookup
        agents = {a["instanceId"]: a for a in manifest.get("agents", [])}

        # Poll for new messages
        qs = f"?since={last_ts}" if last_ts else ""
        data = bus_get(bus_url, f"/messages{qs}")
        if not data:
            time.sleep(poll_interval)
            continue

        for msg in data.get("messages", []):
            # Skip relay's own messages
            if msg.get("from") == RELAY_INSTANCE_ID:
                continue

            # Skip messages without a specific target (broadcasts handled later)
            target = msg.get("to")
            if target is None:
                continue

            # Skip if target agent doesn't exist
            agent = agents.get(target)
            if not agent:
                continue

            ts = msg.get("timestamp", "")
            if ts > last_ts:
                last_ts = ts

            # Dedup: skip already-delivered messages
            msg_key = f"{msg.get('from')}:{ts}:{target}"
            if msg_key in delivered:
                continue
            delivered.add(msg_key)
            if len(delivered) > 1000:
                delivered = set(list(delivered)[-500:])

            agent_type = agent.get("agentType", "openclaw")
            config_dir = agent.get("configDir", "")

            log(f"delivering {msg['from']} -> {target} ({agent_type})")

            if agent_type == "openclaw":
                reply_text, error = deliver_openclaw(agent, msg, config_dir)
            elif agent_type == "hermes":
                reply_text, error = deliver_hermes(agent, msg)
            else:
                reply_text = None
                error = f"unsupported agent type: {agent_type}"

            if reply_text:
                bus_send(bus_url, target, msg["from"], reply_text)
                log(f"reply posted: {target} -> {msg['from']} ({len(reply_text)} chars)")
            elif error:
                bus_send(
                    bus_url, RELAY_INSTANCE_ID, msg["from"],
                    f"[relay] delivery to {target} failed: {error}",
                )
                log(f"delivery failed: {error}")

        # Update last_ts from all messages (even ones we skipped)
        for msg in data.get("messages", []):
            ts = msg.get("timestamp", "")
            if ts > last_ts:
                last_ts = ts

        time.sleep(poll_interval)


def main():
    parser = argparse.ArgumentParser(description="NemoClaw swarm bridge relay")
    parser.add_argument("--bus-url", default="http://127.0.0.1:19100")
    parser.add_argument("--poll-interval", type=float, default=2.0)
    args = parser.parse_args()

    relay_loop(args.bus_url, args.poll_interval)


if __name__ == "__main__":
    main()
