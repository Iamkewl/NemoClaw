// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { parseAllowedChatIds, isChatAllowed } from "../../dist/lib/chat-filter.js";

describe("lib/chat-filter", () => {
  describe("parseAllowedChatIds", () => {
    it("returns null for undefined input", () => {
      expect(parseAllowedChatIds(undefined)).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(parseAllowedChatIds("")).toBeNull();
    });

    it("returns null for whitespace-only string", () => {
      expect(parseAllowedChatIds("  , , ")).toBeNull();
    });

    it("parses single chat ID", () => {
      const result = parseAllowedChatIds("12345");
      expect(result).toEqual(new Set(["12345"]));
    });

    it("parses comma-separated chat IDs with whitespace", () => {
      const result = parseAllowedChatIds("111, 222 ,333");
      expect(result).toEqual(new Set(["111", "222", "333"]));
    });

    it("deduplicates repeated IDs", () => {
      const result = parseAllowedChatIds("111,111,222");
      expect(result).toEqual(new Set(["111", "222"]));
    });
  });

  describe("isChatAllowed", () => {
    it("allows all chats when allowed set is null", () => {
      expect(isChatAllowed("999", null)).toBe(true);
    });

    it("allows chat in the allowed set", () => {
      const allowed = new Set(["111", "222"]);
      expect(isChatAllowed("111", allowed)).toBe(true);
    });

    it("rejects chat not in the allowed set", () => {
      const allowed = new Set(["111", "222"]);
      expect(isChatAllowed("999", allowed)).toBe(false);
    });
  });
});
