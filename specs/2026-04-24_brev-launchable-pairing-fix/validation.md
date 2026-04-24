# Validation Plan: Brev Launchable Pairing Fix

Generated from: specs/2026-04-24_brev-launchable-pairing-fix/spec.md
Test Spec: specs/2026-04-24_brev-launchable-pairing-fix/tests.md

## Overview
**Feature**: Extract inline Dockerfile Python config generation to a standalone script;
auto-disable device auth for non-loopback URLs (fixes #2341).

**Available Tools**: vitest, python3, bash (file verification), spawnSync

## Coverage Summary
- Happy Paths: 7 scenarios
- Sad Paths: 3 scenarios
- Total: 10 scenarios

---

## Phase 1: Extract Inline Python to `scripts/generate-openclaw-config.py`

### Scenario 1.1: Config script generates identical output to inline Python [VALIDATED: 1dbfc563]
**Type**: Happy Path

**Given**: The `scripts/generate-openclaw-config.py` script exists and is executable
**When**: The script is invoked with the same env vars the Dockerfile inline block uses
**Then**: The generated `openclaw.json` contains all expected keys: gateway (auth, allowedOrigins), model config, agent config

**Validation Steps**:
1. **Setup**: Bash: Verify `scripts/generate-openclaw-config.py` exists
2. **Execute**: Bash: Run `python3 scripts/generate-openclaw-config.py` with BASE_ENV in a temp HOME
3. **Verify**: Bash: Parse generated `openclaw.json`, assert keys: `gateway.controlUi.dangerouslyDisableDeviceAuth`, `gateway.controlUi.allowInsecureAuth`, `gateway.controlUi.allowedOrigins`, `gateway.auth.token`

**Tools Required**: python3, bash, jq

### Scenario 1.2: Dockerfile uses COPY + RUN instead of inline python3 -c [VALIDATED: 1dbfc563]
**Type**: Happy Path

**Given**: The Dockerfile has been modified to reference the extracted script
**When**: The Dockerfile is scanned for config generation patterns
**Then**: `COPY scripts/generate-openclaw-config.py` and `RUN python3 /usr/local/lib/nemoclaw/generate-openclaw-config.py` are present; no `python3 -c` block for config generation remains

**Validation Steps**:
1. **Execute**: Bash: `grep -n "COPY.*generate-openclaw-config.py" Dockerfile`
2. **Execute**: Bash: `grep -n "RUN python3 /usr/local/lib/nemoclaw/generate-openclaw-config.py" Dockerfile`
3. **Verify**: Bash: Count `python3 -c` blocks — none should contain config generation logic (68-line block is gone)

**Tools Required**: bash, grep

### Scenario 1.3: C-2 security regression tests pass with updated patterns [VALIDATED: 1dbfc563]
**Type**: Happy Path

**Given**: `test/security-c2-dockerfile-injection.test.ts` has been updated for the extraction
**When**: `npx vitest run test/security-c2-dockerfile-injection.test.ts`
**Then**: All tests pass — PoC tests still verify vulnerable/fixed patterns, Dockerfile regression guards updated for script COPY/RUN

**Validation Steps**:
1. **Execute**: Bash: `npx vitest run test/security-c2-dockerfile-injection.test.ts`
2. **Verify**: Exit code 0, all tests pass

**Tools Required**: vitest

### Scenario 1.4: New functional tests validate all config derivation paths [VALIDATED: 1dbfc563]
**Type**: Happy Path

**Given**: `test/generate-openclaw-config.test.ts` exists with ≥10 tests
**When**: `npx vitest run test/generate-openclaw-config.test.ts`
**Then**: All tests pass — covers loopback, HTTPS, non-loopback, device auth, channels, web search, timeout, token clearing, file permissions

**Validation Steps**:
1. **Execute**: Bash: `npx vitest run test/generate-openclaw-config.test.ts`
2. **Verify**: Exit code 0, ≥10 test cases pass
3. **Verify**: Bash: `grep -c 'it(' test/generate-openclaw-config.test.ts` shows ≥10

**Tools Required**: vitest

### Scenario 1.5: --clear-token flag clears only the token [VALIDATED: 1dbfc563]
**Type**: Happy Path

**Given**: A `openclaw.json` exists with a non-empty `gateway.auth.token`
**When**: `python3 scripts/generate-openclaw-config.py --clear-token` is run
**Then**: `gateway.auth.token` is `""` but all other fields are preserved

**Validation Steps**:
1. **Setup**: Bash: Create temp dir, run script to generate config, then manually set token to "test-token-123"
2. **Execute**: Bash: Run `python3 scripts/generate-openclaw-config.py --clear-token` with HOME set to temp dir
3. **Verify**: Bash: Parse JSON — token is `""`, model config and gateway.controlUi.allowedOrigins unchanged

**Tools Required**: python3, bash, jq

### Scenario 1.6: patchStagedDockerfile() requires no changes [VALIDATED: 1dbfc563]
**Type**: Sad Path (regression guard)

**Given**: `patchStagedDockerfile()` in `src/lib/onboard-command.ts` works via ARG patching
**When**: The Dockerfile extraction preserves the `ARG→ENV` promotion contract
**Then**: No modifications to onboard-command.ts are needed; existing onboard tests pass

**Validation Steps**:
1. **Execute**: Bash: `git diff HEAD -- src/lib/onboard-command.ts | wc -l` → 0 (no changes)
2. **Execute**: Bash: `npx vitest run src/lib/onboard-command.test.ts` (if exists)
3. **Verify**: onboard-related tests pass

**Tools Required**: bash, vitest

---

## Phase 2: Auto-Disable Device Auth for Non-Loopback URLs

### Scenario 2.1: Brev Launchable URL auto-disables device auth [VALIDATED: 1dbfc563]
**Type**: Happy Path — **The core fix for #2341**

**Given**: `scripts/generate-openclaw-config.py` has the non-loopback auto-disable logic
**When**: Script runs with `CHAT_UI_URL=https://nemoclaw0-xxx.brevlab.com:18789`
**Then**: Generated config has `gateway.controlUi.dangerouslyDisableDeviceAuth: true`

**Validation Steps**:
1. **Setup**: Bash: Create temp HOME dir
2. **Execute**: Bash: `CHAT_UI_URL=https://nemoclaw0-xxx.brevlab.com:18789 HOME=$TMPDIR python3 scripts/generate-openclaw-config.py` (with other required env vars)
3. **Verify**: Bash: `python3 -c "import json; c=json.load(open('$TMPDIR/.openclaw/openclaw.json')); assert c['gateway']['controlUi']['dangerouslyDisableDeviceAuth'] == True"`

**Tools Required**: python3, bash

### Scenario 2.2: Loopback URLs preserve device auth (no regression) [VALIDATED: 1dbfc563]
**Type**: Sad Path (regression guard)

**Given**: `scripts/generate-openclaw-config.py` has the non-loopback auto-disable logic
**When**: Script runs with loopback URLs (`127.0.0.1`, `localhost`, `[::1]`)
**Then**: Generated config has `gateway.controlUi.dangerouslyDisableDeviceAuth: false` for all

**Validation Steps**:
1. **Execute**: Bash: Run script with `CHAT_UI_URL=http://127.0.0.1:18789`, verify `dangerouslyDisableDeviceAuth: false`
2. **Execute**: Bash: Run script with `CHAT_UI_URL=http://localhost:18789`, verify `dangerouslyDisableDeviceAuth: false`
3. **Execute**: Bash: Run script with `CHAT_UI_URL=http://[::1]:18789`, verify `dangerouslyDisableDeviceAuth: false`

**Tools Required**: python3, bash

### Scenario 2.3: Docker build with Brev URL produces correct openclaw.json [STATUS: skipped — Docker daemon not running]
**Type**: Happy Path — **End-to-end integration: Dockerfile + Python script + ARG→ENV**

**Given**: The Dockerfile COPYs `generate-openclaw-config.py` and runs it during build;
the `ARG→ENV` promotion feeds `CHAT_UI_URL` to the script via `os.environ`
**When**: `docker build` is run with `--build-arg CHAT_UI_URL=https://nemoclaw0-xxx.brevlab.com:18789`
(plus other required build-args for a minimal config)
**Then**: The `/sandbox/.openclaw/openclaw.json` baked into the image has
`gateway.controlUi.dangerouslyDisableDeviceAuth: true` — confirming that a Brev Launchable
user would NOT see "pairing required"

**Validation Steps**:
1. **Setup**: Bash: Verify Docker daemon is running (`docker info`). If not available,
   skip with a clear message — this scenario is for CI or machines with Docker.
2. **Execute**: Bash: Build a **minimal target** that stops right after config generation
   to avoid needing the full base image and all build stages. Create a one-off
   Dockerfile snippet that:
   ```bash
   # Extract just the config generation layers into a throwaway image
   # Uses multi-stage: copy the script, set the ARGs/ENVs, run the script, stop.
   cat > /tmp/nemoclaw-config-test.Dockerfile <<'DOCKERFILE'
   FROM python:3.11-slim
   RUN useradd -m sandbox
   COPY scripts/generate-openclaw-config.py /usr/local/lib/nemoclaw/generate-openclaw-config.py
   ARG CHAT_UI_URL=http://127.0.0.1:18789
   ARG NEMOCLAW_MODEL=test-model
   ARG NEMOCLAW_PROVIDER_KEY=test-provider
   ARG NEMOCLAW_PRIMARY_MODEL_REF=test-ref
   ARG NEMOCLAW_INFERENCE_BASE_URL=http://localhost:8080
   ARG NEMOCLAW_INFERENCE_API=openai
   ARG NEMOCLAW_CONTEXT_WINDOW=131072
   ARG NEMOCLAW_MAX_TOKENS=4096
   ARG NEMOCLAW_REASONING=false
   ARG NEMOCLAW_AGENT_TIMEOUT=600
   ARG NEMOCLAW_INFERENCE_COMPAT_B64=e30=
   ARG NEMOCLAW_MESSAGING_CHANNELS_B64=
   ARG NEMOCLAW_MESSAGING_ALLOWED_IDS_B64=
   ARG NEMOCLAW_DISCORD_GUILDS_B64=
   ARG NEMOCLAW_DISABLE_DEVICE_AUTH=0
   ARG NEMOCLAW_PROXY_HOST=10.200.0.1
   ARG NEMOCLAW_PROXY_PORT=3128
   ARG NEMOCLAW_WEB_SEARCH_ENABLED=0
   ENV NEMOCLAW_MODEL=${NEMOCLAW_MODEL} \
       NEMOCLAW_PROVIDER_KEY=${NEMOCLAW_PROVIDER_KEY} \
       NEMOCLAW_PRIMARY_MODEL_REF=${NEMOCLAW_PRIMARY_MODEL_REF} \
       CHAT_UI_URL=${CHAT_UI_URL} \
       NEMOCLAW_INFERENCE_BASE_URL=${NEMOCLAW_INFERENCE_BASE_URL} \
       NEMOCLAW_INFERENCE_API=${NEMOCLAW_INFERENCE_API} \
       NEMOCLAW_CONTEXT_WINDOW=${NEMOCLAW_CONTEXT_WINDOW} \
       NEMOCLAW_MAX_TOKENS=${NEMOCLAW_MAX_TOKENS} \
       NEMOCLAW_REASONING=${NEMOCLAW_REASONING} \
       NEMOCLAW_AGENT_TIMEOUT=${NEMOCLAW_AGENT_TIMEOUT} \
       NEMOCLAW_INFERENCE_COMPAT_B64=${NEMOCLAW_INFERENCE_COMPAT_B64} \
       NEMOCLAW_MESSAGING_CHANNELS_B64=${NEMOCLAW_MESSAGING_CHANNELS_B64} \
       NEMOCLAW_MESSAGING_ALLOWED_IDS_B64=${NEMOCLAW_MESSAGING_ALLOWED_IDS_B64} \
       NEMOCLAW_DISCORD_GUILDS_B64=${NEMOCLAW_DISCORD_GUILDS_B64} \
       NEMOCLAW_DISABLE_DEVICE_AUTH=${NEMOCLAW_DISABLE_DEVICE_AUTH} \
       NEMOCLAW_PROXY_HOST=${NEMOCLAW_PROXY_HOST} \
       NEMOCLAW_PROXY_PORT=${NEMOCLAW_PROXY_PORT} \
       NEMOCLAW_WEB_SEARCH_ENABLED=${NEMOCLAW_WEB_SEARCH_ENABLED}
   USER sandbox
   RUN python3 /usr/local/lib/nemoclaw/generate-openclaw-config.py
   DOCKERFILE
   ```
3. **Execute**: Bash: Build with Brev URL:
   ```bash
   docker build -f /tmp/nemoclaw-config-test.Dockerfile \
     --build-arg CHAT_UI_URL=https://nemoclaw0-xxx.brevlab.com:18789 \
     -t nemoclaw-config-test:brev .
   ```
4. **Verify**: Bash: Extract and check the config:
   ```bash
   docker run --rm nemoclaw-config-test:brev \
     cat /home/sandbox/.openclaw/openclaw.json | python3 -c "
   import json, sys
   c = json.load(sys.stdin)
   assert c['gateway']['controlUi']['dangerouslyDisableDeviceAuth'] == True, \
     f'Expected dangerouslyDisableDeviceAuth=True, got {c[\"gateway\"][\"controlUi\"][\"dangerouslyDisableDeviceAuth\"]}'
   assert c['gateway']['controlUi']['allowInsecureAuth'] == False, \
     'HTTPS URL should have allowInsecureAuth=False'
   assert 'https://nemoclaw0-xxx.brevlab.com:18789' in str(c['gateway'].get('allowedOrigins', [])), \
     'Brev origin should be in allowedOrigins'
   print('PASS: Brev Launchable config verified')
   "
   ```
5. **Verify**: Bash: Also build with loopback URL and confirm device auth stays enabled:
   ```bash
   docker build -f /tmp/nemoclaw-config-test.Dockerfile \
     --build-arg CHAT_UI_URL=http://127.0.0.1:18789 \
     -t nemoclaw-config-test:local .
   docker run --rm nemoclaw-config-test:local \
     cat /home/sandbox/.openclaw/openclaw.json | python3 -c "
   import json, sys
   c = json.load(sys.stdin)
   assert c['gateway']['controlUi']['dangerouslyDisableDeviceAuth'] == False, \
     'Loopback URL should have dangerouslyDisableDeviceAuth=False'
   print('PASS: Loopback config verified')
   "
   ```
6. **Cleanup**: Bash: `docker rmi nemoclaw-config-test:brev nemoclaw-config-test:local 2>/dev/null`

**Tools Required**: docker, python3
**Prerequisites**: Docker daemon running. Skippable in environments without Docker.
**Why this matters**: This validates the full Dockerfile ARG→ENV→Python pipeline — the
same path a real Brev Launchable build follows. Unit tests cover the Python logic in
isolation; this proves the Dockerfile wiring is correct.

### Scenario 2.4: dashboard-contract buildChain returns shouldDisableDeviceAuth [VALIDATED: 1dbfc563]
**Type**: Happy Path

**Given**: `DashboardDeliveryChain` interface has `shouldDisableDeviceAuth` field
**When**: `buildChain()` is called with various hints
**Then**: Returns correct `shouldDisableDeviceAuth` for each scenario

**Validation Steps**:
1. **Execute**: Bash: `npx vitest run src/lib/dashboard-contract.test.ts`
2. **Verify**: Exit code 0, all tests pass including new `shouldDisableDeviceAuth` assertions

**Tools Required**: vitest

---

## Summary

| Phase | Happy | Sad | Total | Passed | Failed | Skipped |
|-------|-------|-----|-------|--------|--------|---------|
| Phase 1 | 4 | 2 | 6 | 6 | 0 | 0 |
| Phase 2 | 3 | 1 | 4 | 3 | 0 | 1 |
| **Total** | **7** | **3** | **10** | **9** | **0** | **1** |
