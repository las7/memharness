import { describe, expect, it } from "vitest";
import { NotFoundError, ValidationError } from "../src/errors.js";
import { ids, openTestDb } from "./helpers.js";

describe("revise", () => {
  it("closes the old fact, links supersededBy, inherits subject and predicate", () => {
    const { mem } = openTestDb();
    const old = mem.remember({
      subject: "user",
      predicate: "prefers",
      fact: "tabs",
      sourceRef: "session-1",
    }).id;
    const { newId, txAt } = mem.revise({
      oldFactId: old,
      newFact: "spaces",
      sourceRef: "session-2",
    });

    const oldFact = mem.why(old).fact;
    expect(oldFact.validTo).toBe(txAt);
    expect(oldFact.supersededBy).toBe(newId);

    const newFact = mem.why(newId).fact;
    expect(newFact.subject).toBe("user");
    expect(newFact.predicate).toBe("prefers");
    expect(newFact.fact).toBe("spaces");
    expect(newFact.sourceRef).toBe("session-2");
    expect(newFact.validFrom).toBe(txAt);
    expect(newFact.txAt).toBe(txAt);
    expect(newFact.validTo).toBeNull();
  });

  it("shares one timestamp between closing the old and opening the new (atomic cutover)", () => {
    const { mem } = openTestDb();
    const old = mem.remember({ subject: "u", fact: "v1" }).id;
    const { newId, txAt } = mem.revise({ oldFactId: old, newFact: "v2" });
    expect(mem.why(old).fact.validTo).toBe(txAt);
    expect(mem.why(newId).fact.txAt).toBe(txAt);
    expect(mem.why(newId).fact.validFrom).toBe(txAt);
  });

  it("throws NotFoundError for a missing id", () => {
    const { mem } = openTestDb();
    expect(() => mem.revise({ oldFactId: 999, newFact: "x" })).toThrow(NotFoundError);
  });

  it("throws ValidationError when the fact is already superseded (protects the chain)", () => {
    const { mem } = openTestDb();
    const a = mem.remember({ subject: "u", fact: "v1" }).id;
    mem.revise({ oldFactId: a, newFact: "v2" });
    expect(() => mem.revise({ oldFactId: a, newFact: "v3" })).toThrow(ValidationError);
  });

  it("accepts an explicit validFrom to backdate when the new belief became true", () => {
    const { mem } = openTestDb("2026-06-01T00:00:00.000Z");
    const old = mem.remember({ subject: "user", fact: "lives in Osaka" }).id;
    const { newId, txAt } = mem.revise({
      oldFactId: old,
      newFact: "lives in Tokyo",
      validFrom: "2026-05-01T00:00:00.000Z",
    });
    const f = mem.why(newId).fact;
    expect(f.validFrom).toBe("2026-05-01T00:00:00.000Z");
    expect(f.txAt).toBe(txAt); // learned now, true since May
  });

  it("removes the old fact from current recall and surfaces the successor", () => {
    const { mem } = openTestDb();
    const old = mem.remember({ subject: "user", fact: "editor preference emacs" }).id;
    const { newId } = mem.revise({ oldFactId: old, newFact: "editor preference helix" });
    expect(ids(mem.recall({ query: "editor preference" }))).toEqual([newId]);
  });

  it("builds chains where each link points one forward", () => {
    const { mem } = openTestDb();
    const a = mem.remember({ subject: "u", fact: "v1" }).id;
    const b = mem.revise({ oldFactId: a, newFact: "v2" }).newId;
    const c = mem.revise({ oldFactId: b, newFact: "v3" }).newId;
    expect(mem.why(a).fact.supersededBy).toBe(b);
    expect(mem.why(b).fact.supersededBy).toBe(c);
    expect(mem.why(c).fact.supersededBy).toBeNull();
  });

  it("rejects empty newFact and out-of-range confidence", () => {
    const { mem } = openTestDb();
    const a = mem.remember({ subject: "u", fact: "v1" }).id;
    expect(() => mem.revise({ oldFactId: a, newFact: "  " })).toThrow(ValidationError);
    expect(() => mem.revise({ oldFactId: a, newFact: "x", confidence: 2 })).toThrow(
      ValidationError,
    );
  });
});
