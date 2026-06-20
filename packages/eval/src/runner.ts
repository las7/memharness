import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FakeClock, Memharness, type RankingOptions } from "@memharness/core";
import { DATASET } from "./dataset.js";
import { type Embedder, realEmbedder, syntheticEmbedder } from "./embedder.js";
import type { Category, Dataset } from "./types.js";

type Retrieval = "fts" | "vector" | "hybrid";
interface Config {
  name: string;
  retrieval: Retrieval;
  importance: boolean;
  reinforce: boolean;
  /** Whether source-staleness demotion is active (ablation arm turns it off). */
  stale: boolean;
}

const CONFIGS: Config[] = [
  { name: "fts", retrieval: "fts", importance: true, reinforce: true, stale: true },
  { name: "vector", retrieval: "vector", importance: true, reinforce: true, stale: true },
  { name: "hybrid", retrieval: "hybrid", importance: true, reinforce: true, stale: true },
  { name: "hybrid-noImp", retrieval: "hybrid", importance: false, reinforce: true, stale: true },
  { name: "hybrid-noReinf", retrieval: "hybrid", importance: true, reinforce: false, stale: true },
  { name: "hybrid-noStale", retrieval: "hybrid", importance: true, reinforce: true, stale: false },
];

/** Clock at which probes are evaluated — after every event has landed. */
const EVAL_NOW = "2026-06-02T00:00:00.000Z";

export interface ProbeOutcome {
  config: string;
  category: Category;
  name: string;
  /** recall@k: any gold id in the returned top-k. */
  hit: boolean;
  /** Reciprocal rank of the FIRST gold id (1/rank), 0 if none in top-k. */
  rr: number;
  /** NDCG@k with binary relevance — rewards ranking gold ABOVE distractors, not just presence. */
  ndcg: number;
}

export interface EvalResult {
  embedder: "synthetic" | "real";
  outcomes: ProbeOutcome[];
  /** config → category → hit-rate. */
  byConfigCategory: Record<string, Partial<Record<Category, number>>>;
  byConfigOverall: Record<string, number>;
  /** config → mean reciprocal rank (ordering quality, not just presence). */
  byConfigMRR: Record<string, number>;
  /** config → mean NDCG@k. */
  byConfigNDCG: Record<string, number>;
}

