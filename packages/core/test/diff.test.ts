import { describe, expect, it } from "vitest";
import { openTestDb } from "./helpers.js";

describe("diff", () => {
  it("lists still-current facts learned at or after `since` under learned", () => {
    const { mem, clock } = openTestDb("2026-03-01T00:00:00.000Z");
    mem.remember({ subject: "user", fact: "old news" });
    clock.advance(7 * 24 * 3600 * 1000);
    const since = clock.peek();
    const a = mem.remember({ subject: "user", fact: "fresh fact" }).id;

    const d = mem.diff({ since });
    expect(d.learned.map((f) => f.id)).toEqual([a]);
    expect(d.since).toBe(since);
  });

  it("excludes from learned the facts learned after `since` but already revised away", () => {
    const { mem, clock } = openTestDb("2026-03-01T00:00:00.000Z");
    const since = clock.peek();
    const a = mem.remember({ subject: "user", fact: "short lived" }).id;
    const b = mem.revise({ oldFactId: a, newFact: "longer lived" }).newId;

    const d = mem.diff({ since });
    expect(d.learned.map((f) => f.id)).toEqual([b]);
  });

  it("pairs each revised fact with its successor", () => {
    const { mem, clock } = openTestDb("2026-03-01T00:00:00.000Z");
    const a = mem.remember({ subject: "user", fact: "v1" }).id;
    clock.advance(24 * 3600 * 1000);
    const since = clock.peek();
    const b = mem.revise({ oldFactId: a, newFact: "v2" }).newId;

    const d = mem.diff({ since });
    expect(d.revised).toHaveLength(1);
    expect(d.revised[0]!.old.id).toBe(a);
    expect(d.revised[0]!.new?.id).toBe(b);
  });

  it("lists retractions with retractedAt >= since", () => {
    const { mem, clock } = openTestDb("2026-03-01T00:00:00.000Z");
    const early = mem.remember({ subject: "user", fact: "gone early" }).id;
    mem.forget({ factId: early });
    clock.advance(24 * 3600 * 1000);
    const since = clock.peek();
    const late = mem.remember({ subject: "user", fact: "gone late" }).id;
    mem.forget({ factId: late });

    const d = mem.diff({ since });
    expect(d.retracted.map((f) => f.id)).toEqual([late]);
  });

  it("applies the subject filter to all three sections", () => {
    const { mem, clock } = openTestDb("2026-03-01T00:00:00.000Z");
    const since = clock.peek();
    mem.remember({ subject: "other", fact: "learned" });
    const oOld = mem.remember({ subject: "other", fact: "revised v1" }).id;
    mem.revise({ oldFactId: oOld, newFact: "revised v2" });
    const oGone = mem.remember({ subject: "other", fact: "retracted" }).id;
    mem.forget({ factId: oGone });

    const a = mem.remember({ subject: "user", fact: "learned" }).id;
    const uOld = mem.remember({ subject: "user", fact: "revised v1" }).id;
    const uNew = mem.revise({ oldFactId: uOld, newFact: "revised v2" }).newId;
    const uGone = mem.remember({ subject: "user", fact: "retracted" }).id;
    mem.forget({ factId: uGone });

    const d = mem.diff({ since, subject: "user" });
    expect(d.learned.map((f) => f.id)).toEqual([a, uNew]);
    expect(d.revised.map((r) => r.old.id)).toEqual([uOld]);
    expect(d.retracted.map((f) => f.id)).toEqual([uGone]);
  });

  it("returns three empty arrays for a future `since`", () => {
    const { mem } = openTestDb();
    mem.remember({ subject: "user", fact: "anything" });
    const d = mem.diff({ since: "2030-01-01" });
    expect(d.learned).toEqual([]);
    expect(d.revised).toEqual([]);
    expect(d.retracted).toEqual([]);
  });

  it("does not double-count a fact remembered and revised after `since`", () => {
    const { mem, clock } = openTestDb("2026-03-01T00:00:00.000Z");
    const since = clock.peek();
    const a = mem.remember({ subject: "user", fact: "v1" }).id;
    const b = mem.revise({ oldFactId: a, newFact: "v2" }).newId;

    const d = mem.diff({ since });
    expect(d.learned.map((f) => f.id)).toEqual([b]); // only the live head
    expect(d.revised.map((r) => r.old.id)).toEqual([a]); // the old self shows as revised
  });

  it("normalizes a date-only since", () => {
    const { mem } = openTestDb("2026-03-02T12:00:00.000Z");
    const a = mem.remember({ subject: "user", fact: "x" }).id;
    expect(mem.diff({ since: "2026-03-02" }).learned.map((f) => f.id)).toEqual([a]);
    expect(mem.diff({ since: "2026-03-03" }).learned).toEqual([]);
  });
});
