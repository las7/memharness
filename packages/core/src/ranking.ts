export interface ScoreInput {
  /** 1-based rank in the FTS BM25 list, or null when there was no text query. */
  ftsRank: number | null;
  confidence: number;
  /** Age of txAt relative to "now", in days. */
  ageDays: number;
}

export interface ResolvedRankingOptions {
  halfLifeDays: number;
  rrfK: number;
}

export const DEFAULT_RANKING: ResolvedRankingOptions = { halfLifeDays: 90, rrfK: 60 };

/**
 * v1 score: RRF over available rank lists (just FTS until vectors land)
 * × confidence × recency decay 0.5^(ageDays/halfLife). Rank-free results
 * (no text query, or LIKE fallback) get an RRF factor of 1.
 */
export function score(input: ScoreInput, opts: ResolvedRankingOptions): number {
  const rrf = input.ftsRank === null ? 1 : 1 / (opts.rrfK + input.ftsRank);
  const decay = 0.5 ** (Math.max(0, input.ageDays) / opts.halfLifeDays);
  return rrf * input.confidence * decay;
}
