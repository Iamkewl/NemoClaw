// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  compareVersions,
  getBlueprintMinOpenshellVersion,
  parseOpenshellVersion,
  versionGte,
} from "../../dist/lib/openshell-compat";

describe("lib/openshell-compat", () => {
  it("parses released and dev OpenShell version strings", () => {
    expect(parseOpenshellVersion("openshell 0.1.0")).toBe("0.1.0");
    expect(parseOpenshellVersion("openshell 0.1.1-dev.3+gabcdef")).toBe("0.1.1");
    expect(parseOpenshellVersion("bogus")).toBe(null);
  });

  it("compares semantic versions numerically", () => {
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("0.1.1", "0.1.0")).toBe(1);
    expect(compareVersions("0.0.21", "0.1.0")).toBe(-1);
    expect(versionGte("0.1.0", "0.1.0")).toBe(true);
    expect(versionGte("0.1.1", "0.1.0")).toBe(true);
    expect(versionGte("0.0.21", "0.1.0")).toBe(false);
  });

  it("reads the blueprint minimum OpenShell version", () => {
    expect(getBlueprintMinOpenshellVersion()).toBe("0.1.0");
  });
});
