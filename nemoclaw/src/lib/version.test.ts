// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getVersion } from "../../dist/lib/version.js";

const store = new Map<string, string>();

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    readFileSync: (p: string, _enc: string) => {
      const content = store.get(p);
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
  };
});

describe("lib/version", () => {
  beforeEach(() => {
    store.clear();
  });

  it("reads version from package.json", () => {
    store.set("/test-dir/package.json", JSON.stringify({ version: "1.2.3" }));
    const info = getVersion({ packageDir: "/test-dir", gitDescribeResult: null });
    expect(info.version).toBe("1.2.3");
    expect(info.gitDescribe).toBeNull();
    expect(info.display).toBe("1.2.3");
  });

  it("includes git describe when available", () => {
    store.set("/test-dir/package.json", JSON.stringify({ version: "1.2.3" }));
    const info = getVersion({ packageDir: "/test-dir", gitDescribeResult: "v1.2.3-5-gabcdef" });
    expect(info.version).toBe("1.2.3");
    expect(info.gitDescribe).toBe("v1.2.3-5-gabcdef");
    expect(info.display).toBe("1.2.3 (v1.2.3-5-gabcdef)");
  });

  it("handles dirty git state", () => {
    store.set("/test-dir/package.json", JSON.stringify({ version: "0.1.0" }));
    const info = getVersion({ packageDir: "/test-dir", gitDescribeResult: "v0.1.0-dirty" });
    expect(info.display).toBe("0.1.0 (v0.1.0-dirty)");
  });

  it("returns version without suffix when gitDescribe is null", () => {
    store.set("/test-dir/package.json", JSON.stringify({ version: "2.0.0" }));
    const info = getVersion({ packageDir: "/test-dir", gitDescribeResult: null });
    expect(info.display).toBe("2.0.0");
  });
});
