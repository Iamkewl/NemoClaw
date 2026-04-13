// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared credential stripping utilities.
 *
 * Used by both the host CLI (config get, state export) and the plugin
 * (slash command config display) to redact sensitive fields before output.
 *
 * Extracted from nemoclaw/src/commands/migration-state.ts so both the plugin
 * and host CLI can share the same logic without cross-package imports.
 */

const STRIPPED_PLACEHOLDER = "[REDACTED]";

/**
 * Credential field names that MUST be stripped from config objects.
 */
export const CREDENTIAL_FIELDS = new Set([
  "apiKey",
  "api_key",
  "token",
  "secret",
  "password",
  "resolvedKey",
]);

/**
 * Pattern-based detection for credential field names not covered by the
 * explicit set above. Matches common suffixes like accessToken, privateKey,
 * clientSecret, etc.
 */
export const CREDENTIAL_FIELD_PATTERN =
  /(?:access|refresh|client|bearer|auth|api|private|public|signing|session)(?:Token|Key|Secret|Password)$/;

export function isCredentialField(key: string): boolean {
  return CREDENTIAL_FIELDS.has(key) || CREDENTIAL_FIELD_PATTERN.test(key);
}

/**
 * Recursively strip credential fields from a JSON-like object.
 * Returns a new object with sensitive values replaced by a placeholder.
 */
export function stripCredentials(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(stripCredentials);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (isCredentialField(key)) {
      result[key] = STRIPPED_PLACEHOLDER;
    } else {
      result[key] = stripCredentials(value);
    }
  }
  return result;
}

export { STRIPPED_PLACEHOLDER };
