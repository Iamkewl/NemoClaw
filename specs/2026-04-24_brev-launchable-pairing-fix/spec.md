# Fix Brev Launchable "pairing required" and Extract Dockerfile Config Generation

**Issue:** [#2341](https://github.com/NVIDIA/NemoClaw/issues/2341)
**Branch:** `issue-2341-brev-launchable-pairing-required`
**Worktree:** `/Users/jyaunches/Development/NemoClaw-working/issue-2341`
**Builds on:** PR #2398 (dashboard delivery chain refactor)

---

## Overview

Brev Launchable users see "pairing required" in the OpenClaw Web UI after deployment.
They have **only** web access (no terminal), so they cannot complete device pairing.
The auto-pair watcher inside the container cannot help because the browser may not
establish a websocket connection (CORS / port-binding issues prevent the pairing
request from being registered).

PR #2398 fixed the CORS and port-binding side. This spec addresses the remaining
piece: **automatically disabling device auth when `CHAT_UI_URL` is non-loopback**,
since terminal-based pairing is impossible in that context.

The fix requires modifying the Dockerfile's inline Python config generation — a 68-line
`python3 -c` one-liner that is untestable, unlintable, and unsafe to modify. Rather
than add more logic to that block, we extract it to a standalone Python script first,
then add the fix on a clean foundation.

## Problem Statement

1. **`NEMOCLAW_DISABLE_DEVICE_AUTH` defaults to `0`** in the Dockerfile (`ARG` line 217).
   The `patchStagedDockerfile()` function in `onboard.ts` overrides this to `1`, but
   builds that bypass onboard (e.g., Brev Launchable user-facing flow) inherit the
   default — leaving device auth enabled.

2. **No URL-based derivation.** The Dockerfile's Python config sets
   `disable_device_auth = os.environ.get('NEMOCLAW_DISABLE_DEVICE_AUTH', '') == '1'` —
   a pure env-var check. A non-loopback `CHAT_UI_URL` (like
   `https://nemoclaw0-xxx.brevlab.com`) inherently means the user has no terminal access,
   yet device auth remains enabled.

3. **The inline Python is untestable.** The 68-line `python3 -c "..."` block with `\`
   continuations cannot be imported, mocked, linted, or asserted on. Existing "tests"
   are regex scans of the Dockerfile source. Adding more logic to this block increases
   risk with no safety net.

## Objectives

1. Extract the inline Python config generation to `scripts/generate-openclaw-config.py`
   — a real, testable Python file.
2. Automatically disable device auth when `CHAT_UI_URL` is non-loopback.
3. Add `shouldDisableDeviceAuth` to the dashboard delivery chain contract so the
   TypeScript side has the same signal.
4. Replace regex-based Dockerfile source scanning with functional tests that run the
   actual Python script and assert on JSON output.

## Current State

### Dockerfile (lines 282–349): Inline Python config generation

```
RUN python3 -c "\
import base64, json, os; \
from urllib.parse import urlparse; \
...68 lines of semicolon-delimited, backslash-continued Python...
json.dump(config, open(path, 'w'), indent=2); \
os.chmod(path, 0o600)"
```

**Reads** 18 env vars via `os.environ` / `os.environ.get()`.
**Writes** `~/.openclaw/openclaw.json` with gateway config, model config, channel config.
**Key derivations:**
- `disable_device_auth` — only from `NEMOCLAW_DISABLE_DEVICE_AUTH` env var
- `allow_insecure` — from `parsed.scheme == 'http'`
- `origins` — loopback + parsed `CHAT_UI_URL` origin
- Channel config — from base64-encoded messaging env vars

### Dockerfile (lines 358–364): Token clearing

A 7-line `python3 -c` block that reads `openclaw.json`, clears `gateway.auth.token`,
and writes it back. Exists because `openclaw doctor --fix` (line 352) may auto-generate
a token — the real token is created at container startup.

### `patchStagedDockerfile()` in `onboard.ts` (line 1317)

Patches `ARG` lines in the Dockerfile before `docker build`. The `ARG→ENV` promotion
(Dockerfile lines 237–256) feeds the Python script via `os.environ`. This function
does NOT modify the Python source — only the `ARG` defaults. This contract is preserved
by the extraction.

### `dashboard-contract.ts` (PR #2398)

Pure `buildChain()` function computes `accessUrl`, `corsOrigins`, `forwardTarget`,
`healthEndpoint`, `port`, `bindAddress` from `PlatformHints`. Already detects
non-loopback URLs via `isLoopbackUrl()` (which delegates to `isLoopbackHostname()`
from `url-utils.ts`). Does NOT currently surface a device-auth signal.

### `security-c2-dockerfile-injection.test.ts`

Regression tests for the C-2 code injection vector. Verifies:
- No `$CHAT_UI_URL` / `$NEMOCLAW_MODEL` interpolation in Python blocks
- `os.environ` reads present
- `ARG→ENV` promotion before the `RUN` layer
- `dangerouslyDisableDeviceAuth` not hardcoded to `True`
- `allowInsecureAuth` derived from URL scheme

These tests use `inPythonRunBlock` flag scanning — they detect `RUN.*python3 -c`
patterns and scan the continuation lines. They will need updating when the inline
Python is replaced with `RUN python3 /path/to/script.py`.

### Open PR Coordination

Three active PRs modify the same inline Python block:

| PR | Author | Change | Sprint 3? | Status |
|----|--------|--------|-----------|--------|
| #2441 | `rluo8` | Add `NEMOCLAW_INFERENCE_INPUTS` env var + `inference_inputs` parsing | No | Actively reviewed, may merge soon |
| #2417 | `latenighthackathon` | Add `NEMOCLAW_TELEGRAM_CONFIG_B64` for mention-only mode | Yes (via #1737) | Active, no human review yet |
| #1497 | `13ernkastel` | Replace `NEMOCLAW_WEB_SEARCH_ENABLED` with `NEMOCLAW_WEB_CONFIG_B64` | Extends #1464 | 3 weeks, many revisions |

**Strategy:** We wait for PR #2441 to merge (it's small and close to landing), then
our Phase 1 extraction captures the current state of main including that change.
PRs #2417 and #1497 rebase onto the extracted script afterward — their changes become
clean Python edits to a real file instead of more `\` continuation surgery.

---

## Phase 1: Extract Inline Python to `scripts/generate-openclaw-config.py` [COMPLETED: ca46f470]

**Goal:** Replace the 68-line inline `python3 -c` block and the 7-line token-clearing
block in the Dockerfile with a single COPY'd Python script. Zero behavior change —
the generated `openclaw.json` is byte-for-byte identical.

### Files Changed

#### New: `scripts/generate-openclaw-config.py`

A proper Python 3 script extracted from the inline block. Structure:

```
#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Generate openclaw.json from environment variables.

Called at Docker image build time (RUN layer) after ARG→ENV promotion.
Reads all configuration from os.environ — never from string interpolation
in Dockerfile source. See: C-2 security model.

Environment variables:
    CHAT_UI_URL                       Dashboard URL (default: http://127.0.0.1:18789)
    NEMOCLAW_MODEL                    Model identifier
    NEMOCLAW_PROVIDER_KEY             Provider key for model config
    NEMOCLAW_PRIMARY_MODEL_REF        Primary model reference
    NEMOCLAW_INFERENCE_BASE_URL       Inference endpoint
    NEMOCLAW_INFERENCE_API            Inference API type
    NEMOCLAW_CONTEXT_WINDOW           Context window size (default: 131072)
    NEMOCLAW_MAX_TOKENS               Max tokens (default: 4096)
    NEMOCLAW_REASONING                Enable reasoning (default: false)
    NEMOCLAW_AGENT_TIMEOUT            Per-request timeout seconds (default: 600)
    NEMOCLAW_INFERENCE_COMPAT_B64     Base64-encoded inference compat JSON
    NEMOCLAW_MESSAGING_CHANNELS_B64   Base64-encoded channel list
    NEMOCLAW_MESSAGING_ALLOWED_IDS_B64  Base64-encoded allowed IDs map
    NEMOCLAW_DISCORD_GUILDS_B64       Base64-encoded Discord guild config
    NEMOCLAW_DISABLE_DEVICE_AUTH      Set to "1" to force-disable device auth
    NEMOCLAW_PROXY_HOST               Egress proxy host (default: 10.200.0.1)
    NEMOCLAW_PROXY_PORT               Egress proxy port (default: 3128)
    NEMOCLAW_WEB_SEARCH_ENABLED       Set to "1" to enable web search tools
"""
```

The script contains:

1. **`is_loopback(hostname)`** — Pure function. Mirrors `isLoopbackHostname()` from
   `src/lib/url-utils.ts`. Returns `True` for `localhost`, `::1`, and `127.x.x.x`.

2. **`build_config(env)`** — Pure function that takes a dict of env vars (defaulting to
   `os.environ`) and returns the complete config dict. This is the testable core.
   All current inline logic moves here verbatim, with proper line breaks and comments.

3. **`main()`** — Calls `build_config(os.environ)`, writes JSON to
   `~/.openclaw/openclaw.json`, sets permissions to `0o600`. Also clears
   `gateway.auth.token` to empty string (absorbs the second inline block).

4. **`if __name__ == "__main__": main()`**

**Key design decisions:**
- `build_config(env)` accepts a dict parameter (defaulting to `os.environ`) so tests
  can inject controlled env vars without monkeypatching `os.environ`.
- The function returns the config dict rather than writing it — tests assert on the
  dict directly without filesystem I/O.
- `is_loopback()` is a separate function so it can be tested in isolation and so the
  equivalence with the TypeScript `isLoopbackHostname()` is easy to verify.

#### Modified: `Dockerfile`

Replace lines 282–349 (68-line `python3 -c` block) and lines 358–364 (7-line
token-clearing block) with:

```dockerfile
COPY scripts/generate-openclaw-config.py /usr/local/lib/nemoclaw/generate-openclaw-config.py
RUN python3 /usr/local/lib/nemoclaw/generate-openclaw-config.py
```

The `COPY` goes alongside existing script COPYs (after line 182, in root context).
The `RUN` replaces both inline Python blocks at line 282 (in `USER sandbox` context).

Remove the `openclaw doctor --fix` + token-clearing block (lines 351–364) since
`generate-openclaw-config.py` writes the token as empty string from the start, so
there is no stale token to clear. The `openclaw doctor --fix` and
`openclaw plugins install` RUN at line 351-352 remains untouched.

Wait — actually, `openclaw doctor --fix` (line 351) may itself write a token into
`openclaw.json`. The token-clearing block existed precisely because of that. So the
`RUN python3 -c` token-clearing block on lines 358-364 must stay OR we reorder:
run `generate-openclaw-config.py` AFTER `openclaw doctor --fix`. The cleanest approach:

1. `RUN python3 /usr/local/lib/nemoclaw/generate-openclaw-config.py` — writes config
   with `auth.token: ""`
2. `RUN openclaw doctor --fix ...` — may auto-generate a token
3. `RUN python3 /usr/local/lib/nemoclaw/generate-openclaw-config.py --clear-token` —
   re-reads the file and clears just the token

Actually, the simplest approach that preserves existing ordering:

1. `RUN python3 /usr/local/lib/nemoclaw/generate-openclaw-config.py` — generates config
   (replaces 68-line inline block)
2. `RUN openclaw doctor --fix ... && openclaw plugins install ...` — unchanged
3. `RUN python3 /usr/local/lib/nemoclaw/generate-openclaw-config.py --clear-token` —
   clears the token (replaces 7-line inline block)

The `--clear-token` flag makes the script read the existing file, clear
`gateway.auth.token`, and write it back. This keeps the two-step pattern explicit
and avoids conflating generation with post-hoc cleanup.

#### Modified: `test/security-c2-dockerfile-injection.test.ts`

The C-2 regression tests need updating:

1. **Remove or adapt `inPythonRunBlock` scanning.** The main config generation no longer
   uses `python3 -c`. The C-2 injection surface is structurally eliminated — there is
   no inline Python source to inject into.

2. **Add new assertions:**
   - Dockerfile contains `COPY scripts/generate-openclaw-config.py` before the `RUN`
   - Dockerfile contains `RUN python3 /usr/local/lib/nemoclaw/generate-openclaw-config.py`
   - No `$CHAT_UI_URL` or `$NEMOCLAW_MODEL` interpolation in any remaining `python3 -c`
     blocks (the small `--clear-token` invocation doesn't read those vars, but the guard
     stays as defense-in-depth)
   - `ARG→ENV` promotion still exists before the `RUN python3` layer

3. **Preserve existing PoC tests.** The C-2 PoC tests (vulnerable vs fixed pattern) are
   still valid as documentation. They don't reference the Dockerfile structure.

4. **Preserve existing gateway auth hardening tests.** The assertions about
   `NEMOCLAW_DISABLE_DEVICE_AUTH` defaults and `dangerouslyDisableDeviceAuth` derivation
   move to the new functional test file (Phase 1 test below) since they now test the
   Python script rather than Dockerfile source patterns.

#### New: `test/generate-openclaw-config.test.ts`

Functional tests that run the actual Python script with controlled env vars and assert
on the JSON output. Uses `spawnSync("python3", [...])` pattern from existing C-2 tests.

**Helper:**
```typescript
function runConfigScript(envOverrides: Record<string, string> = {}): object {
  // Create a temp dir for output
  // Set HOME to temp dir so ~/.openclaw/openclaw.json writes there
  // Merge required env vars with overrides
  // Run: python3 scripts/generate-openclaw-config.py
  // Read and parse the generated openclaw.json
  // Return the parsed config object
}
```

**Required env vars for a minimal run** (derived from the current inline Python):
```
NEMOCLAW_MODEL, NEMOCLAW_PROVIDER_KEY, NEMOCLAW_PRIMARY_MODEL_REF,
CHAT_UI_URL, NEMOCLAW_INFERENCE_BASE_URL, NEMOCLAW_INFERENCE_API,
NEMOCLAW_INFERENCE_COMPAT_B64, NEMOCLAW_PROXY_HOST, NEMOCLAW_PROXY_PORT
```

**Phase 1 tests (behavior-preserving):**

- Default loopback URL → `dangerouslyDisableDeviceAuth: false`,
  `allowInsecureAuth: true`, `allowedOrigins: ["http://127.0.0.1:18789"]`
- HTTPS URL → `allowInsecureAuth: false`
- Non-loopback URL → `allowedOrigins` includes both loopback and external origin
- `NEMOCLAW_DISABLE_DEVICE_AUTH=1` → `dangerouslyDisableDeviceAuth: true`
- Messaging channels base64 → channels present in config
- Web search enabled → tools.web.search present
- Web search disabled → no tools.web key
- Agent timeout propagated to `agents.defaults.timeoutSeconds`
- `gateway.auth.token` is empty string
- `--clear-token` flag reads existing file and clears only the token

#### Modified: `Dockerfile` (comments)

- Update the `ARG NEMOCLAW_DISABLE_DEVICE_AUTH=0` comment to document upcoming
  auto-derivation (Phase 2 adds the behavior):
  ```
  # Set to "1" to force-disable device-pairing auth. Default: "0".
  ```

- Add comment block above the `RUN python3` line referencing the script:
  ```
  # Generate openclaw.json from environment variables. Config generation logic
  # lives in scripts/generate-openclaw-config.py — see that file for the full
  # list of env vars and derivation rules.
  ```

#### Modified: `scripts/generate-openclaw-config.py` (docstring)

- Ensure the module docstring is complete with all env vars documented.

### Acceptance Criteria

- [ ] `npm test` passes — all existing tests pass (some C-2 tests updated)
- [ ] `npx prek run --all-files` passes (lint, format, shellcheck, hadolint)
- [ ] The generated `openclaw.json` from the script is structurally identical to what
      the inline Python produced for the same env vars
- [ ] `patchStagedDockerfile()` in onboard.ts requires zero changes
- [ ] `test/generate-openclaw-config.test.ts` has ≥10 tests covering all config
      derivation paths
- [ ] No `python3 -c` blocks remain in the Dockerfile for config generation (the
      `--clear-token` invocation may use `python3 <script> --clear-token` or remain
      as a trivial inline one-liner — either is acceptable)

---

## Phase 2: Auto-Disable Device Auth for Non-Loopback URLs

**Goal:** When `CHAT_UI_URL` is non-loopback, automatically set
`dangerouslyDisableDeviceAuth: true` in the generated `openclaw.json`. This fixes
#2341 for Brev Launchable and all other remote/headless deployments.

### Files Changed

#### Modified: `scripts/generate-openclaw-config.py`

Change the `disable_device_auth` derivation in `build_config()`:

**Before (Phase 1):**
```python
disable_device_auth = env.get('NEMOCLAW_DISABLE_DEVICE_AUTH', '') == '1'
```

**After:**
```python
_is_remote = not is_loopback(parsed.hostname or '')
disable_device_auth = (
    env.get('NEMOCLAW_DISABLE_DEVICE_AUTH', '') == '1'
    or _is_remote
)
```

This mirrors the `hasNonLoopbackUrl` logic in `dashboard-contract.ts:buildChain()`.
The explicit env var override still works — it just becomes redundant for non-loopback
URLs. Local deployments (`127.0.0.1`, `localhost`, `::1`) are unaffected.

#### Modified: `src/lib/dashboard-contract.ts`

Add `shouldDisableDeviceAuth` to the `DashboardDeliveryChain` interface and
`buildChain()` output:

```typescript
export interface DashboardDeliveryChain {
  accessUrl: string;
  corsOrigins: string[];
  forwardTarget: string;
  healthEndpoint: string;
  port: number;
  bindAddress: string;
  shouldDisableDeviceAuth: boolean;  // NEW
}
```

In `buildChain()`:
```typescript
const shouldDisableDeviceAuth = hasNonLoopbackUrl || (h.isWsl ?? false);

return {
  accessUrl, corsOrigins, forwardTarget,
  healthEndpoint: "/health", port, bindAddress,
  shouldDisableDeviceAuth,
};
```

This establishes the TypeScript-side convention. Callers (status, recovery, future
onboard refactors) can query the chain to know whether device auth should be off.
The field is informational in this PR — no existing callers read it yet.

#### Modified: `src/lib/dashboard-contract.test.ts`

Add tests for `shouldDisableDeviceAuth`:

- Default (no hints) → `false`
- `chatUiUrl: "https://nemoclaw0-xxx.brevlab.com"` → `true`
- `chatUiUrl: "http://127.0.0.1:18789"` → `false`
- `chatUiUrl: "http://localhost:18789"` → `false`
- `chatUiUrl: "http://[::1]:18789"` → `false`
- `isWsl: true` → `true`
- `chatUiUrl: "remote-host:18789"` (schemeless non-loopback) → `true`

#### Modified: `test/generate-openclaw-config.test.ts`

Add tests for the non-loopback auto-disable:

- `CHAT_UI_URL=https://nemoclaw0-xxx.brevlab.com:18789` →
  `dangerouslyDisableDeviceAuth: true`  **(the fix for #2341)**
- `CHAT_UI_URL=http://my-server.local:18789` →
  `dangerouslyDisableDeviceAuth: true`
- `CHAT_UI_URL=http://127.0.0.1:18789` →
  `dangerouslyDisableDeviceAuth: false` (loopback — pairing possible)
- `CHAT_UI_URL=http://localhost:18789` →
  `dangerouslyDisableDeviceAuth: false`
- `CHAT_UI_URL=http://[::1]:18789` →
  `dangerouslyDisableDeviceAuth: false`
- `NEMOCLAW_DISABLE_DEVICE_AUTH=1` + loopback URL →
  `dangerouslyDisableDeviceAuth: true` (explicit override still works)
- `NEMOCLAW_DISABLE_DEVICE_AUTH=0` + non-loopback URL →
  `dangerouslyDisableDeviceAuth: true` (URL trumps — env var cannot re-enable)

#### Modified: `test/security-c2-dockerfile-injection.test.ts`

Update the gateway auth hardening test:

**Existing test to update:**
```
it("dangerouslyDisableDeviceAuth is derived from NEMOCLAW_DISABLE_DEVICE_AUTH env var")
```

This test currently asserts the env-var-only pattern. Update the description and
assertion to also verify the non-loopback derivation exists in the Python script:

```typescript
it("dangerouslyDisableDeviceAuth is derived from env var AND non-loopback URL", () => {
  const src = fs.readFileSync(SCRIPT_PATH, "utf-8");
  // Env var check still present
  expect(src).toMatch(/NEMOCLAW_DISABLE_DEVICE_AUTH/);
  // Non-loopback derivation present
  expect(src).toMatch(/is_loopback/);
  // Both feed into disable_device_auth
  expect(src).toMatch(/disable_device_auth/);
});
```

#### Modified: `Dockerfile` (comments)

- Update the `ARG NEMOCLAW_DISABLE_DEVICE_AUTH=0` comment to document auto-derivation:
  ```
  # Set to "1" to force-disable device-pairing auth. Also auto-disabled when
  # CHAT_UI_URL is a non-loopback address (Brev Launchable, remote deployments)
  # since terminal-based pairing is impossible in those contexts.
  # Default: "0" (device auth enabled for local deployments — secure by default).
  ```

#### Modified: `scripts/nemoclaw-start.sh`

- Update the header comment (line 15) for `NEMOCLAW_DISABLE_DEVICE_AUTH`:
  ```
  #   NEMOCLAW_DISABLE_DEVICE_AUTH  Build-time only. Set to "1" to skip device-pairing auth.
  #                                  Also auto-disabled when CHAT_UI_URL is non-loopback.
  ```

#### Modified: `scripts/generate-openclaw-config.py`

- Add inline comment at the `disable_device_auth` derivation explaining the
  rationale: terminal pairing is impossible when the URL is non-loopback.

### Acceptance Criteria

- [ ] `npm test` passes
- [ ] `npx prek run --all-files` passes
- [ ] Brev Launchable URL (`CHAT_UI_URL=https://nemoclaw0-xxx.brevlab.com:18789`)
      produces `dangerouslyDisableDeviceAuth: true` in generated config
- [ ] Loopback URLs (`127.0.0.1`, `localhost`, `::1`) still produce
      `dangerouslyDisableDeviceAuth: false` (unless explicit env override)
- [ ] `NEMOCLAW_DISABLE_DEVICE_AUTH=1` still works as explicit override
- [ ] `dashboard-contract.ts` `buildChain()` returns `shouldDisableDeviceAuth`
      for all existing test scenarios
- [ ] `is_loopback()` in the Python script matches `isLoopbackHostname()` in
      `url-utils.ts` for: `localhost`, `::1`, `127.0.0.1`, `127.0.0.255`,
      `[::1]`, `LOCALHOST` (case-insensitive)
- [ ] `ARG NEMOCLAW_DISABLE_DEVICE_AUTH` comment in Dockerfile mentions auto-derivation
- [ ] `nemoclaw-start.sh` header mentions auto-derivation
- [ ] `generate-openclaw-config.py` docstring documents non-loopback derivation

---

## Out of Scope

- **Modifying the auto-pair watcher** (`nemoclaw-start.sh:799-883`). The auto-pair is
  defense-in-depth for cases where device auth is intentionally enabled. The root fix
  is disabling device auth for headless deployments.
- **Absorbing in-flight PR changes** (#2441, #2417, #1497). Those PRs rebase onto
  the extracted script after this PR merges.
- **Changing `patchStagedDockerfile()` in `onboard.ts`**. The ARG-patching contract
  is preserved. Onboard still sets `NEMOCLAW_DISABLE_DEVICE_AUTH=1` as an explicit
  guarantee — the non-loopback auto-disable is a safety net for non-onboard builds.
- **PR #2227** (mutable config refactor). That PR changes post-config DAC permissions,
  not the config generation itself. No conflict.
