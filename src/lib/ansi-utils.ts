// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Strip ANSI escape sequences from terminal-oriented output.
 * Covers CSI (color, erase, cursor), OSC, and C1 two-byte escapes per ECMA-48.
 */
export const ANSI_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-_])/g;

export function stripAnsi(value: string): string {
  return String(value || "").replace(ANSI_RE, "");
}
