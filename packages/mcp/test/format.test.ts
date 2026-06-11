import type { Fact } from "@memharness/core";
import { describe, expect, it } from "vitest";
import { fmtDiff, fmtFact, fmtRecall } from "../src/format.js";

function fact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: 1,
    subject: "user",
    predicate: "",
    fact: "drinks oolong tea",
    confidence: 1.0,
    importance: 5,
    kind: "semantic",
    validFrom: "2026-03-01T10:00:00.000Z",
    validTo: null,
    txAt: "2026-03-01T10:00:00.000Z",
    supersededBy: null,
    sourceAgent: "claude-desktop",
    sourceRef: "",
    retractedAt: null,
    lastAccessedAt: null,
    ...overrides,
  };
}

// Golden strings: byte-compatible with the Python prototype's fmt().
describe("fmtFact", () => {
  it("renders the basic form", () => {
    expect(fmtFact(fact())).toBe("[#1] user : drinks oolong tea  {conf=1.00, src=claude-desktop}");
  });

  it("renders predicate, ref, and time details", () => {
    const f = fact({
      id: 2,
      predicate: "prefers",
      fact: "dark mode",
      confidence: 0.8,
      sourceAgent: "cc",
      sourceRef: "session-1",
    });
    expect(fmtFact(f, true)).toBe(
      "[#2] user (prefers) : dark mode  {conf=0.80, src=cc, ref=session-1, valid 2026-03-01 → now, learned 2026-03-01}",
    );
  });

  it("shows importance and kind only when non-default", () => {
    expect(fmtFact(fact({ importance: 5, kind: "semantic" }))).not.toContain("imp=");
    expect(fmtFact(fact({ importance: 9, kind: "procedural" }))).toContain(
      "imp=9, kind=procedural",
    );
  });

  it("marks supersession and retraction", () => {
    const f = fact({ supersededBy: 9, validTo: "2026-04-01T00:00:00.000Z" });
    expect(fmtFact(f)).toContain("superseded_by=#9");
    expect(fmtFact(fact({ retractedAt: "2026-04-01T00:00:00.000Z" }))).toContain("RETRACTED");
  });
});

describe("fmtRecall", () => {
  it("renders the no-match message with the as-of suffix", () => {
    expect(fmtRecall({ facts: [], asOf: null, truncated: false, usedFallback: false })).toBe(
      "No matching memories.",
    );
    expect(
      fmtRecall({
        facts: [],
        asOf: "2026-06-01T00:00:00.000Z",
        truncated: false,
        usedFallback: false,
      }),
    ).toBe("No matching memories. (as of 2026-06-01T00:00:00.000Z)");
  });

  it("uses the as-of header and time details in as-of mode", () => {
    const out = fmtRecall({
      facts: [{ ...fact(), score: 1 }],
      asOf: "2026-06-01T00:00:00.000Z",
      truncated: false,
      usedFallback: false,
    });
    expect(out.startsWith("Beliefs as of 2026-06-01T00:00:00.000Z:")).toBe(true);
    expect(out).toContain("valid 2026-03-01 → now");
  });
});

describe("fmtDiff", () => {
  it("renders all three sections with (none) placeholders", () => {
    const out = fmtDiff({
      since: "2026-06-01T00:00:00.000Z",
      learned: [fact()],
      revised: [],
      retracted: [],
    });
    expect(out).toContain("Memory changes since 2026-06-01T00:00:00.000Z:");
    expect(out).toContain("LEARNED (1):");
    expect(out).toContain("REVISED (0):\n  (none)");
    expect(out).toContain("RETRACTED (0):\n  (none)");
  });
});
