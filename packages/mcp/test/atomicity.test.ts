import { describe, expect, it } from "vitest";
import { atomicitySmell } from "../src/server.js";

describe("atomicitySmell (write-path compound-fact nudge)", () => {
  it("stays quiet on a normal one-assertion fact", () => {
    expect(atomicitySmell("Seiji lives in Osaka.")).toBeNull();
    expect(
      atomicitySmell(
        "Name a memharness project subject after its GitHub repo, not the product/brand name.",
      ),
    ).toBeNull();
  });

  it("flags a short compound fact joined by a semicolon (the length gates miss this)", () => {
    const fact =
      "Seiji's personal GitHub account is 'las7' (id 98077186); the gh CLI on this machine is authenticated as las7.";
    expect(fact.length).toBeLessThan(280); // would slip past the length-based gates
    const smell = atomicitySmell(fact);
    expect(smell).not.toBeNull();
    expect(smell).toContain("semicolon");
  });

  it("does not fire on a semicolon inside a terse note below the length floor", () => {
    expect(atomicitySmell("ts; py; rs")).toBeNull();
  });

  it("flags an over-long fact even without a semicolon", () => {
    const longFact = `${"durable preference, ".repeat(16)}done.`;
    expect(longFact.length).toBeGreaterThan(280);
    expect(atomicitySmell(longFact)).not.toBeNull();
  });

  it("does not regress on the atomic facts produced by splitting a compound", () => {
    // Each of these is a single assertion carved out of a former compound fact.
    const atomicFacts = [
      "Seiji's Hacker News handle is sakuraiben.",
      "Seiji's X/Twitter handle is @heapsmasher.",
      "As of June 2026, Seiji's history/archives product effort is focused on the WW2 data niche.",
      "The gh CLI on Seiji's machine is authenticated as las7.",
      "Before creating a new memharness project:NAME subject, recall first to confirm no equivalent subject already exists.",
    ];
    for (const fact of atomicFacts) {
      expect(atomicitySmell(fact)).toBeNull();
    }
  });
});
