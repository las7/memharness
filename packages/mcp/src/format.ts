import type { DiffResult, Fact, RecallResult, StatsResult, WhyResult } from "@memharness/core";

/** One-line fact rendering, byte-compatible with the Python prototype's fmt(). */
export function fmtFact(f: Fact, showTime = false): string {
  const parts = [`[#${f.id}] ${f.subject}`];
  if (f.predicate) parts.push(`(${f.predicate})`);
  parts.push(`: ${f.fact}`);
  const meta = [`conf=${f.confidence.toFixed(2)}`, `src=${f.sourceAgent || "unknown"}`];
  if (f.sourceRef) meta.push(`ref=${f.sourceRef}`);
  if (f.importance !== 5) meta.push(`imp=${f.importance}`);
  if (f.kind !== "semantic") meta.push(`kind=${f.kind}`);
  if (showTime) {
    meta.push(`valid ${f.validFrom.slice(0, 10)} → ${f.validTo ? f.validTo.slice(0, 10) : "now"}`);
    meta.push(`learned ${f.txAt.slice(0, 10)}`);
  }
  if (f.supersededBy !== null) meta.push(`superseded_by=#${f.supersededBy}`);
  if (f.retractedAt !== null) meta.push("RETRACTED");
  return `${parts.join(" ")}  {${meta.join(", ")}}`;
}

export function fmtRecall(r: RecallResult): string {
  if (r.facts.length === 0) {
    return `No matching memories.${r.asOf ? ` (as of ${r.asOf})` : ""}`;
  }
  const header = r.asOf ? `Beliefs as of ${r.asOf}:` : "Current beliefs:";
  const lines = r.facts.map((f) => fmtFact(f, r.asOf !== null));
  const notes: string[] = [];
  if (r.truncated) notes.push("(truncated to fit the token budget)");
  return [header, ...lines, ...notes].join("\n");
}

export function fmtDiff(d: DiffResult): string {
  const out = [`Memory changes since ${d.since}:`];
  out.push(`\nLEARNED (${d.learned.length}):`);
  if (d.learned.length > 0) out.push(...d.learned.map((f) => `  ${fmtFact(f)}`));
  else out.push("  (none)");
  out.push(`\nREVISED (${d.revised.length}):`);
  for (const r of d.revised) {
    out.push(`  was: ${fmtFact(r.old)}`);
    out.push(r.new ? `  now: ${fmtFact(r.new)}` : "  now: (missing)");
  }
  if (d.revised.length === 0) out.push("  (none)");
  out.push(`\nRETRACTED (${d.retracted.length}):`);
  if (d.retracted.length > 0) out.push(...d.retracted.map((f) => `  ${fmtFact(f)}`));
  else out.push("  (none)");
  return out.join("\n");
}

export function fmtWhy(w: WhyResult): string {
  const out = [fmtFact(w.fact, true)];
  for (const a of w.ancestors) out.push(`  superseded ← ${fmtFact(a, true)}`);
  for (const d of w.descendants) out.push(`  revised → ${fmtFact(d, true)}`);
  return out.join("\n");
}

export function fmtStats(s: StatsResult): string {
  const out = [
    `DB: ${s.dbPath}`,
    `Total facts ever: ${s.totalFacts}`,
    `Current beliefs: ${s.currentBeliefs}`,
    "Top subjects:",
  ];
  out.push(...s.topSubjects.map((t) => `  ${t.subject}: ${t.count}`));
  return out.join("\n");
}
