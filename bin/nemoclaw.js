#!/usr/bin/env node
// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const path = require("path");
require("./lib/stale-dist-check").warnIfStale(path.join(__dirname, ".."));
require("../dist/nemoclaw");
