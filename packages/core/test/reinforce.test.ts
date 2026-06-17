import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/clock.js";
import { Memharness } from "../src/memory.js";
import { openTestDb } from "./helpers.js";

const DAY = 86_400_000;

describe("reinforce-on-access", () => {
  it("freshens a recalled fact's decay clock so it outranks an equally-old but un-accessed peer", () => {
    const clock = new FakeClock("2026-01-01T00:00:00.000Z", 0);
    const mem = Memharness.open({ dbPath: ":memory:", clock });
    // same subject/kind/importance/confidence, inserted ~together
    const a = mem.remember({ subject: "u", fact: "alpha unique marker" }).id;
    const b = mem.remember({ subject: "u", fact: "beta plain" }).id;

    clock.advance(50 * DAY);
    // access only A (only A matches "alpha") → reinforces A's last_accessed_at
    expect(mem.recall({ subject: "u", query: "alpha" }).facts.map((f) => f.id)).toEqual([a]);

    clock.advance(1 * DAY);
    // rank-free recall returns both; A's age is ~1d, B's is ~51d → A wins on decay alone
    const ordered = mem.recall({ subject: "u" }).facts.map((f) => f.id);
    expect(ordered).toEqual([a, b]);
    mem.close();
  });

  it("does NOT reinforce on historical (as_of) recall", () => {
    const { mem, clock } = openTestDb();
    const id = mem.remember({ subject: "u", fact: "never touched" }).id;
    expect(mem.why(id).fact.lastAccessedAt).toBeNull();

    clock.advance(DAY);
    mem.recall({ subject: "u", asOf: clock.peek() }); // historical read
    expect(mem.why(id).fact.lastAccessedAt).toBeNull();

    mem.recall({ subject: "u" }); // current read
    expect(mem.why(id).fact.lastAccessedAt).not.toBeNull();
    mem.close();
  });

  it("reinforcement never changes belief-set membership, tx_at, or validity (I1/I4)", () => {
    const { mem, clock } = openTestDb();
    const id = mem.remember({ subject: "u", fact: "stable belief" }).id;
    const before = mem.why(id).fact;
    const beforeAccess = clock.peek();

    clock.advance(DAY);
    mem.recall({ subject: "u" }); // reinforces

    const after = mem.why(id).fact;
    expect(after.txAt).toBe(before.txAt); // I1: tx_at immutable
    expect(after.validTo).toBeNull();
    expect(after.retractedAt).toBeNull();
    // still a current belief, and still present in an as_of snapshot from before the access
    expect(mem.recall({ subject: "u" }).facts.map((f) => f.id)).toContain(id);
    expect(mem.recall({ subject: "u", asOf: beforeAccess }).facts.map((f) => f.id)).toContain(id);
    mem.close();
  });
});
