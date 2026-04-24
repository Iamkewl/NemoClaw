---
title:
  page: "NemoClaw Platform Setup"
  nav: "Platform Setup"
description:
  main: "Platform-specific setup steps to complete before running the NemoClaw Quickstart."
  agent: "Hub page listing platform-specific pre-setup guides for NemoClaw. Use when determining whether a platform needs extra setup before the Quickstart."
keywords: ["nemoclaw platform setup", "nemoclaw prerequisites per platform", "nemoclaw windows setup", "nemoclaw dgx spark setup"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "sandboxing", "nemoclaw"]
content:
  type: reference
  difficulty: technical_beginner
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Platform Setup

Some platforms need platform-specific steps before you run the [Quickstart](../quickstart.md).
If your platform is not listed below, go directly to the [Quickstart](../quickstart.md).

## Tested Platforms

The following table lists tested platform and runtime combinations.
Availability is not limited to these entries, but untested configurations can have issues.
The table is generated from [`ci/platform-matrix.json`](https://github.com/NVIDIA/NemoClaw/blob/main/ci/platform-matrix.json), the single source of truth kept in sync by CI and QA.

```{include} ../../../README.md
:start-after: <!-- platform-matrix:begin -->
:end-before: <!-- platform-matrix:end -->
```

## Platform-Specific Pre-Setup

Not every supported platform needs additional steps before installing NemoClaw.
The table below lists each platform from the matrix above, flags whether you need to complete a platform-specific guide first, and points you to the guide when one exists.
Platforms marked **Not required** have everything they need once Docker is installed and running, so you can go directly to the [Quickstart](../quickstart.md).
Platforms marked **Required** have a linked guide that walks through the extra steps before the Quickstart.

| Platform | Pre-setup | Guide |
|---|---|---|
| Linux | Not required | None. Proceed to the [Quickstart](../quickstart.md). |
| macOS (Apple Silicon) | Not required | None. Install Xcode Command Line Tools (`xcode-select --install`), start Colima or Docker Desktop, then proceed to the [Quickstart](../quickstart.md). |
| DGX Spark | Not required | None. Docker is pre-installed on DGX Spark, so you can go straight to the [Quickstart](../quickstart.md). For an end-to-end walkthrough that includes local inference with Ollama on the Spark GPU, see the [DGX Spark tutorial](../tutorials/dgx-spark.md). |
| Windows WSL2 | Required | [Windows Prerequisites](windows.md) covers enabling WSL 2, installing Ubuntu, and configuring Docker Desktop. |

After you finish any platform-specific setup, continue with the [Quickstart](../quickstart.md).

```{toctree}
:maxdepth: 1
:hidden:

windows
```
