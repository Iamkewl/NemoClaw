// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Warn when compiled `dist/` is older than `src/` in a dev checkout.
// `dist/` is gitignored, so a `git pull` that touches `src/` leaves the old
// compiled output in place — see #1958, where a reverted BASE_IMAGE digest
// patch in stale `dist/lib/onboard.js` produced a cryptic "manifest unknown".
// In published npm installs there is no `src/`, so this no-ops.

const fs = require("fs");
const path = require("path");

const GRACE_MS = 2000;

function maxMtime(root, accept) {
  let newest = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        stack.push(full);
      } else if (entry.isFile() && accept(entry.name)) {
        let stat;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (stat.mtimeMs > newest) newest = stat.mtimeMs;
      }
    }
  }
  return newest;
}

function checkStaleDist(repoRoot) {
  const srcDir = path.join(repoRoot, "src");
  const distDir = path.join(repoRoot, "dist");
  if (!fs.existsSync(srcDir) || !fs.existsSync(distDir)) return null;

  const srcMtime = maxMtime(srcDir, (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
  const distMtime = maxMtime(distDir, (name) => name.endsWith(".js"));
  if (!srcMtime || !distMtime) return null;
  if (srcMtime <= distMtime + GRACE_MS) return null;

  return { srcMtime, distMtime };
}

function warnIfStale(repoRoot, stream = process.stderr) {
  let result;
  try {
    result = checkStaleDist(repoRoot);
  } catch {
    return false;
  }
  if (!result) return false;

  stream.write(
    "Warning: compiled dist/ is older than src/ — you are running stale code.\n" +
      "  Run `npm run build:cli` to rebuild, then retry.\n" +
      "  (dist/ is gitignored, so `git pull` does not update it. See #1958.)\n",
  );
  return true;
}

module.exports = { checkStaleDist, warnIfStale, maxMtime };
