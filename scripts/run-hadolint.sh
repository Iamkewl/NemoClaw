#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

readonly HADOLINT_IMAGE="${HADOLINT_IMAGE:-hadolint/hadolint:v2.14.0}"

run_via_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    printf '%s\n' "hadolint is not installed and Docker is unavailable." >&2
    printf '%s\n' "Install hadolint locally or make Docker available, then rerun prek." >&2
    return 127
  fi

  if ! docker info >/dev/null 2>&1; then
    printf '%s\n' "hadolint is not installed and Docker is not ready." >&2
    printf '%s\n' "Start Docker or install hadolint locally, then rerun prek." >&2
    return 1
  fi

  printf '%s\n' "hadolint not found on PATH; linting Dockerfiles via Docker image ${HADOLINT_IMAGE}" >&2

  exec docker run --rm \
    -v "${PWD}:${PWD}" \
    -w "${PWD}" \
    "${HADOLINT_IMAGE}" \
    hadolint "$@"
}

main() {
  if command -v hadolint >/dev/null 2>&1; then
    exec hadolint "$@"
  fi

  run_via_docker "$@"
}

main "$@"
