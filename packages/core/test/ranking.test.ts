import { describe, expect, it } from "vitest";
import { DEFAULT_RANKING, effectiveHalfLife, score } from "../src/ranking.js";

// Neutral salience reproduces the pre-importance behavior: boost 1.0, half-life ×1.0.
const NEUTRAL = { importance: 5, kind: "semantic" } as const;

describe("score", () => {
  it("halves the score at exactly halfLifeDays of age", () => {
    const fresh = score({ ftsRank: null, confidence: 1, ageDays: 0, ...NEUTRAL }, DEFAULT_RANKING);
    const stale = score(
      { ftsRank: null, confidence: 1, ageDays: DEFAULT_RANKING.halfLifeDays, ...NEUTRAL },
      DEFAULT_RANKING,
    );
    expect(stale).toBeCloseTo(fresh / 2, 10);
  });

  it("scales linearly with confidence", () => {
    const full = score({ ftsRank: 1, confidence: 1, ageDays: 0, ...NEUTRAL }, DEFAULT_RANKING);
    const half = score({ ftsRank: 1, confidence: 0.5, ageDays: 0, ...NEUTRAL }, DEFAULT_RANKING);
    expect(half).toBeCloseTo(full / 2, 10);
  });

  it("ranks better FTS positions higher via RRF 1/(k+rank)", () => {
    const first = score({ ftsRank: 1, confidence: 1, ageDays: 0, ...NEUTRAL }, DEFAULT_RANKING);
    const tenth = score({ ftsRank: 10, confidence: 1, ageDays: 0, ...NEUTRAL }, DEFAULT_RANKING);
    expect(first).toBeGreaterThan(tenth);
    expect(first / tenth).toBeCloseTo((DEFAULT_RANKING.rrfK + 10) / (DEFAULT_RANKING.rrfK + 1), 10);
  });

  it("treats no-query results as rank-free (confidence × decay only)", () => {
    const s = score({ ftsRank: null, confidence: 0.8, ageDays: 0, ...NEUTRAL }, DEFAULT_RANKING);
    expect(s).toBeCloseTo(0.8, 10);
  });

  it("honors a custom half-life", () => {
    const opts = { ...DEFAULT_RANKING, halfLifeDays: 10 };
    const s = score({ ftsRank: null, confidence: 1, ageDays: 20, ...NEUTRAL }, opts);
    expect(s).toBeCloseTo(0.25, 10);
  });
});

describe("importance", () => {
  it("boosts ranking above neutral and damps below it", () => {
    const base = { ftsRank: null, confidence: 1, ageDays: 0, kind: "semantic" } as const;
    const neutral = score({ ...base, importance: 5 }, DEFAULT_RANKING);
    const high = score({ ...base, importance: 10 }, DEFAULT_RANKING);
    const low = score({ ...base, importance: 1 }, DEFAULT_RANKING);
    expect(high / neutral).toBeCloseTo(1 + 0.05 * 5, 10); // 1.25×
    expect(low / neutral).toBeCloseTo(1 + 0.05 * -4, 10); // 0.8×
  });

  it("makes important memories decay slower (longer effective half-life)", () => {
    expect(effectiveHalfLife(DEFAULT_RANKING, "semantic", 5)).toBeCloseTo(90, 10);
    expect(effectiveHalfLife(DEFAULT_RANKING, "semantic", 10)).toBeCloseTo(90 * 1.75, 10);
    expect(effectiveHalfLife(DEFAULT_RANKING, "semantic", 1)).toBeCloseTo(90 * 0.4, 10);
    // at equal age, importance 10 retains more than importance 5
    const age = 90;
    const hot = score(
      { ftsRank: null, confidence: 1, ageDays: age, importance: 10, kind: "semantic" },
      DEFAULT_RANKING,
    );
    const mid = score(
      { ftsRank: null, confidence: 1, ageDays: age, importance: 5, kind: "semantic" },
      DEFAULT_RANKING,
    );
    expect(hot).toBeGreaterThan(mid);
  });
});

describe("kind base half-life", () => {
  it("uses semantic=halfLifeDays, episodic shorter, procedural longer", () => {
    expect(effectiveHalfLife(DEFAULT_RANKING, "semantic", 5)).toBeCloseTo(90, 10);
    expect(effectiveHalfLife(DEFAULT_RANKING, "episodic", 5)).toBeCloseTo(30, 10);
    expect(effectiveHalfLife(DEFAULT_RANKING, "procedural", 5)).toBeCloseTo(180, 10);
    // equal age: semantic outranks episodic (episodic decayed more), procedural outranks semantic
    const at = (kind: "semantic" | "episodic" | "procedural") =>
      score({ ftsRank: null, confidence: 1, ageDays: 60, importance: 5, kind }, DEFAULT_RANKING);
    expect(at("procedural")).toBeGreaterThan(at("semantic"));
    expect(at("semantic")).toBeGreaterThan(at("episodic"));
  });
});
