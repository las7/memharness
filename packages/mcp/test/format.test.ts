import type { Fact } from "@memharness/core";
import { describe, expect, it } from "vitest";
import { fmtDiff, fmtFact, fmtRecall, fmtWhy } from "../src/format.js";

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
    sourceCommit: null,
    sourcePath: null,
    freshness: null,
    checkedAt: null,
    checkedHead: null,
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

  it("renders pin=path@shortsha only when source_commit is set, no STALE tag in Phase 1", () => {
    // unpinned facts show no pin tag
    expect(fmtFact(fact())).not.toContain("pin=");
    const pinned = fact({
      sourceCommit: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      sourcePath: "packages/core/src/sql.ts",
    });
    expect(fmtFact(pinned)).toContain("pin=packages/core/src/sql.ts@a1b2c3d");
    // freshness is null in Phase 1 → no STALE / stale? tags
    expect(fmtFact(pinned)).not.toContain("STALE");
    // pathless pin renders just the 7-char sha
    expect(fmtFact(fact({ sourceCommit: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0" }))).toContain(
      "pin=a1b2c3d",
    );
  });

  it("renders STALE / stale? freshness tags (Phase 2), gated like other meta", () => {
    const pinned = (freshness: Fact["freshness"]): Fact =>
      fact({ sourceCommit: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0", freshness });
    // current / null → no tag
    expect(fmtFact(pinned("current"))).not.toContain("STALE");
    expect(fmtFact(pinned("current"))).not.toContain("stale?");
    expect(fmtFact(pinned(null))).not.toContain("STALE");
    // stale → STALE, after the pin
    const stale = fmtFact(pinned("stale"));
    expect(stale).toContain("STALE");
    expect(stale.indexOf("pin=")).toBeLessThan(stale.indexOf("STALE"));
    // unresolved → stale?
    expect(fmtFact(pinned("unresolved"))).toContain("stale?");
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

  it("adds a drift footer when any returned fact is non-current", () => {
    const stale = { ...fact({ freshness: "stale" }), score: 1 };
    const okOnly = fmtRecall({
      facts: [{ ...fact({ freshness: "current" }), score: 1 }],
      asOf: null,
      truncated: false,
      usedFallback: false,
    });
    expect(okOnly).not.toContain("may have drifted");
    const withStale = fmtRecall({
      facts: [stale],
      asOf: null,
      truncated: false,
      usedFallback: false,
    });
    expect(withStale).toContain("may have drifted");
    // unresolved also triggers the footer
    const withUnresolved = fmtRecall({
      facts: [{ ...fact({ freshness: "unresolved" }), score: 1 }],
      asOf: null,
      truncated: false,
      usedFallback: false,
    });
    expect(withUnresolved).toContain("may have drifted");
  });
});

describe("fmtWhy", () => {
  it("includes checked_head/checked_at when the fact has been checked", () => {
    const f = fact({
      checkedHead: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      checkedAt: "2026-06-16T08:00:00.000Z",
    });
    const out = fmtWhy({ fact: f, ancestors: [], descendants: [] });
    expect(out).toContain("checked_head deadbee");
    expect(out).toContain("checked_at 2026-06-16");
  });

  it("omits the check line when never checked", () => {
    const out = fmtWhy({ fact: fact(), ancestors: [], descendants: [] });
    expect(out).not.toContain("checked_head");
    expect(out).not.toContain("checked_at");
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
