#!/usr/bin/env node
// Pre-publish release guard.
//
// Why this exists: mcp@0.1.2 shipped compiled code that calls
// Memory.nearDuplicates, but it pinned core@0.1.0 — the only core version ever
// published — which lacks that method. core's source had grown nearDuplicates,
// but core/package.json was never version-bumped, so `pnpm publish` silently
// no-op'd on the already-published core@0.1.0 while mcp shipped against it.
// remember() then threw "mem.nearDuplicates is not a function" at runtime.
//
// This guard makes that class of skew a hard release failure:
//   1. No publishable package may sit at a version that is ALREADY on npm
//      (i.e. "code changed but version not bumped" → republish would no-op).
//   2. All publishable packages must share ONE version (lockstep), so an
//      internal dependency can never lag behind a consumer that needs it.
//
// Private packages (e.g. @memharness/eval) are ignored — they are never
// published.

import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pkgsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "packages");

const publishable = [];
for (const dir of readdirSync(pkgsDir)) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(pkgsDir, dir, "package.json"), "utf8"));
  } catch {
    continue; // not a package dir
  }
  if (pkg.private) continue;
  publishable.push(pkg);
}

const problems = [];

// (2) lockstep
const versions = [...new Set(publishable.map((p) => p.version))];
if (versions.length > 1) {
  problems.push(
    `Publishable packages are not in lockstep: ${publishable
      .map((p) => `${p.name}@${p.version}`)
      .join(", ")}. Run "node scripts/sync-versions.mjs <version>".`,
  );
}

// (1) not-already-published
for (const pkg of publishable) {
  let published = "";
  try {
    published = execFileSync("npm", ["view", `${pkg.name}@${pkg.version}`, "version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // npm exits non-zero when the version does not exist — that is the happy path.
  }
  if (published === pkg.version) {
    problems.push(
      `${pkg.name}@${pkg.version} is already on npm — bump the version before releasing (a republish silently no-ops and ships a stale dependency).`,
    );
  }
}

if (problems.length) {
  console.error("✗ Release guard failed:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}

console.log(
  `✓ Release guard passed: ${publishable
    .map((p) => `${p.name}@${p.version}`)
    .join(", ")} — bumped and in lockstep.`,
);
