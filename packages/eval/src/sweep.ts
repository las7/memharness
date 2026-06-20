// memharness parameter sweep — calibrate the ranking constants (staleWeight,
// importanceWeight, half-life, rrfK) against the probe suite instead of guessing.
// For each parameter value it replays the whole dataset and reports the canonical
// full-feature arm ("hybrid"): overall recall@k, MRR, NDCG@k, plus the per-category
// hit-rates that the parameter is expected to move. Synthetic embedder by default
// (fast, offline); --real swaps in the model for the paraphrase probe.
//
// Usage: node --import tsx src/sweep.ts [--real]
import type { RankingOptions } from "@memharness/core";
import { runEval } from "./runner.js";

/** The arm we tune: all features on. Ablation arms exist only to prove a feature. */
const ARM = "hybrid";

const r3 = (x: number | undefined) => (x === undefined ? null : Number(x.toFixed(3)));

/** Canonical-arm metrics for one ranking override. */
async function evalRow(ranking: RankingOptions, real: boolean) {
  const res = await runEval({ ranking, real });
  const cat = res.byConfigCategory[ARM] ?? {};
  return {
    "recall@k": r3(res.byConfigOverall[ARM]),
    MRR: r3(res.byConfigMRR[ARM]),
    "NDCG@k": r3(res.byConfigNDCG[ARM]),
    staleness: cat.staleness ?? null,
    importance: cat.importance ?? null,
    reinforce: cat.reinforce ?? null,
  };
}

/** One-parameter sweep: vary `param` over `values`, hold everything else at default. */
async function sweep1D(param: keyof RankingOptions, values: number[], real: boolean) {
  const table: Record<string, unknown> = {};
  for (const v of values) {
    table[String(v)] = await evalRow({ [param]: v } as RankingOptions, real);
  }
  process.stderr.write(`\nsweep: ${param} (rows = value)\n`);
  console.table(table);
}

/** Two-parameter grid over the coupled pair that drives the staleness probe. */
async function sweep2D(
  pa: keyof RankingOptions,
  va: number[],
  pb: keyof RankingOptions,
  vb: number[],
  real: boolean,
) {
  const table: Record<string, unknown> = {};
  for (const a of va) {
    for (const b of vb) {
      const res = await runEval({ ranking: { [pa]: a, [pb]: b } as RankingOptions, real });
      table[`${pa}=${a}, ${pb}=${b}`] = {
        "recall@k": r3(res.byConfigOverall[ARM]),
        MRR: r3(res.byConfigMRR[ARM]),
        "NDCG@k": r3(res.byConfigNDCG[ARM]),
        staleness: res.byConfigCategory[ARM]?.staleness ?? null,
        importance: res.byConfigCategory[ARM]?.importance ?? null,
      };
    }
  }
  process.stderr.write(`\nsweep grid: ${pa} × ${pb}\n`);
  console.table(table);
}

async function main() {
  const real = process.argv.includes("--real");
  process.stderr.write(
    `memharness parameter sweep (arm: ${ARM}, embedder: ${real ? "real" : "synthetic"})\n`,
  );
  await sweep1D("staleWeight", [0.2, 0.35, 0.5, 0.65, 0.85, 1.0], real);
  await sweep1D("importanceWeight", [0, 0.02, 0.05, 0.1, 0.2], real);
  await sweep1D("halfLifeDays", [30, 60, 90, 180, 365], real);
  await sweep1D("rrfK", [10, 30, 60, 100], real);
  await sweep2D("staleWeight", [0.3, 0.5, 0.7, 1.0], "importanceWeight", [0.05, 0.1, 0.2], real);
  if (!real) {
    process.stderr.write(
      "\nnote: synthetic embedder is lexical-only — paraphrase scores need --real.\n" +
        "note: dedup minSimilarity is a WRITE-path advisory threshold, not measured by this " +
        "retrieval suite; calibrate it against labeled duplicate/not-duplicate pairs.\n",
    );
  }
}

await main();
