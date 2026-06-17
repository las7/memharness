#!/usr/bin/env node
// memharness memory gardener — a local hygiene pass over the belief set.
// Read-only. Prints a short advisory ONLY when something needs attention, so it
// can be wired into a SessionStart hook without adding noise. Catches the two
// failure modes found dogfooding (2026-06-16):
//   1. subject fragmentation (e.g. project:tako / project:tako-vm / project:TakoVM)
//   2. code-map bloat (facts an Explore agent could reconstruct from the repo)
// The staleness check (Phase 2 `memharness-staleness`) joins this once it exists.
//
// Resolves better-sqlite3 from @memharness/core's deps, so run with node from
// anywhere: `node packages/core/scripts/memory-gardener.mjs`.

import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dbPath = process.env.MEMHARNESS_DB || join(homedir(), ".memharness", "memory.db");

let db;
try {
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
} catch {
  // No store yet (or unreadable) — nothing to garden, stay silent.
  process.exit(0);
}

// Detect whether the source-staleness columns exist (m005+). Older v4 DBs won't.
const cols = new Set(
  db
    .prepare("PRAGMA table_info(facts)")
    .all()
    .map((c) => c.name),
);
const hasPin = cols.has("source_commit");

const now = new Date().toISOString();
const rows = db
  .prepare(
    `SELECT id, subject, fact${hasPin ? ", source_commit" : ""}
       FROM facts
      WHERE retracted_at IS NULL
        AND superseded_by IS NULL
        AND valid_from <= ?
        AND (valid_to IS NULL OR valid_to > ?)`,
  )
  .all(now, now);
db.close();

// --- 1. Subject fragmentation -------------------------------------------------
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const byNorm = new Map();
for (const r of rows) {
  const key = norm(r.subject);
  if (!byNorm.has(key)) byNorm.set(key, new Map());
  const m = byNorm.get(key);
  m.set(r.subject, (m.get(r.subject) || 0) + 1);
}
const fragmented = [...byNorm.values()].filter((m) => m.size > 1);

// --- 2. Code-map smell --------------------------------------------------------
// A "path" is a real file reference: a token ending in a source extension, or a
// genuine multi-segment path (>=2 slashes). A single "a/b" (an "or", an org/repo
// slug) does NOT count — that was inflating the score on prose and identities.
const PATH_RE =
  /\b[\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|rb|sql|ya?ml|json|sh|md)\b|\b[\w-]+\/[\w-]+\/[\w./-]+/g;
// A code MAP (derivable, prunable) differs from an audit FINDING / decision
// (not derivable) by whether it records a judgment or event — not by how many
// paths it cites. Suppress facts carrying those markers so the hook stays quiet
// on keepers (audits, decisions, gotchas, PR/dated events).
// No trailing \b — let stems match suffixes (decision→decisions, gotcha→gotchas,
// drift→drifted, violat→violates/violation).
const FINDING_RE =
  /\b(?:decision|decided|violat|gotcha|drift|merged|removed|deprecat|fix candidate|known failure|audit|contradict|abandon|rationale|undocumented|orphan|resolution status|not implemented|not yet|escapable|trade-?off|\bbug|\brisk|prefer|incident|regression)|#\d+|\d{4}-\d{2}-\d{2}/i;
function looksLikeCodeMap(text) {
  if (text.length < 200) return false;
  if (FINDING_RE.test(text)) return false;
  // Require genuine path density — the signal that says "structural code map",
  // not just prose that happens to mention one file or a dotted name.
  return new Set(text.match(PATH_RE) || []).size >= 3;
}
const smelly = rows.filter(
  (r) =>
    r.subject.startsWith("project:") &&
    (!hasPin || r.source_commit == null) &&
    looksLikeCodeMap(r.fact),
);

// --- Report (only if something to say) ---------------------------------------
if (fragmented.length === 0 && smelly.length === 0) process.exit(0);

const out = ["memharness gardener — memory hygiene flags:"];
if (fragmented.length) {
  out.push("\n  Subject fragmentation (same project under multiple keys — consolidate to one):");
  for (const m of fragmented) {
    out.push(`    - ${[...m.entries()].map(([s, n]) => `${s} (${n})`).join("  vs  ")}`);
  }
}
if (smelly.length) {
  out.push(
    `\n  ${smelly.length} fact(s) read like a code-map an Explore agent could re-derive (consider prune/split, or pin with source_commit):`,
  );
  for (const r of smelly.slice(0, 12)) {
    out.push(`    - #${r.id} [${r.subject}] ${r.fact.slice(0, 70).replace(/\s+/g, " ")}…`);
  }
  if (smelly.length > 12) out.push(`    …and ${smelly.length - 12} more`);
}
out.push("\n  (Ask Claude to review and clean these up when convenient.)");
console.log(out.join("\n"));
process.exit(0);
