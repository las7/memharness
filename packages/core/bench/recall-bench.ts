import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Memharness } from "../src/memory.js";
import type { RecallInput } from "../src/types.js";
import { BENCH_DB, lcg, makeVocabulary, percentile, pickSubject } from "./lib.js";

const ASSERT = process.argv.includes("--assert");
const P95_BUDGET_MS = 10;
const WARMUP = 200;
const ITERATIONS = 1_000;

const mem = Memharness.open({ dbPath: BENCH_DB });
const vocab = makeVocabulary();
const rand = lcg(99);

const word = () => vocab[Math.floor(rand() * vocab.length)]!;
const midHistory = "2025-12-09T00:00:00.000Z";

const shapes: Record<string, () => RecallInput> = {
  "fts two-term": () => ({ query: `${word()} ${word()}` }),
  "fts + subject": () => ({ query: word(), subject: pickSubject(rand) }),
  "subject only": () => ({ subject: pickSubject(rand) }),
  "as_of + fts": () => ({ query: word(), asOf: midHistory }),
};
const shapeNames = Object.keys(shapes);

for (let i = 0; i < WARMUP; i++) {
  mem.recall(shapes[shapeNames[i % shapeNames.length]!]!());
}

const samples: Record<string, number[]> = Object.fromEntries(shapeNames.map((n) => [n, []]));
for (let i = 0; i < ITERATIONS; i++) {
  const name = shapeNames[i % shapeNames.length]!;
  const input = shapes[name]!();
  const t0 = process.hrtime.bigint();
  mem.recall(input);
  samples[name]!.push(Number(process.hrtime.bigint() - t0) / 1e6);
}
mem.close();

const all: number[] = [];
const report: Record<string, { p50: number; p95: number; p99: number; n: number }> = {};
for (const name of shapeNames) {
  const sorted = [...samples[name]!].sort((a, b) => a - b);
  all.push(...sorted);
  report[name] = {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    n: sorted.length,
  };
}
all.sort((a, b) => a - b);
const overall = {
  p50: percentile(all, 50),
  p95: percentile(all, 95),
  p99: percentile(all, 99),
  n: all.length,
};

console.table(
  Object.fromEntries(
    [...Object.entries(report), ["overall", overall] as const].map(([name, r]) => [
      name,
      {
        "p50 ms": r.p50.toFixed(3),
        "p95 ms": r.p95.toFixed(3),
        "p99 ms": r.p99.toFixed(3),
        n: r.n,
      },
    ]),
  ),
);

writeFileSync(
  join(import.meta.dirname, "..", "bench-results.json"),
  JSON.stringify({ shapes: report, overall, db: BENCH_DB, iterations: ITERATIONS }, null, 2),
);

if (ASSERT && overall.p95 >= P95_BUDGET_MS) {
  console.error(`FAIL: overall p95 ${overall.p95.toFixed(3)}ms >= ${P95_BUDGET_MS}ms budget`);
  process.exit(1);
}
console.log(`overall p95 ${overall.p95.toFixed(3)}ms (budget ${P95_BUDGET_MS}ms)`);
