import { describe, expect, it } from "vitest";
import { ids, openTestDb } from "./helpers.js";

describe("recall (current beliefs)", () => {
  it("returns current beliefs only: excludes superseded and retracted", () => {
    const { mem } = openTestDb();
    const keep = mem.remember({ subject: "user", fact: "likes tea" }).id;
    const old = mem.remember({ subject: "user", fact: "lives in Osaka" }).id;
    mem.revise({ oldFactId: old, newFact: "lives in Tokyo" });
    const gone = mem.remember({ subject: "user", fact: "uses vim" }).id;
    mem.forget({ factId: gone });

    const result = mem.recall();
    const got = ids(result);
    expect(got).toContain(keep);
    expect(got).not.toContain(old);
    expect(got).not.toContain(gone);
    expect(result.asOf).toBeNull();
    expect(result.usedFallback).toBe(false);
  });

  it("matches query via FTS across subject, predicate, and fact columns", () => {
    const { mem } = openTestDb();
    const bySubject = mem.remember({ subject: "project:tako", fact: "uses terraform" }).id;
    const byPredicate = mem.remember({ subject: "user", predicate: "tako", fact: "x" }).id;
    const byFact = mem.remember({ subject: "user", fact: "works on tako daily" }).id;
    mem.remember({ subject: "user", fact: "unrelated" });

    expect(ids(mem.recall({ query: "tako" }))).toEqual(
      [bySubject, byPredicate, byFact].sort((a, b) => a - b),
    );
  });

  it("requires all tokens of a multi-word query (AND semantics)", () => {
    const { mem } = openTestDb();
    const both = mem.remember({ subject: "user", fact: "drinks green tea" }).id;
    mem.remember({ subject: "user", fact: "drinks coffee" });
    mem.remember({ subject: "user", fact: "tea ceremony fan" });

    expect(ids(mem.recall({ query: "drinks tea" }))).toEqual([both]);
  });

  it("subject filter is exact-match and combinable with query", () => {
    const { mem } = openTestDb();
    const a = mem.remember({ subject: "project:a", fact: "uses sqlite" }).id;
    mem.remember({ subject: "project:b", fact: "uses sqlite" });
    mem.remember({ subject: "project:a", fact: "uses redis" });

    expect(ids(mem.recall({ subject: "project:a", query: "sqlite" }))).toEqual([a]);
    expect(mem.recall({ subject: "project:" }).facts).toHaveLength(0);
  });

  it("respects limit, default 8", () => {
    const { mem } = openTestDb();
    for (let i = 0; i < 12; i++) {
      mem.remember({ subject: "user", fact: `fact number ${i}` });
    }
    expect(mem.recall().facts).toHaveLength(8);
    expect(mem.recall({ limit: 3 }).facts).toHaveLength(3);
    expect(mem.recall({ limit: 100 }).facts).toHaveLength(12);
  });

  it("never throws on FTS-hostile queries and still finds literal matches", () => {
    const { mem } = openTestDb();
    const id = mem.remember({ subject: "user", fact: 'says "hello (world)" often' }).id;
    // None of these may throw, whatever the FTS5 parser thinks of them.
    for (const q of ['"', "(", "((", "NEAR(", '*"']) {
      expect(() => mem.recall({ query: q })).not.toThrow();
    }
    const result = mem.recall({ query: "(world)" });
    expect(result.facts.map((f) => f.id)).toContain(id);
  });

  it("falls back to substring matching when FTS finds nothing", () => {
    const { mem } = openTestDb();
    const id = mem.remember({ subject: "project:a", fact: "uses postgresql replicas" }).id;
    // "postgresq" is not a full token, so FTS misses; the LIKE fallback catches it.
    const result = mem.recall({ query: "postgresq" });
    expect(result.usedFallback).toBe(true);
    expect(result.facts.map((f) => f.id)).toContain(id);
  });

  it("any-token stage still applies subject filter and excludes retracted/superseded", () => {
    const { mem } = openTestDb();
    const live = mem.remember({ subject: "a", fact: "contains zebraX marker" }).id;
    mem.remember({ subject: "b", fact: "contains zebraX marker too" });
    const gone = mem.remember({ subject: "a", fact: "old zebraX marker" }).id;
    mem.forget({ factId: gone });
    const old = mem.remember({ subject: "a", fact: "stale zebraX note" }).id;
    mem.revise({ oldFactId: old, newFact: "fresh other note" });

    // "qqq" matches no fact, so the all-tokens stage misses and the any-token
    // stage answers via "zebraX"; filters must survive the escalation.
    const result = mem.recall({ query: "zebraX qqq", subject: "a" });
    expect(result.usedFallback).toBe(false);
    expect(ids(result)).toEqual([live]);
  });

  it("stems tokens: 'drink' finds 'drinks', 'own' finds 'owned'", () => {
    const { mem } = openTestDb();
    const a = mem.remember({ subject: "user", fact: "drinks oolong tea daily" }).id;
    const b = mem.remember({ subject: "user", fact: "owned a kei truck once" }).id;
    expect(ids(mem.recall({ query: "drink" }))).toEqual([a]);
    const owned = mem.recall({ query: "own" });
    expect(ids(owned)).toEqual([b]);
    expect(owned.usedFallback).toBe(false);
  });

  it("finds a fact when only some query tokens appear (the dogfood miss)", () => {
    const { mem } = openTestDb();
    // Live regression from 2026-06-09: this fact was missed by the query
    // "work employer company" under exact-token AND matching.
    const id = mem.remember({
      subject: "user",
      fact: "Seiji's laptop is a company machine owned by Outerport, where he works",
    }).id;
    const result = mem.recall({ query: "work employer company" });
    expect(result.facts.map((f) => f.id)).toContain(id);
    expect(result.usedFallback).toBe(false);
  });

  it("escapes embedded double quotes so quoted text does not trigger fallback", () => {
    const { mem } = openTestDb();
    const id = mem.remember({ subject: "user", fact: 'prefers the "dracula" theme' }).id;
    const result = mem.recall({ query: '"dracula"' });
    expect(result.usedFallback).toBe(false);
    expect(result.facts.map((f) => f.id)).toContain(id);
  });

  it("returns empty facts array, not an error, when nothing matches", () => {
    const { mem } = openTestDb();
    mem.remember({ subject: "user", fact: "something" });
    const result = mem.recall({ query: "zzzqqq" });
    expect(result.facts).toEqual([]);
  });

  it("maxTokens truncates results and sets truncated", () => {
    const { mem } = openTestDb();
    for (let i = 0; i < 10; i++) {
      mem.remember({ subject: "user", fact: `memorable detail number ${i} padded out a bit` });
    }
    const full = mem.recall({ limit: 10 });
    expect(full.truncated).toBe(false);
    expect(full.facts).toHaveLength(10);

    const budget = mem.recall({ limit: 10, maxTokens: 30 });
    expect(budget.truncated).toBe(true);
    expect(budget.facts.length).toBeGreaterThan(0);
    expect(budget.facts.length).toBeLessThan(10);
  });

  it("scores: higher confidence wins at equal age; newer wins at equal confidence", () => {
    const { mem, clock } = openTestDb();
    const low = mem.remember({ subject: "u", fact: "alpha low", confidence: 0.4 }).id;
    const high = mem.remember({ subject: "u", fact: "alpha high", confidence: 0.9 }).id;
    const byConf = mem.recall({ query: "alpha" });
    expect(byConf.facts[0]!.id).toBe(high);
    expect(byConf.facts[1]!.id).toBe(low);
    expect(byConf.facts[0]!.score).toBeGreaterThan(byConf.facts[1]!.score);

    clock.advance(200 * 24 * 3600 * 1000); // 200 days
    const older = mem.remember({ subject: "v", fact: "beta same" }).id;
    clock.advance(100 * 24 * 3600 * 1000);
    const newer = mem.remember({ subject: "v", fact: "beta same" }).id;
    const byAge = mem.recall({ query: "beta" });
    expect(byAge.facts.map((f) => f.id)).toEqual([newer, older]);
  });
});
