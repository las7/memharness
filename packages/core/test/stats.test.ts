import { describe, expect, it } from "vitest";
import { openTestDb } from "./helpers.js";

describe("stats", () => {
  it("counts totalFacts (all rows ever) vs currentBeliefs (live only)", () => {
    const { mem } = openTestDb();
    const a = mem.remember({ subject: "u", fact: "v1" }).id;
    mem.revise({ oldFactId: a, newFact: "v2" }); // +1 row, still 1 belief
    const b = mem.remember({ subject: "u", fact: "other" }).id;
    mem.forget({ factId: b });

    const s = mem.stats();
    expect(s.totalFacts).toBe(3);
    expect(s.currentBeliefs).toBe(1);
    expect(s.schemaVersion).toBeGreaterThanOrEqual(1);
  });

  it("excludes future-dated facts from currentBeliefs and topSubjects", () => {
    const { mem, clock } = openTestDb("2026-06-01T00:00:00.000Z");
    mem.remember({ subject: "u", fact: "live now" });
    mem.remember({ subject: "u", fact: "not yet", validFrom: "2026-07-01T00:00:00.000Z" });

    let s = mem.stats();
    expect(s.totalFacts).toBe(2);
    expect(s.currentBeliefs).toBe(1);
    expect(s.topSubjects[0]).toEqual({ subject: "u", count: 1 });

    clock.advance(45 * 24 * 3600 * 1000); // past July 1
    s = mem.stats();
    expect(s.currentBeliefs).toBe(2);
  });

  it("ranks topSubjects by current-belief count, capped at 10", () => {
    const { mem } = openTestDb();
    for (let i = 0; i < 12; i++) {
      mem.remember({ subject: `s${i}`, fact: "one" });
    }
    mem.remember({ subject: "popular", fact: "a" });
    mem.remember({ subject: "popular", fact: "b" });
    mem.remember({ subject: "popular", fact: "c" });

    const s = mem.stats();
    expect(s.topSubjects).toHaveLength(10);
    expect(s.topSubjects[0]).toEqual({ subject: "popular", count: 3 });
  });

  it("returns zeros and empty topSubjects on a fresh db", () => {
    const { mem } = openTestDb();
    const s = mem.stats();
    expect(s.totalFacts).toBe(0);
    expect(s.currentBeliefs).toBe(0);
    expect(s.topSubjects).toEqual([]);
    expect(s.dbPath).toBe(":memory:");
  });
});
