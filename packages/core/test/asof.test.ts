import { describe, expect, it } from "vitest";
import { ids, openTestDb } from "./helpers.js";

// Boundary conventions (half-open intervals, pinned here and mirrored by the
// property-test oracle):
//   include txAt == T, include validFrom == T, exclude validTo == T, exclude retractedAt == T

describe("recall with asOf", () => {
  it("returns a fact learned before T even though it was later revised", () => {
    const { mem } = openTestDb("2026-03-01T00:00:00.000Z");
    const old = mem.remember({ subject: "user", fact: "lives in Osaka" }).id; // ~03-01
    const T = "2026-03-02T00:00:00.000Z";
    // revision happens well after T
    const { newId } = mem.revise({ oldFactId: old, newFact: "lives in Tokyo" });

    const past = mem.recall({ asOf: T });
    expect(ids(past)).toEqual([old]);
    expect(ids(past)).not.toContain(newId);
    expect(past.asOf).toBe(T);
  });

  it("excludes facts learned after T (txAt > T)", () => {
    const { mem, clock } = openTestDb("2026-03-01T00:00:00.000Z");
    const before = mem.remember({ subject: "user", fact: "a" }).id;
    clock.advance(10 * 24 * 3600 * 1000);
    // learned later, but claims to have been true since long before T
    mem.remember({ subject: "user", fact: "b", validFrom: "2026-01-01T00:00:00.000Z" });

    expect(ids(mem.recall({ asOf: "2026-03-05T00:00:00.000Z" }))).toEqual([before]);
  });

  it("excludes facts whose validFrom > T", () => {
    const { mem } = openTestDb("2026-03-01T00:00:00.000Z");
    mem.remember({
      subject: "user",
      fact: "starts new job",
      validFrom: "2026-04-01T00:00:00.000Z",
    });
    expect(mem.recall({ asOf: "2026-03-10T00:00:00.000Z" }).facts).toEqual([]);
    // boundary: validFrom == T is included
    expect(ids(mem.recall({ asOf: "2026-04-01T00:00:00.000Z" }))).toHaveLength(1);
  });

  it("excludes validTo <= T, includes validTo > T", () => {
    const { mem } = openTestDb("2026-03-01T00:00:00.000Z");
    const old = mem.remember({ subject: "user", fact: "on sabbatical" }).id;
    const { txAt } = mem.revise({ oldFactId: old, newFact: "back at work" }); // closes old at txAt

    const justBefore = new Date(Date.parse(txAt) - 1).toISOString();
    expect(ids(mem.recall({ asOf: justBefore }))).toEqual([old]);
    // validTo == T excluded (and the successor with txAt == T included)
    const atT = mem.recall({ asOf: txAt });
    expect(ids(atT)).not.toContain(old);
  });

  it("at exactly a revision timestamp shows the new fact, not the old (clean cutover)", () => {
    const { mem } = openTestDb("2026-03-01T00:00:00.000Z");
    const old = mem.remember({ subject: "user", fact: "v1" }).id;
    const { newId, txAt } = mem.revise({ oldFactId: old, newFact: "v2" });
    expect(ids(mem.recall({ asOf: txAt }))).toEqual([newId]);
  });

  it("before a retraction still shows the retracted fact; after, excludes it", () => {
    const { mem } = openTestDb("2026-03-01T00:00:00.000Z");
    const id = mem.remember({ subject: "user", fact: "secret detail" }).id;
    mem.forget({ factId: id });
    const retractedAt = mem.why(id).fact.retractedAt!;

    const justBefore = new Date(Date.parse(retractedAt) - 1).toISOString();
    expect(ids(mem.recall({ asOf: justBefore }))).toEqual([id]);
    // retractedAt == T excluded; after T excluded
    expect(mem.recall({ asOf: retractedAt }).facts).toEqual([]);
    const after = new Date(Date.parse(retractedAt) + 60_000).toISOString();
    expect(mem.recall({ asOf: after }).facts).toEqual([]);
  });

  it("interprets a date-only asOf as midnight UTC", () => {
    const { mem } = openTestDb("2026-03-15T12:00:00.000Z");
    mem.remember({ subject: "user", fact: "learned mid-march" });
    expect(mem.recall({ asOf: "2026-03-15" }).facts).toEqual([]); // midnight < noon
    expect(ids(mem.recall({ asOf: "2026-03-16" }))).toHaveLength(1);
    expect(mem.recall({ asOf: "2026-03-16" }).asOf).toBe("2026-03-16T00:00:00.000Z");
  });

  it("includes superseded facts that were current at T", () => {
    const { mem, clock } = openTestDb("2026-03-01T00:00:00.000Z");
    const a = mem.remember({ subject: "user", fact: "gen one" }).id;
    clock.advance(24 * 3600 * 1000);
    const T = clock.peek();
    clock.advance(24 * 3600 * 1000);
    const r1 = mem.revise({ oldFactId: a, newFact: "gen two" });
    mem.revise({ oldFactId: r1.newId, newFact: "gen three" });

    // at T only gen one existed, despite two later revisions
    expect(ids(mem.recall({ asOf: T }))).toEqual([a]);
  });

  it("combines with subject and query filters", () => {
    const { mem, clock } = openTestDb("2026-03-01T00:00:00.000Z");
    const a = mem.remember({ subject: "project:a", fact: "uses postgres heavily" }).id;
    mem.remember({ subject: "project:b", fact: "uses postgres too" });
    mem.remember({ subject: "project:a", fact: "written in rust" });
    clock.advance(24 * 3600 * 1000);
    const T = clock.peek();
    clock.advance(24 * 3600 * 1000);
    mem.remember({ subject: "project:a", fact: "uses postgres replicas" }); // after T

    expect(ids(mem.recall({ asOf: T, subject: "project:a", query: "postgres" }))).toEqual([a]);
  });

  it("is reproducible: same answer after further unrelated writes (I3)", () => {
    const { mem, clock } = openTestDb("2026-03-01T00:00:00.000Z");
    const a = mem.remember({ subject: "user", fact: "stable belief" }).id;
    clock.advance(3600 * 1000);
    const T = clock.peek();
    clock.advance(3600 * 1000);

    const first = ids(mem.recall({ asOf: T }));
    mem.remember({ subject: "user", fact: "new info" });
    const b = mem.remember({ subject: "user", fact: "more info" }).id;
    mem.revise({ oldFactId: b, newFact: "revised info" });
    mem.forget({ factId: a }); // even retracting a member of the past set

    // retraction happened after T, so the belief set AT T is unchanged
    expect(ids(mem.recall({ asOf: T }))).toEqual(first);
  });
});
