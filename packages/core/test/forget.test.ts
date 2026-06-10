import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/errors.js";
import { ids, openTestDb } from "./helpers.js";

describe("forget", () => {
  it("tombstones by factId: retractedAt set, row still present (I4)", () => {
    const { mem } = openTestDb();
    const id = mem.remember({ subject: "user", fact: "secret" }).id;
    const before = mem.stats().totalFacts;
    const r = mem.forget({ factId: id });
    expect(r.retractedCount).toBe(1);
    expect(r.retractedIds).toEqual([id]);
    expect(mem.why(id).fact.retractedAt).not.toBeNull();
    expect(mem.stats().totalFacts).toBe(before);
  });

  it("retracts everything matching a sourceRef and reports count + ids", () => {
    const { mem } = openTestDb();
    const a = mem.remember({ subject: "u", fact: "a", sourceRef: "session-3" }).id;
    const b = mem.remember({ subject: "v", fact: "b", sourceRef: "session-3" }).id;
    const keep = mem.remember({ subject: "u", fact: "c", sourceRef: "session-4" }).id;

    const r = mem.forget({ sourceRef: "session-3" });
    expect(r.retractedCount).toBe(2);
    expect(r.retractedIds.sort((x, y) => x - y)).toEqual([a, b]);
    expect(ids(mem.recall())).toEqual([keep]);
  });

  it("rejects an empty sourceRef rather than retracting everything", () => {
    const { mem } = openTestDb();
    mem.remember({ subject: "u", fact: "a" });
    expect(() => mem.forget({ sourceRef: "" })).toThrow(ValidationError);
    expect(() => mem.forget({ sourceRef: "   " })).toThrow(ValidationError);
    expect(mem.recall().facts).toHaveLength(1);
  });

  it("rejects a call with neither factId nor sourceRef", () => {
    const { mem } = openTestDb();
    expect(() => mem.forget({} as never)).toThrow(ValidationError);
  });

  it("returns retractedCount 0 for a nonexistent id (prototype parity, no throw)", () => {
    const { mem } = openTestDb();
    expect(mem.forget({ factId: 999 }).retractedCount).toBe(0);
  });

  it("leaves validTo alone: retraction is transaction-time, not world-time", () => {
    const { mem } = openTestDb();
    const id = mem.remember({ subject: "u", fact: "still true, just unasserted" }).id;
    mem.forget({ factId: id });
    const f = mem.why(id).fact;
    expect(f.validTo).toBeNull();
    expect(f.retractedAt).not.toBeNull();
  });

  it("is idempotent: a second forget keeps the first retractedAt", () => {
    const { mem } = openTestDb();
    const id = mem.remember({ subject: "u", fact: "x" }).id;
    mem.forget({ factId: id });
    const first = mem.why(id).fact.retractedAt;
    const r = mem.forget({ factId: id });
    expect(r.retractedCount).toBe(0); // nothing newly retracted
    expect(mem.why(id).fact.retractedAt).toBe(first);
  });

  it("excludes retracted facts from current recall and from diff learned", () => {
    const { mem, clock } = openTestDb();
    const since = clock.peek();
    const id = mem.remember({ subject: "user", fact: "ephemeral" }).id;
    mem.forget({ factId: id });
    expect(mem.recall().facts).toEqual([]);
    expect(mem.diff({ since }).learned).toEqual([]);
    expect(mem.diff({ since }).retracted.map((f) => f.id)).toEqual([id]);
  });
});
