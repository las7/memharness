import { describe, expect, it } from "vitest";
import { openTestDb } from "./helpers.js";

// Exercises the vector storage + hybrid-recall path with hand-crafted unit
// vectors — no embedding model, so this stays offline and deterministic.
describe("hybrid vector recall", () => {
  it("loads sqlite-vec in-memory", () => {
    const { mem } = openTestDb();
    expect(mem.vecEnabled).toBe(true);
    mem.close();
  });

  it("ranks the nearest embedding first for a vector-only query", () => {
    const { mem } = openTestDb();
    const a = mem.remember({ subject: "u", fact: "alpha" }).id;
    const b = mem.remember({ subject: "u", fact: "beta" }).id;
    const c = mem.remember({ subject: "u", fact: "gamma" }).id;
    mem.setEmbedding(a, [1, 0, 0], "test");
    mem.setEmbedding(b, [0, 1, 0], "test");
    mem.setEmbedding(c, [0, 0, 1], "test");
    expect(mem.embeddedCount()).toBe(3);

    const got = mem.recall({ subject: "u", queryVector: [1, 0, 0] }).facts;
    expect(got[0]!.id).toBe(a); // cosine distance 0
    expect(got.map((f) => f.id).sort()).toEqual([a, b, c].sort());
    mem.close();
  });

  it("fuses lexical FTS with the vector leg, surfacing un-embedded facts too", () => {
    const { mem } = openTestDb();
    const a = mem.remember({ subject: "u", fact: "alpha vector match" }).id;
    const d = mem.remember({ subject: "u", fact: "lexicalunique only" }).id; // no embedding
    mem.setEmbedding(a, [1, 0, 0], "test");

    // text matches only D; vector matches only A → both should appear
    const got = mem.recall({ subject: "u", query: "lexicalunique", queryVector: [1, 0, 0] }).facts;
    const ids = got.map((f) => f.id);
    expect(ids).toContain(a);
    expect(ids).toContain(d);
    mem.close();
  });

  it("skips embeddings whose dimension does not match the query", () => {
    const { mem } = openTestDb();
    const a = mem.remember({ subject: "u", fact: "three-dim" }).id;
    const b = mem.remember({ subject: "u", fact: "four-dim" }).id;
    mem.setEmbedding(a, [1, 0, 0], "test");
    mem.setEmbedding(b, [1, 0, 0, 0], "test-4d");

    // 3-dim query → only the 3-dim fact participates in the vector leg
    const got = mem.recall({ subject: "u", queryVector: [1, 0, 0] }).facts;
    expect(got.map((f) => f.id)).toEqual([a]);
    mem.close();
  });

  it("applies as_of filters and does not reinforce on a vector query", () => {
    const { mem, clock } = openTestDb();
    const a = mem.remember({ subject: "u", fact: "alpha" }).id;
    mem.setEmbedding(a, [1, 0, 0], "test");
    clock.advance(1000);
    // historical recall may still rank by vector, but must not reinforce (a
    // past query is not present use) — last_accessed_at stays null.
    const past = mem.recall({ subject: "u", asOf: clock.peek(), queryVector: [0, 1, 0] });
    expect(past.facts.map((f) => f.id)).toContain(a);
    expect(mem.why(a).fact.lastAccessedAt).toBeNull();
    mem.close();
  });
});
