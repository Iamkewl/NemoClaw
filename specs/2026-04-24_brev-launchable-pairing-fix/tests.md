# Test Specification: Brev Launchable Pairing Fix

**Spec:** specs/2026-04-24_brev-launchable-pairing-fix/spec.md

---

## Phase 1: Extract Inline Python to `scripts/generate-openclaw-config.py`

### Existing Tests to Modify

**`test/security-c2-dockerfile-injection.test.ts`**

- **C-2 regression guards** (`inPythonRunBlock` scanning): These tests scan for
  `python3 -c` blocks in the Dockerfile. After extraction, the main config generation
  block no longer uses `python3 -c`. Tests need to:
  - Adapt to check for `COPY scripts/generate-openclaw-config.py` and
    `RUN python3 /usr/local/lib/nemoclaw/generate-openclaw-config.py`
  - Keep guarding against `$CHAT_UI_URL`/`$NEMOCLAW_MODEL` interpolation in any
    remaining `python3 -c` blocks
  - Keep `ARG→ENV` promotion checks (now verifying promotion before `RUN python3`)
  - Move functional assertions (env var reads, derivation checks) to the new test file

- **Gateway auth hardening** tests: The source-pattern assertions (`os.environ.get`,
  `'dangerouslyDisableDeviceAuth': disable_device_auth`) currently scan Dockerfile
  source. After extraction they should scan the Python script file instead, OR be
  replaced by functional tests in the new file.

### New Tests to Create

**`test/generate-openclaw-config.test.ts`**

Helper:
```typescript
function runConfigScript(envOverrides: Record<string, string> = {}): object {
  // Create temp dir, set HOME, merge required envs, run script, parse JSON output
}

const BASE_ENV = {
  NEMOCLAW_MODEL: "test-model",
  NEMOCLAW_PROVIDER_KEY: "test-provider",
  NEMOCLAW_PRIMARY_MODEL_REF: "test-ref",
  CHAT_UI_URL: "http://127.0.0.1:18789",
  NEMOCLAW_INFERENCE_BASE_URL: "http://localhost:8080",
  NEMOCLAW_INFERENCE_API: "openai",
  NEMOCLAW_INFERENCE_COMPAT_B64: btoa("{}"),
  NEMOCLAW_PROXY_HOST: "10.200.0.1",
  NEMOCLAW_PROXY_PORT: "3128",
};
```

1. `test_should_generate_valid_json_with_minimal_env`
   - **Input**: BASE_ENV only
   - **Expected**: Valid JSON written to `~/.openclaw/openclaw.json`
   - **Covers**: Script runs, produces valid output

2. `test_should_set_disable_device_auth_false_for_loopback_url`
   - **Input**: `CHAT_UI_URL=http://127.0.0.1:18789`
   - **Expected**: `gateway.controlUi.dangerouslyDisableDeviceAuth: false`
   - **Covers**: Phase 1 behavior preservation

3. `test_should_set_disable_device_auth_true_when_env_var_is_1`
   - **Input**: `NEMOCLAW_DISABLE_DEVICE_AUTH=1`
   - **Expected**: `gateway.controlUi.dangerouslyDisableDeviceAuth: true`
   - **Covers**: Explicit env var override

4. `test_should_set_allow_insecure_true_for_http_scheme`
   - **Input**: `CHAT_UI_URL=http://127.0.0.1:18789`
   - **Expected**: `gateway.controlUi.allowInsecureAuth: true`
   - **Covers**: HTTP scheme → insecure allowed

5. `test_should_set_allow_insecure_false_for_https_scheme`
   - **Input**: `CHAT_UI_URL=https://nemoclaw0-xxx.brevlab.com:18789`
   - **Expected**: `gateway.controlUi.allowInsecureAuth: false`
   - **Covers**: HTTPS scheme → insecure disallowed

6. `test_should_include_non_loopback_origin_in_allowed_origins`
   - **Input**: `CHAT_UI_URL=https://nemoclaw0-xxx.brevlab.com:18789`
   - **Expected**: `gateway.controlUi.allowedOrigins` includes both loopback and external origin
   - **Covers**: CORS origins for non-loopback URL

7. `test_should_include_only_loopback_origin_for_loopback_url`
   - **Input**: `CHAT_UI_URL=http://127.0.0.1:18789`
   - **Expected**: `gateway.controlUi.allowedOrigins` has only `["http://127.0.0.1:18789"]`
   - **Covers**: CORS origins for loopback URL

8. `test_should_parse_messaging_channels_from_base64`
   - **Input**: `NEMOCLAW_MESSAGING_CHANNELS_B64=<base64 of channel JSON>`
   - **Expected**: Channels appear in config
   - **Covers**: Channel config parsing

9. `test_should_enable_web_search_when_env_is_1`
   - **Input**: `NEMOCLAW_WEB_SEARCH_ENABLED=1`
   - **Expected**: `tools.web.search` present
   - **Covers**: Web search feature flag

10. `test_should_omit_web_search_when_env_not_set`
    - **Input**: No `NEMOCLAW_WEB_SEARCH_ENABLED`
    - **Expected**: No `tools.web` key
    - **Covers**: Web search disabled by default

11. `test_should_propagate_agent_timeout`
    - **Input**: `NEMOCLAW_AGENT_TIMEOUT=300`
    - **Expected**: `agents.defaults.timeoutSeconds: 300`
    - **Covers**: Timeout propagation

12. `test_should_set_gateway_auth_token_to_empty_string`
    - **Input**: BASE_ENV
    - **Expected**: `gateway.auth.token: ""`
    - **Covers**: Token starts empty (no stale token)

