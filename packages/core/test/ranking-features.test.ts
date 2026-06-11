import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/clock.js";
import { Memharness } from "../src/memory.js";
import { DEFAULT_RANKING, score } from "../src/ranking.js";
import type { MemoryKind } from "../src/types.js";
import { openTestDb } from "./helpers.js";

const DAY = 86_400_000;

describe("SQL/TS score parity", () => {
  // The keystone test: the score formula lives in two places (ranking.ts score()
  // and sql.ts recallQuery). This pins them to agree numerically so they can't drift.
  it("SQL score matches ranking.score() across importance × kind × confidence at known ages", () => {
    const clock = new FakeClock("2026-01-01T00:00:00.000Z", 0);
    const mem = Memharness.open({ dbPath: ":memory:", clock });
    const cases: Array<{ confidence: number; importance: number; kind: MemoryKind }> = [
      { confidence: 1.0, importance: 5, kind: "semantic" },
      { confidence: 0.8, importance: 9, kind: "semantic" },
      { confidence: 0.6, importance: 2, kind: "episodic" },
      { confidence: 1.0, importance: 7, kind: "procedural" },
      { confidence: 0.95, importance: 1, kind: "episodic" },
      { confidence: 0.5, importance: 10, kind: "procedural" },
    ];
    cases.forEach((c, i) => mem.remember({ subject: `s${i}`, fact: `fact ${i}`, ...c }));

    for (let i = 0; i < cases.length; i++) {
      clock.advance(DAY); // grow ages; also avoids monotonic-bump ties so peek() == recall's now
      const now = clock.peek();
      const r = mem.recall({ subject: `s${i}` }); // subject-only → rank-free (ftsRank null)
      expect(r.facts).toHaveLength(1);
      const f = r.facts[0]!;
      const ageDays = (Date.parse(now) - Date.parse(f.txAt)) / DAY;
      const expected = score(
        {
          ftsRank: null,
          confidence: cases[i]!.confidence,
          ageDays,
          importance: cases[i]!.importance,
          kind: cases[i]!.kind,
        },
        DEFAULT_RANKING,
      );
      expect(f.score).toBeCloseTo(expected, 6);
    }
    mem.close();
  });
});

describe("importance ranking", () => {
  it("ranks a high-importance fact above a neutral one, all else equal", () => {
    const { mem } = openTestDb();
    const neutral = mem.remember({ subject: "u", fact: "alpha one", importance: 5 }).id;
    const high = mem.remember({ subject: "u", fact: "alpha two", importance: 9 }).id;
    const got = mem.recall({ query: "alpha", subject: "u" }).facts;
    expect(got[0]!.id).toBe(high);
    expect(got[1]!.id).toBe(neutral);
    mem.close();
  });
});

describe("kind filter + half-life", () => {
  it("filters recall to a single kind", () => {
    const { mem } = openTestDb();
    mem.remember({ subject: "u", fact: "likes tea", kind: "semantic" });
    const proc = mem.remember({
      subject: "u",
      fact: "deploy with pnpm build",
      kind: "procedural",
    }).id;
    mem.remember({ subject: "u", fact: "met Sam tuesday", kind: "episodic" });
    const got = mem.recall({ subject: "u", kind: "procedural" }).facts;
    expect(got.map((f) => f.id)).toEqual([proc]);
    mem.close();
  });

  it("decays episodic faster than semantic at equal age", () => {
    const clock = new FakeClock("2026-01-01T00:00:00.000Z", 0);
    const mem = Memharness.open({ dbPath: ":memory:", clock });
    const sem = mem.remember({ subject: "u", fact: "context alpha", kind: "semantic" }).id;
    const epi = mem.remember({ subject: "u", fact: "context beta", kind: "episodic" }).id;
    clock.advance(60 * DAY);
    const got = mem.recall({ query: "context", subject: "u" }).facts;
    // identical FTS rank/confidence/age; semantic's longer half-life wins
    expect(got[0]!.id).toBe(sem);
    expect(got[1]!.id).toBe(epi);
    mem.close();
  });
});

describe("revise inherits ranking metadata", () => {
  it("carries importance/kind forward unless overridden", () => {
    const { mem } = openTestDb();
    const id = mem.remember({ subject: "u", fact: "v1", importance: 9, kind: "procedural" }).id;
    const { newId } = mem.revise({ oldFactId: id, newFact: "v2" });
    const inherited = mem.why(newId).fact;
    expect(inherited.importance).toBe(9);
    expect(inherited.kind).toBe("procedural");

    const { newId: newId2 } = mem.revise({ oldFactId: newId, newFact: "v3", importance: 3 });
    const overridden = mem.why(newId2).fact;
    expect(overridden.importance).toBe(3);
    expect(overridden.kind).toBe("procedural"); // kind still inherited
    mem.close();
  });
});
