---
name: "nemoclaw-user-tutorial"
description: "End-to-end tutorial for running NemoClaw on NVIDIA DGX Spark (aarch64, Ubuntu 24.04). Use when installing NemoClaw on a DGX Spark, configuring local inference with Ollama on the Spark GPU, or troubleshooting Spark-specific issues. Trigger keywords - nemoclaw dgx spark tutorial, nemoclaw spark install, nemoclaw ollama spark."
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Tutorial: NemoClaw on DGX Spark

## Prerequisites

This tutorial assumes you have already completed the Quickstart (use the `nemoclaw-user-get-started` skill) and have a working NemoClaw sandbox running on your DGX Spark. Confirm your environment meets the general Prerequisites (use the `nemoclaw-user-get-started` skill) before continuing.

- NVIDIA DGX Spark hardware with aarch64 (Grace CPU + GB10 GPU) running Ubuntu 24.04. The instructions here are written for this platform and assume cgroup v2 defaults.
- NVIDIA Container Toolkit configured for Docker so the GPU is usable from containers. You will verify this in the first step of the procedure below.
- Sufficient disk and unified memory for the Ollama model you plan to pull. For example, Nemotron 3 Super 120B needs roughly 87 GB of free disk and comparable unified memory to pre-load weights.

This tutorial shows you how to set up NemoClaw with Ollama on an NVIDIA DGX Spark. By the end, your NemoClaw sandbox routes inference to a local Ollama server running on the Spark GPU instead of a cloud provider.

DGX Spark ships with Ubuntu 24.04 and Docker pre-installed, so no extra pre-setup is required before the standard installer. Refer to Platform Setup (use the `nemoclaw-user-platform-setup` skill) for the full pre-setup matrix across platforms.

## Step 1: How NemoClaw Runs on DGX Spark

Before you start, it helps to see where each piece runs. On DGX Spark, NemoClaw is layered as follows.

```text
DGX Spark (Ubuntu 24.04, aarch64, cgroup v2, 128 GB unified memory)
  └── Docker (28.x/29.x)
       └── OpenShell gateway container
            └── k3s (embedded)
                 └── nemoclaw sandbox pod
                      └── OpenClaw agent + NemoClaw plugin
```

Two things fall out of this picture, and they shape what you do later in the procedure.

- Ollama runs on the host, not inside the sandbox. Your agent lives inside the sandbox pod, so its inference traffic has to cross the gateway container to reach Ollama on the host. That is why step 4 binds Ollama to `0.0.0.0` instead of leaving it on the host loopback.
- The sandbox reaches Ollama at `inference.local`, the hostname the gateway publishes for the configured inference provider. In step 6 you test against that hostname rather than calling `localhost` from inside the container.

For the deployment topology diagram across all platforms, and how this Spark layering maps to them, refer to the deployment topology section in the Architecture reference (use the `nemoclaw-user-reference` skill).

## Step 2: Procedure

Complete the following steps in order. Each step builds on the one before it.

1. Verify the NVIDIA Container Runtime. Confirm Docker can use the Spark GPU from inside a container.

   ```bash
   docker run --rm --runtime=nvidia --gpus all nvidia/cuda:12.8.0-base-ubuntu24.04 nvidia-smi
   ```

   If this fails, configure the NVIDIA runtime and restart Docker, then re-run the check.

   ```bash
   sudo nvidia-ctk runtime configure --runtime=docker
   sudo systemctl restart docker
   ```

2. Install Ollama on the host.

   ```bash
   curl -fsSL https://ollama.com/install.sh | sh
   ```

   Verify that the server is running.

   ```bash
   curl http://localhost:11434
   ```

3. Pull and pre-load the model. Download Nemotron 3 Super 120B. The model is roughly 87 GB, so expect the pull to take several minutes.

   ```bash
   ollama pull nemotron-3-super:120b
   ```

   Run it briefly to pre-load weights into unified memory, then exit with `/bye`.

   ```bash
   ollama run nemotron-3-super:120b
   ```

4. Configure Ollama to listen on all interfaces. By default Ollama binds to `127.0.0.1`, which is not reachable from inside the sandbox container. Drop in a systemd override.

   ```bash
   sudo mkdir -p /etc/systemd/system/ollama.service.d
   printf '[Service]\nEnvironment="OLLAMA_HOST=0.0.0.0"\n' | sudo tee /etc/systemd/system/ollama.service.d/override.conf

   sudo systemctl daemon-reload
   sudo systemctl restart ollama
   ```

   Verify Ollama is now listening on all interfaces.

   ```bash
   sudo ss -tlnp | grep 11434
   ```

   :::{note}
   `OLLAMA_HOST=0.0.0.0` exposes Ollama on your network. If you are not on a trusted LAN, restrict access with host firewall rules (`ufw`, `iptables`, etc.).
   :::

5. Point your NemoClaw sandbox at Local Ollama. How you do this depends on which provider you picked during the Quickstart (use the `nemoclaw-user-get-started` skill).

   - If you picked Local Ollama during the Quickstart, no re-onboarding is needed. Continue to the next step.
   - If you picked a cloud provider and want to change the active model without rebuilding the sandbox, refer to Switch inference providers (use the `nemoclaw-user-configure-inference` skill). The command is shown below.

     ```bash
     openshell inference set -g nemoclaw --model <model> --provider ollama
     ```

   - If you want to re-run onboarding from scratch and pick Local Ollama in the wizard, uninstall and reinstall.

     ```bash
     nemoclaw uninstall
     curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
     ```

     When prompted for Inference options, select Local Ollama, then select the model you pulled in step 3.

6. Connect to the sandbox and test. Open a shell in the sandbox.

   ```bash
   nemoclaw my-assistant connect
   ```

   From inside the sandbox, confirm that `inference.local` is reachable over HTTPS. The proxy intercepts `CONNECT inference.local:443`.

   ```bash
   curl -sf https://inference.local/v1/models
   # Expected response is JSON listing the configured model.
   # A non-zero exit (403, 503, and similar) indicates a proxy routing regression.
   ```

   Then talk to the agent and confirm it is using the Spark GPU.

   ```bash
   openclaw agent --agent main --local -m "Which model and GPU are in use?" --session-id test
   ```

## Related Skills

- `nemoclaw-user-reference` — If something goes wrong, refer to the DGX Spark section (use the `nemoclaw-user-reference` skill) of the Troubleshooting reference. It covers Spark-specific issues such as CoreDNS crashes, `k3s` image pull failure, GPU passthrough, `pip install` system-packages errors, and the AI Workbench port 3000 conflict
- NIM compatibility on arm64. Some NIM containers (for example Nemotron-3-Super-120B-A12B) ship native arm64 images and run on Spark. Many NIM images are amd64-only and fail with `exec format error`. Check the image architecture before pulling. For models without arm64 NIM support, continue using Ollama or try [llama.cpp](https://github.com/ggml-org/llama.cpp) with GGUF models.
- `nemoclaw-user-configure-inference` — Try other local inference backends. Use a Local Inference Server (use the `nemoclaw-user-configure-inference` skill) covers vLLM, NIM, and OpenAI-compatible endpoints generically, not Spark-specific