13. `test_should_clear_token_with_flag`
    - **Input**: Write a config with non-empty token, run script with `--clear-token`
    - **Expected**: Token cleared to `""`, rest of config preserved
    - **Covers**: `--clear-token` flag

14. `test_should_set_file_permissions_to_0600`
    - **Input**: BASE_ENV
    - **Expected**: File mode is `0o600` (on non-Windows)
    - **Covers**: Security — config not world-readable

**Test Implementation Notes:**
- Use `spawnSync("python3", [...])` pattern from existing C-2 tests
- Create temp HOME dir per test, clean up after
- Required: `python3` available in test environment

---

## Phase 2: Auto-Disable Device Auth for Non-Loopback URLs

### Existing Tests to Modify

**`src/lib/dashboard-contract.test.ts`**

Add `shouldDisableDeviceAuth` assertions to existing and new test cases:

- Existing "returns default loopback chain with no arguments" → add
  `expect(c.shouldDisableDeviceAuth).toBe(false)`
- Existing "binds to 0.0.0.0 for non-loopback URL" → add
  `expect(c.shouldDisableDeviceAuth).toBe(true)`
- Existing "uses WSL host address" → add
  `expect(c.shouldDisableDeviceAuth).toBe(true)`

**`test/security-c2-dockerfile-injection.test.ts`**

Update "dangerouslyDisableDeviceAuth is derived from NEMOCLAW_DISABLE_DEVICE_AUTH env var"
to scan the Python script for both `NEMOCLAW_DISABLE_DEVICE_AUTH` and `is_loopback`.

### New Tests to Create

**`src/lib/dashboard-contract.test.ts`** (new cases)

1. `test_should_disable_device_auth_false_for_default`
   - **Input**: `buildChain()` (no hints)
   - **Expected**: `shouldDisableDeviceAuth: false`
   - **Covers**: Secure default

2. `test_should_disable_device_auth_true_for_non_loopback_url`
   - **Input**: `buildChain({ chatUiUrl: "https://nemoclaw0-xxx.brevlab.com" })`
   - **Expected**: `shouldDisableDeviceAuth: true`
   - **Covers**: Brev Launchable scenario

3. `test_should_disable_device_auth_false_for_localhost`
   - **Input**: `buildChain({ chatUiUrl: "http://localhost:18789" })`
   - **Expected**: `shouldDisableDeviceAuth: false`

4. `test_should_disable_device_auth_false_for_ipv6_loopback`
   - **Input**: `buildChain({ chatUiUrl: "http://[::1]:18789" })`
   - **Expected**: `shouldDisableDeviceAuth: false`

5. `test_should_disable_device_auth_true_for_wsl`
   - **Input**: `buildChain({ isWsl: true })`
   - **Expected**: `shouldDisableDeviceAuth: true`

6. `test_should_disable_device_auth_true_for_schemeless_non_loopback`
   - **Input**: `buildChain({ chatUiUrl: "remote-host:18789" })`
   - **Expected**: `shouldDisableDeviceAuth: true`

**`test/generate-openclaw-config.test.ts`** (new cases)

7. `test_should_auto_disable_device_auth_for_brev_url`
   - **Input**: `CHAT_UI_URL=https://nemoclaw0-xxx.brevlab.com:18789`
   - **Expected**: `dangerouslyDisableDeviceAuth: true`
   - **Covers**: **The core fix for #2341**

8. `test_should_auto_disable_device_auth_for_any_non_loopback`
   - **Input**: `CHAT_UI_URL=http://my-server.local:18789`
   - **Expected**: `dangerouslyDisableDeviceAuth: true`

9. `test_should_keep_device_auth_enabled_for_127_0_0_1`
   - **Input**: `CHAT_UI_URL=http://127.0.0.1:18789`
   - **Expected**: `dangerouslyDisableDeviceAuth: false`

10. `test_should_keep_device_auth_enabled_for_localhost`
    - **Input**: `CHAT_UI_URL=http://localhost:18789`
    - **Expected**: `dangerouslyDisableDeviceAuth: false`

11. `test_should_keep_device_auth_enabled_for_ipv6_loopback`
    - **Input**: `CHAT_UI_URL=http://[::1]:18789`
    - **Expected**: `dangerouslyDisableDeviceAuth: false`

12. `test_should_honor_explicit_env_var_override_on_loopback`
    - **Input**: `NEMOCLAW_DISABLE_DEVICE_AUTH=1` + loopback URL
    - **Expected**: `dangerouslyDisableDeviceAuth: true`

13. `test_should_not_reenable_when_env_is_0_and_url_is_non_loopback`
    - **Input**: `NEMOCLAW_DISABLE_DEVICE_AUTH=0` + non-loopback URL
    - **Expected**: `dangerouslyDisableDeviceAuth: true` (URL trumps)

**`scripts/generate-openclaw-config.py` — `is_loopback()` parity tests**

14. `test_is_loopback_matches_typescript_for_localhost` → `true`
15. `test_is_loopback_matches_typescript_for_ipv6` → `true` for `::1`
16. `test_is_loopback_matches_typescript_for_127_range` → `true` for `127.0.0.1`, `127.0.0.255`
17. `test_is_loopback_matches_typescript_for_bracketed_ipv6` → `true` for `[::1]`
18. `test_is_loopback_matches_typescript_case_insensitive` → `true` for `LOCALHOST`
19. `test_is_loopback_false_for_external_host` → `false` for `example.com`

**Test Implementation Notes:**
- `is_loopback()` parity tests can run the Python function directly via
  `python3 -c "from generate_openclaw_config import is_loopback; print(is_loopback('...'))"` 
  or use the full script with appropriate CHAT_UI_URL values
- Dashboard contract tests use existing vitest pattern importing from `dist/`
