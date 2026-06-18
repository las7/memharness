import type { MemoryKind } from "./types.js";

export interface ScoreInput {
  /** 1-based rank in the FTS BM25 list, or null when there was no text query. */
  ftsRank: number | null;
  /** 1-based rank in the vector-KNN list, or null/undefined when no vector query. */
  vecRank?: number | null;
  confidence: number;
  /** Age of COALESCE(last_accessed_at, txAt) relative to "now", in days. */
  ageDays: number;
  /** Caller-supplied salience, 1..10. 5 = neutral pivot. */
  importance: number;
  kind: MemoryKind;
}

export interface ResolvedRankingOptions {
  /** Base recency-decay half-life in days for 'semantic'. */
  halfLifeDays: number;
  /** Reciprocal-rank-fusion constant. */
  rrfK: number;
  /** Direct ranking-multiplier slope per importance step from 5. */
  importanceWeight: number;
  /** Half-life modulation slope per importance step from 5. */
  importanceHalfLifeWeight: number;
  /** Base half-life per memory kind (semantic falls back to halfLifeDays). */
  kindHalfLifeDays: Record<MemoryKind, number>;
  /**
   * Max candidate rows pulled from each rank list (FTS, vector) before the
   * confidence/importance/decay scoring runs. Rows past this BM25/distance rank
   * have an RRF leg so small they cannot realistically reach the returned top-k,
   * so capping bounds the per-query scoring work (recall stays O(cap), not
   * O(rows-matched)) without measurably changing ranking. Must exceed any
   * realistic `limit`.
   */
  candidateCap: number;
}

export const DEFAULT_RANKING: ResolvedRankingOptions = {
  halfLifeDays: 90,
  rrfK: 60,
  importanceWeight: 0.05,
  importanceHalfLifeWeight: 0.15,
  kindHalfLifeDays: { semantic: 90, episodic: 30, procedural: 180 },
  candidateCap: 256,
};

/** Floor on the importance half-life factor so importance can never make decay non-positive. */
export const MIN_HALFLIFE_FACTOR = 0.05;

/** base(kind) × (1 + importanceHalfLifeWeight·(importance−5)), floored. */
export function effectiveHalfLife(
  opts: ResolvedRankingOptions,
  kind: MemoryKind,
  importance: number,
): number {
  const base = kind === "semantic" ? opts.halfLifeDays : opts.kindHalfLifeDays[kind];
  const factor = Math.max(
    MIN_HALFLIFE_FACTOR,
    1 + opts.importanceHalfLifeWeight * (importance - 5),
  );
  return base * factor;
}

/**
 * score = RRF × confidence × importanceBoost × recency-decay.
 * RRF sums the available rank lists (FTS + vector); rank-free results (no
 * text/vector query, or LIKE fallback) get an RRF factor of 1. importanceBoost
 * = 1 + importanceWeight·(importance−5). Decay is 0.5^(ageDays / effectiveHalfLife),
 * where age is measured from the last access (reinforce-on-access) or, failing
 * that, txAt. This is mirrored bit-for-bit in sql.ts recallQuery — the
 * score-parity test pins the two together.
 */
export function score(input: ScoreInput, opts: ResolvedRankingOptions): number {
  const ftsRrf = input.ftsRank === null ? 0 : 1 / (opts.rrfK + input.ftsRank);
  const vecRrf = input.vecRank == null ? 0 : 1 / (opts.rrfK + input.vecRank);
  const rankFree = input.ftsRank === null && input.vecRank == null;
  const rrf = rankFree ? 1 : ftsRrf + vecRrf;
  const boost = 1 + opts.importanceWeight * (input.importance - 5);
  const decay =
    0.5 ** (Math.max(0, input.ageDays) / effectiveHalfLife(opts, input.kind, input.importance));
  return rrf * input.confidence * boost * decay;
}
