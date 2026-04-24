---
title:
  page: "NemoClaw Prerequisites"
  nav: "Prerequisites"
description:
  main: "Hardware, software, and supported platforms for running NemoClaw."
  agent: "Lists the hardware, software, and container runtime requirements for running NemoClaw. Use when verifying prerequisites before installation."
keywords: ["nemoclaw prerequisites", "nemoclaw supported platforms", "nemoclaw hardware software"]
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

# Prerequisites

Before getting started, check the prerequisites to ensure you have the necessary software and hardware to run NemoClaw.

## Hardware

| Resource | Minimum        | Recommended      |
|----------|----------------|------------------|
| CPU      | 4 vCPU         | 4+ vCPU          |
| RAM      | 8 GB           | 16 GB            |
| Disk     | 20 GB free     | 40 GB free       |

The sandbox image is approximately 2.4 GB compressed. During image push, the Docker daemon, k3s, and the OpenShell gateway run alongside the export pipeline. The pipeline buffers decompressed layers in memory. On machines with less than 8 GB of RAM, this combined usage can trigger the OOM killer. If you cannot add memory, configuring at least 8 GB of swap can work around the issue at the cost of slower performance.

## Software

| Dependency | Version                          |
|------------|----------------------------------|
| Node.js    | 22.16 or later |
| npm        | 10 or later |
| Platform   | See [Platform Setup](platform-setup/index.md) |

:::{warning} OpenShell Lifecycle
For NemoClaw-managed environments, use `nemoclaw onboard` when you need to create or recreate the OpenShell gateway or sandbox.
Avoid `openshell self-update`, `npm update -g openshell`, `openshell gateway start --recreate`, or `openshell sandbox create` directly unless you intend to manage OpenShell separately and then rerun `nemoclaw onboard`.
:::

## Supported Platforms

For the list of tested platform and container runtime combinations, and for platform-specific pre-setup steps (Windows, DGX Spark), see [Platform Setup](platform-setup/index.md).

## Next

Once your hardware, software, and platform prerequisites are met, continue with the [Quickstart](quickstart.md).
