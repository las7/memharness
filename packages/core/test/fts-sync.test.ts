import { describe, expect, it } from "vitest";
import { openTestDb } from "./helpers.js";

describe("FTS external-content sync", () => {
  it("passes the FTS5 integrity-check after remember/revise/forget sequences", () => {
    const { mem } = openTestDb();
    const a = mem.remember({ subject: "user", fact: "first version of the fact" }).id;
    expect(() => mem.checkIntegrity()).not.toThrow();
    const b = mem.revise({ oldFactId: a, newFact: "second version of the fact" }).newId;
    expect(() => mem.checkIntegrity()).not.toThrow();
    mem.forget({ factId: b });
    expect(() => mem.checkIntegrity()).not.toThrow();
    mem.remember({ subject: "user", fact: "another", sourceRef: "s" });
    mem.forget({ sourceRef: "s" });
    expect(() => mem.checkIntegrity()).not.toThrow();
  });

  it("still finds a fact by text after its row was UPDATEd by revise", () => {
    const { mem } = openTestDb();
    const a = mem.remember({ subject: "user", fact: "searchable original phrasing" }).id;
    mem.revise({ oldFactId: a, newFact: "completely different words" });
    // the superseded original is still findable in as_of mode via FTS
    const past = mem.recall({
      query: "searchable original",
      asOf: mem.why(a).fact.txAt,
    });
    expect(past.facts.map((f) => f.id)).toContain(a);
  });
});
