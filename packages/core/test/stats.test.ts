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