/** Reciprocal rank and NDCG@k for one probe, binary relevance. */
function rankMetrics(ids: number[], gold: number[], k: number): { rr: number; ndcg: number } {
  const goldSet = new Set(gold);
  let rr = 0;
  let dcg = 0;
  for (let i = 0; i < Math.min(ids.length, k); i++) {
    if (goldSet.has(ids[i] as number)) {
      const gain = 1 / Math.log2(i + 2);
      dcg += gain;
      if (rr === 0) rr = 1 / (i + 1);
    }
  }
  let idcg = 0;
  for (let i = 0; i < Math.min(gold.length, k); i++) idcg += 1 / Math.log2(i + 2);
  return { rr, ndcg: idcg > 0 ? dcg / idcg : 0 };
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Embed each fact and probe query once; reused across config arms. */
async function buildVectorCache(dataset: Dataset, embedder: Embedder) {
  const docTexts = new Map<string, string>(); // eventId -> "subject: fact"
  for (const e of dataset.events) {
    if (e.op === "remember") docTexts.set(e.id, `${e.subject}: ${e.fact}`);
    if (e.op === "revise") docTexts.set(e.id, e.fact);
  }
  const queryTexts = [
    ...new Set(dataset.probes.map((p) => p.query).filter((q): q is string => !!q)),
  ];
  const docKeys = [...docTexts.keys()];
  const docVecs = await embedder.documents(docKeys.map((k) => docTexts.get(k) as string));
  const docByEventId = new Map(docKeys.map((k, i) => [k, docVecs[i] as Float32Array]));
  const queryVecs = new Map(
    await Promise.all(queryTexts.map(async (q) => [q, await embedder.query(q)] as const)),
  );
  return { docByEventId, queryVecs };
}

/**
 * Ranking options for one config arm, starting from an optional `base` (the value
 * a parameter sweep is probing) and then applying the arm's ablations on top.
 */
function rankingFor(cfg: Config, base?: RankingOptions): RankingOptions | undefined {
  const r: RankingOptions = { ...base };
  if (!cfg.importance) {
    r.importanceWeight = 0;
    r.importanceHalfLifeWeight = 0;
  }
  if (!cfg.stale) {
    // Neutralize source-staleness demotion for the ablation arm.
    r.staleWeight = 1;
    r.unresolvedWeight = 1;
  }
  return Object.keys(r).length > 0 ? r : undefined;
}

/** Replay the dataset into a fresh in-memory db; return the id map. */
function replay(
  dataset: Dataset,
  cfg: Config,
  docByEventId: Map<string, Float32Array>,
  base?: RankingOptions,
): { mem: Memharness; idMap: Map<string, number> } {
  const clock = new FakeClock(dataset.epoch, 0);
  const mem = Memharness.open({ dbPath: ":memory:", clock, ranking: rankingFor(cfg, base) });
  const idMap = new Map<string, number>();
  let cursor = Date.parse(dataset.epoch);
  const advanceTo = (at: string) => {
    const t = Date.parse(at);
    if (t > cursor) {
      clock.advance(t - cursor);
      cursor = t;
    }
  };
  // advanceTo only moves forward, so events must be replayed in time order. Sort
  // by timestamp (stable for ties) so the dataset can list events grouped by
  // scenario rather than strictly interleaved by clock.
  const events = [...dataset.events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const e of events) {
    advanceTo(e.at);
    if (e.op === "remember") {
      idMap.set(e.id, mem.remember(e).id);
    } else if (e.op === "revise") {
      const oldId = idMap.get(e.target);
      if (oldId === undefined) throw new Error(`revise target ${e.target} not seen`);
      idMap.set(
        e.id,
        mem.revise({ oldFactId: oldId, newFact: e.fact, importance: e.importance }).newId,
      );
    } else if (e.op === "forget") {
      const id = idMap.get(e.target);
      if (id !== undefined) mem.forget({ factId: id });
    } else if (e.op === "stale") {
      const id = idMap.get(e.target);
      if (id === undefined) throw new Error(`stale target ${e.target} not seen`);
      mem.setStaleness(id, {
        freshness: e.freshness ?? "stale",
        checkedAt: e.at,
        checkedHead: "evalhead",
      });
    } else if (e.op === "access" && cfg.reinforce) {
      mem.recall({ subject: e.subject, query: e.query });
    }
  }
  // attach embeddings to every created fact
  for (const [eventId, id] of idMap) {
    const vec = docByEventId.get(eventId);
    if (vec) mem.setEmbedding(id, vec, "eval");
  }
  // park the clock at evaluation time
  advanceTo(EVAL_NOW);
  return { mem, idMap };
}

export async function runEval(
  opts: { real?: boolean; ranking?: RankingOptions } = {},
): Promise<EvalResult> {
  const embedder = opts.real ? await realEmbedder() : syntheticEmbedder();
  const { docByEventId, queryVecs } = await buildVectorCache(DATASET, embedder);
  const outcomes: ProbeOutcome[] = [];

  for (const cfg of CONFIGS) {
    const { mem, idMap } = replay(DATASET, cfg, docByEventId, opts.ranking);
    for (const p of DATASET.probes) {
      const gold = p.gold.map((g) => idMap.get(g)).filter((x): x is number => x !== undefined);
      const input: Parameters<Memharness["recall"]>[0] = {
        subject: p.subject,
        kind: p.kind,
        asOf: p.asOf,
        limit: p.k,
      };
      if (p.query) {
        const qv = queryVecs.get(p.query);
        if (cfg.retrieval !== "vector") input.query = p.query;
        if (cfg.retrieval !== "fts") input.queryVector = qv;
      }
      const ids = mem.recall(input).facts.map((f) => f.id);
      const { rr, ndcg } = rankMetrics(ids, gold, p.k);
      outcomes.push({
        config: cfg.name,
        category: p.category,
        name: p.name,
        hit: gold.some((g) => ids.includes(g)),
        rr,
        ndcg,
      });
    }
    mem.close();
  }

  // aggregate
  const byConfigCategory: Record<string, Partial<Record<Category, number>>> = {};
  const byConfigOverall: Record<string, number> = {};
  const byConfigMRR: Record<string, number> = {};
  const byConfigNDCG: Record<string, number> = {};
  for (const cfg of CONFIGS) {
    const rows = outcomes.filter((o) => o.config === cfg.name);
    byConfigOverall[cfg.name] = rows.filter((r) => r.hit).length / rows.length;
    byConfigMRR[cfg.name] = mean(rows.map((r) => r.rr));
    byConfigNDCG[cfg.name] = mean(rows.map((r) => r.ndcg));
    const cats = [...new Set(rows.map((r) => r.category))];
    const catMap: Partial<Record<Category, number>> = {};
    for (const cat of cats) {
      const cr = rows.filter((r) => r.category === cat);
      catMap[cat] = cr.filter((r) => r.hit).length / cr.length;
    }
    byConfigCategory[cfg.name] = catMap;
  }
  return {
    embedder: opts.real ? "real" : "synthetic",
    outcomes,
    byConfigCategory,
    byConfigOverall,
    byConfigMRR,
    byConfigNDCG,
  };
}

async function main() {
  const real = process.argv.includes("--real");
  if (process.argv.includes("--judge")) {
    process.stderr.write(
      "note: --judge (LLM answer grading) is not implemented; scoring recall@k.\n",
    );
  }
  const result = await runEval({ real });
  const table = Object.fromEntries(
    Object.entries(result.byConfigCategory).map(([cfg, cats]) => [
      cfg,
      { ...cats, OVERALL: result.byConfigOverall[cfg] },
    ]),
  );
  process.stderr.write(`\nmemharness recall@k by category (embedder: ${result.embedder})\n`);
  console.table(table);
  const summary = Object.fromEntries(
    Object.keys(result.byConfigOverall).map((cfg) => [
      cfg,
      {
        "recall@k": Number(result.byConfigOverall[cfg]?.toFixed(3)),
        MRR: Number(result.byConfigMRR[cfg]?.toFixed(3)),
        "NDCG@k": Number(result.byConfigNDCG[cfg]?.toFixed(3)),
      },
    ]),
  );
  process.stderr.write("\nordering quality (MRR / NDCG@k reward ranking gold above distractors)\n");
  console.table(summary);
  if (!real) {
    process.stderr.write(
      "note: synthetic embedder is lexical-only — paraphrase needs --real (downloads the model once).\n",
    );
  }
  const out = fileURLToPath(new URL("../eval-results.json", import.meta.url));
  writeFileSync(out, JSON.stringify(result, null, 2));
  process.stderr.write(`wrote ${out}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
