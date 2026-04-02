// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Parse a comma-separated list of allowed chat IDs into a Set.
 * Returns null if the input is empty or undefined (meaning: accept all).
 */
export function parseAllowedChatIds(raw: string | undefined): Set<string> | null {
  if (!raw) return null;
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return ids.length > 0 ? new Set(ids) : null;
}

/**
 * Check whether a chat ID is allowed.
 *
 * When `allowed` is null every chat is accepted (open mode).
 * Otherwise the chat ID must be in the allowed set.
 */
export function isChatAllowed(chatId: string, allowed: Set<string> | null): boolean {
  if (allowed === null) return true;
  return allowed.has(chatId);
}
