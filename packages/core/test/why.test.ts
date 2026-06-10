import { describe, expect, it } from "vitest";
import { NotFoundError } from "../src/errors.js";
import { openTestDb } from "./helpers.js";

describe("why", () => {
  it("throws NotFoundError for a missing id", () => {
    const { mem } = openTestDb();
    expect(() => mem.why(42)).toThrow(NotFoundError);
  });

  it("returns empty ancestors/descendants for a standalone fact", () => {
    const { mem } = openTestDb();
    const id = mem.remember({ subject: "user", fact: "standalone" }).id;
    const w = mem.why(id);
    expect(w.fact.id).toBe(id);
    expect(w.ancestors).toEqual([]);
    expect(w.descendants).toEqual([]);
  });

  it("returns one ancestor and one descendant from the middle of a 3-link chain", () => {
    const { mem } = openTestDb();
    const a = mem.remember({ subject: "u", fact: "v1" }).id;
    const b = mem.revise({ oldFactId: a, newFact: "v2" }).newId;
    const c = mem.revise({ oldFactId: b, newFact: "v3" }).newId;

    const w = mem.why(b);
    expect(w.ancestors.map((f) => f.id)).toEqual([a]);
    expect(w.descendants.map((f) => f.id)).toEqual([c]);
  });

  it("walks all descendants from the head of a chain, nearest first", () => {
    const { mem } = openTestDb();
    const a = mem.remember({ subject: "u", fact: "v1" }).id;
    const b = mem.revise({ oldFactId: a, newFact: "v2" }).newId;
    const c = mem.revise({ oldFactId: b, newFact: "v3" }).newId;
    const d = mem.revise({ oldFactId: c, newFact: "v4" }).newId;

    const w = mem.why(a);
    expect(w.descendants.map((f) => f.id)).toEqual([b, c, d]);
    expect(mem.why(d).ancestors.map((f) => f.id)).toEqual([c, b, a]);
  });

  it("carries full provenance on every chain node", () => {
    const { mem } = openTestDb();
    const a = mem.remember({
      subject: "u",
      fact: "v1",
      sourceAgent: "claude-code",
      sourceRef: "session-7",
    }).id;
    mem.revise({ oldFactId: a, newFact: "v2", sourceAgent: "claude-desktop", sourceRef: "chat-9" });

    const w = mem.why(a);
    expect(w.fact.sourceAgent).toBe("claude-code");
    expect(w.fact.sourceRef).toBe("session-7");
    expect(w.fact.txAt).toBeTruthy();
    expect(w.descendants[0]!.sourceAgent).toBe("claude-desktop");
    expect(w.descendants[0]!.sourceRef).toBe("chat-9");
  });

  it("works on a retracted fact and exposes retractedAt", () => {
    const { mem } = openTestDb();
    const id = mem.remember({ subject: "u", fact: "gone" }).id;
    mem.forget({ factId: id });
    expect(mem.why(id).fact.retractedAt).not.toBeNull();
  });
});
