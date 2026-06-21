#!/usr/bin/env node
// memharness-doctor: a one-command health check for a memharness install.
// Answers "did my setup actually work?" without trial and error in a chat:
// verifies the native db opens, reports store stats, and says whether hybrid
// recall is genuinely active or just requested. Exits non-zero if something an
// agent relies on is broken (db won't open, or hybrid was asked for but can't
// run), so it can gate CI or an install script.
import { Memharness, resolveDefaultDbPath } from "@memharness/core";

const ok = (s: string): string => `  [ok]   ${s}`;
const warn = (s: string): string => `  [warn] ${s}`;
const bad = (s: string): string => `  [fail] ${s}`;

const lines: string[] = ["memharness doctor"];
let failed = false;

const dbPath = process.env.MEMHARNESS_DB ?? resolveDefaultDbPath();
lines.push(`  db: ${dbPath}`);

// 1. native module loads and the database opens — the one thing that breaks the
//    server outright (e.g. a better-sqlite3 prebuilt missing for this Node/OS).
let mem: Memharness;
try {
  mem = Memharness.open({ dbPath });
  lines.push(ok("native sqlite module loaded, database opens"));
} catch (err) {
  lines.push(bad(`cannot open database: ${err instanceof Error ? err.message : String(err)}`));
  lines.push(
    "         better-sqlite3 may need a prebuilt binary for your Node/OS, or set " +
      "MEMHARNESS_DB to a writable path.",
  );
  process.stdout.write(`${lines.join("\n")}\n\nresult: FAILED\n`);
  process.exit(1);
}

// 2. store stats — proves the schema is current and surfaces an empty store.
const stats = mem.stats();
lines.push(
  ok(
    `schema v${stats.schemaVersion}, ${stats.totalFacts} facts ` +
      `(${stats.currentBeliefs} current beliefs)`,
  ),
);
if (stats.totalFacts === 0) {
  lines.push(
    warn("store is empty: hand the agent a durable fact, then ask it to recall, to confirm the round-trip"),
  );
}

// 3. hybrid (semantic) recall: requested vs actually runnable. Mirrors the
//    server's own gating (MEMHARNESS_HYBRID=1 AND sqlite-vec AND @memharness/embed).
const hybridRequested = process.env.MEMHARNESS_HYBRID === "1";
if (!hybridRequested) {
  lines.push(
    ok("recall: FTS keyword mode (set MEMHARNESS_HYBRID=1 plus @memharness/embed for semantic recall)"),
  );
} else if (!mem.vecEnabled) {
  lines.push(
    warn("MEMHARNESS_HYBRID=1 but sqlite-vec did not load on this platform; recall stays FTS-only"),
  );
} else {
  try {
    await import("@memharness/embed");
    lines.push(ok("recall: hybrid mode (sqlite-vec and @memharness/embed both present)"));
  } catch {
    failed = true;
    lines.push(
      bad("MEMHARNESS_HYBRID=1 and sqlite-vec loaded, but @memharness/embed is not installed: recall is silently FTS-only"),
    );
    lines.push(
      "         install it: npx -y -p @memharness/mcp -p @memharness/embed memharness-mcp",
    );
  }
}

mem.close();
process.stdout.write(`${lines.join("\n")}\n\nresult: ${failed ? "FAILED" : "ok"}\n`);
process.exit(failed ? 1 : 0);
