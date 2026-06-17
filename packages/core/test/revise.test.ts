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
    const old = mem.remember({
      subject: "user",
      fact: "lives in Osaka",
      validFrom: "2026-01-01T00:00:00.000Z",
    }).id;
    const { newId, txAt } = mem.revise({
      oldFactId: old,
      newFact: "lives in Tokyo",
      validFrom: "2026-05-01T00:00:00.000Z",
    });
    const f = mem.why(newId).fact;
    expect(f.validFrom).toBe("2026-05-01T00:00:00.000Z");
    expect(f.txAt).toBe(txAt); // learned now, true since May
  });

  it("backdated revise closes the old fact at the new validFrom, not txAt", () => {
    const { mem, clock } = openTestDb("2026-03-01T00:00:00.000Z");
    const old = mem.remember({ subject: "user", fact: "works at A" }).id;
    clock.advance(10 * 24 * 3600 * 1000); // revise on 03-11...
    const backdate = "2026-03-05T00:00:00.000Z"; // ...but A ended 03-05
    mem.revise({ oldFactId: old, newFact: "works at B", validFrom: backdate });

    const oldRow = mem.why(old).fact;
    expect(oldRow.validTo).toBe(backdate); // not the 03-11 txAt
    // half-open boundary: old excluded AT backdate, included just before
    const justBefore = new Date(Date.parse(backdate) - 1).toISOString();
    expect(ids(mem.recall({ asOf: justBefore }))).toContain(old);
    expect(ids(mem.recall({ asOf: backdate }))).not.toContain(old);
  });

  it("rejects a validFrom outside [old.validFrom, now] (would overlap or invert intervals)", () => {
    const { mem } = openTestDb("2026-06-01T00:00:00.000Z");
    const old = mem.remember({
      subject: "user",
      fact: "works at A",
      validFrom: "2026-05-01T00:00:00.000Z",
    }).id;
    // before the old fact even started
    expect(() =>
      mem.revise({ oldFactId: old, newFact: "works at B", validFrom: "2026-04-01T00:00:00.000Z" }),
    ).toThrow(ValidationError);
    // in the future
    expect(() =>
      mem.revise({ oldFactId: old, newFact: "works at B", validFrom: "2027-01-01T00:00:00.000Z" }),
    ).toThrow(ValidationError);
  });

  it("quotes the chain head's id and text when revising a superseded fact", () => {
    const { mem } = openTestDb();
    const a = mem.remember({ subject: "u", fact: "v1" }).id;
    const b = mem.revise({ oldFactId: a, newFact: "v2" }).newId;
    const c = mem.revise({ oldFactId: b, newFact: "v3 current text" }).newId;
    expect(() => mem.revise({ oldFactId: a, newFact: "v4" })).toThrow(
      new RegExp(`#${c}: "v3 current text"`),
    );
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

  it("does NOT inherit the source pin: a revision is null unless re-supplied", () => {
    const { mem } = openTestDb();
    const a = mem.remember({
      subject: "project:x",
      fact: "v1",
      sourceCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      sourcePath: "src/a.ts",
    }).id;
    // a re-word that doesn't re-supply the pin drops it (agent presumably looked again)
    const reworded = mem.revise({ oldFactId: a, newFact: "v2" }).newId;
    expect(mem.why(reworded).fact.sourceCommit).toBeNull();
    expect(mem.why(reworded).fact.sourcePath).toBeNull();
    // a re-read at a fresh commit re-pins
    const repinned = mem.revise({
      oldFactId: reworded,
      newFact: "v3",
      sourceCommit: "feedface00000000000000000000000000000000",
      sourcePath: "src/a.ts",
    }).newId;
    expect(mem.why(repinned).fact.sourceCommit).toBe("feedface00000000000000000000000000000000");
  });
});
