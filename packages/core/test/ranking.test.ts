import { describe, expect, it } from "vitest";
import { DEFAULT_RANKING, score } from "../src/ranking.js";

describe("score", () => {
  it("halves the score at exactly halfLifeDays of age", () => {
    const fresh = score({ ftsRank: null, confidence: 1, ageDays: 0 }, DEFAULT_RANKING);
    const stale = score(
      { ftsRank: null, confidence: 1, ageDays: DEFAULT_RANKING.halfLifeDays },
      DEFAULT_RANKING,
    );
    expect(stale).toBeCloseTo(fresh / 2, 10);
  });

  it("scales linearly with confidence", () => {
    const full = score({ ftsRank: 1, confidence: 1, ageDays: 0 }, DEFAULT_RANKING);
    const half = score({ ftsRank: 1, confidence: 0.5, ageDays: 0 }, DEFAULT_RANKING);
    expect(half).toBeCloseTo(full / 2, 10);
  });

  it("ranks better FTS positions higher via RRF 1/(k+rank)", () => {
    const first = score({ ftsRank: 1, confidence: 1, ageDays: 0 }, DEFAULT_RANKING);
    const tenth = score({ ftsRank: 10, confidence: 1, ageDays: 0 }, DEFAULT_RANKING);
    expect(first).toBeGreaterThan(tenth);
    expect(first / tenth).toBeCloseTo((DEFAULT_RANKING.rrfK + 10) / (DEFAULT_RANKING.rrfK + 1), 10);
  });

  it("treats no-query results as rank-free (confidence × decay only)", () => {
    const s = score({ ftsRank: null, confidence: 0.8, ageDays: 0 }, DEFAULT_RANKING);
    expect(s).toBeCloseTo(0.8, 10);
  });

  it("honors a custom half-life", () => {
    const opts = { halfLifeDays: 10, rrfK: 60 };
    const s = score({ ftsRank: null, confidence: 1, ageDays: 20 }, opts);
    expect(s).toBeCloseTo(0.25, 10);
  });
});
