<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
# Platform Setup

Some platforms need platform-specific steps before you run the Quickstart (use the `nemoclaw-user-get-started` skill).
If your platform is not listed below, go directly to the Quickstart (use the `nemoclaw-user-get-started` skill).

## Tested Platforms

The following table lists tested platform and runtime combinations.
Availability is not limited to these entries, but untested configurations can have issues.
The table is generated from [`ci/platform-matrix.json`](https://github.com/NVIDIA/NemoClaw/blob/main/ci/platform-matrix.json), the single source of truth kept in sync by CI and QA.

| OS | Container runtime | Status | Notes |
|----|-------------------|--------|-------|
| Linux | Docker | Tested | Primary tested path. |
| macOS (Apple Silicon) | Colima, Docker Desktop | Tested with limitations | Install Xcode Command Line Tools (`xcode-select --install`) and start the runtime before running the installer. |
| DGX Spark | Docker | Tested | Use the standard installer and `nemoclaw onboard`. For an end-to-end walkthrough with local Ollama inference, see the [DGX Spark tutorial](https://docs.nvidia.com/nemoclaw/latest/get-started/tutorials/dgx-spark.html). |
| Windows WSL2 | Docker Desktop (WSL backend) | Tested with limitations | Requires WSL2 with Docker Desktop backend. |

## Platform-Specific Pre-Setup

Not every supported platform needs additional steps before installing NemoClaw.
The table below lists each platform from the matrix above, flags whether you need to complete a platform-specific guide first, and points you to the guide when one exists.
Platforms marked **Not required** have everything they need once Docker is installed and running, so you can go directly to the Quickstart (use the `nemoclaw-user-get-started` skill).
Platforms marked **Required** have a linked guide that walks through the extra steps before the Quickstart.

| Platform | Pre-setup | Guide |
|---|---|---|
| Linux | Not required | None. Proceed to the Quickstart (use the `nemoclaw-user-get-started` skill). |
| macOS (Apple Silicon) | Not required | None. Install Xcode Command Line Tools (`xcode-select --install`), start Colima or Docker Desktop, then proceed to the Quickstart (use the `nemoclaw-user-get-started` skill). |
| DGX Spark | Not required | None. Docker is pre-installed on DGX Spark, so you can go straight to the Quickstart (use the `nemoclaw-user-get-started` skill). For an end-to-end walkthrough that includes local inference with Ollama on the Spark GPU, see the DGX Spark tutorial (use the `nemoclaw-user-tutorial` skill). |
| Windows WSL2 | Required | Windows Prerequisites (use the `nemoclaw-user-platform-setup` skill) covers enabling WSL 2, installing Ubuntu, and configuring Docker Desktop. |

After you finish any platform-specific setup, continue with the Quickstart (use the `nemoclaw-user-get-started` skill).
