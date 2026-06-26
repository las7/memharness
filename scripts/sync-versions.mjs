#!/usr/bin/env node
// Lockstep version setter: stamp every publishable package with one version.
//
// Usage: node scripts/sync-versions.mjs <version>
//   e.g. node scripts/sync-versions.mjs 0.1.4
//
// Run this before `pnpm release`. The release guard (check-publishable.mjs)
// enforces that the result is in lockstep and not already published.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: node scripts/sync-versions.mjs <semver>  (e.g. 0.1.4)");
  process.exit(1);
}

const pkgsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "packages");
const changed = [];
for (const dir of readdirSync(pkgsDir)) {
  const file = join(pkgsDir, dir, "package.json");
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const pkg = JSON.parse(raw);
  if (pkg.private) continue;
  if (pkg.version === version) continue;
  // Rewrite only the top-level version line to preserve formatting.
  const updated = raw.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
  writeFileSync(file, updated);
  changed.push(`${pkg.name}: ${pkg.version} -> ${version}`);
}

if (!changed.length) {
  console.log(`All publishable packages already at ${version}.`);
} else {
  console.log("Set lockstep version " + version + ":");
  for (const c of changed) console.log("  " + c);
}
