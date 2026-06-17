import { describe, expect, it } from "vitest";
import { classifyFreshness, parseSourceRef } from "../src/staleness.js";
import { openTestDb } from "./helpers.js";

const SHA40 = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

describe("parseSourceRef", () => {
  it("parses the structured repo@<40hex>:path form", () => {
    expect(parseSourceRef(`memharness@${SHA40}:packages/core/src/sql.ts`)).toEqual({
      commit: SHA40,
      path: "packages/core/src/sql.ts",
    });
  });

  it("parses repo@<40hex> with no path", () => {
    expect(parseSourceRef(`memharness@${SHA40}`)).toEqual({ commit: SHA40, path: null });
  });

  it("parses a bare standalone SHA (7..40 hex)", () => {
    expect(parseSourceRef("a1b2c3d")).toEqual({ commit: "a1b2c3d", path: null });
    expect(parseSourceRef(SHA40)).toEqual({ commit: SHA40, path: null });
    // surrounding whitespace is tolerated
    expect(parseSourceRef("  a1b2c3d4e5  ")).toEqual({ commit: "a1b2c3d4e5", path: null });
  });

  it("does NOT parse a hex run embedded in a URL or path (must return null, never a false SHA)", () => {
    // a hex-looking segment inside a URL is not a pin
    expect(parseSourceRef("https://example.com/abc123def456/page")).toBeNull();
    // content-hash-style filename
    expect(parseSourceRef("bundle.a1b2c3d4.js")).toBeNull();
    // a path is something-else-with-hex
    expect(parseSourceRef("src/a1b2c3d4e5f6.ts")).toBeNull();
  });

  it("returns null for non-SHA free text, empty, and nullish refs", () => {
    expect(parseSourceRef("auth.ts")).toBeNull();
    expect(parseSourceRef("session-1")).toBeNull();
    expect(parseSourceRef("user")).toBeNull(); // too short / non-hex
    expect(parseSourceRef("ghijkl")).toBeNull(); // not hex
    expect(parseSourceRef("")).toBeNull();
    expect(parseSourceRef("   ")).toBeNull();
    expect(parseSourceRef(null)).toBeNull();
    expect(parseSourceRef(undefined)).toBeNull();
  });

  it("requires the structured form to use a full 40-hex SHA", () => {
    // 7-hex after @ is not the structured form (full SHA required there); falls
    // through to standalone, but the `@`/non-hex boundary still yields the hex run
    expect(parseSourceRef("repo@a1b2c3d")).toEqual({ commit: "a1b2c3d", path: null });
  });
});

describe("classifyFreshness", () => {
  it("unknown SHA → unresolved (never silently current)", () => {
    expect(
      classifyFreshness({
        isAncestor: false,
        sameAsHead: false,
        pathChanged: false,
        shaKnown: false,
      }),
    ).toBe("unresolved");
  });

  it("pin == HEAD → current", () => {
    expect(
      classifyFreshness({ isAncestor: true, sameAsHead: true, pathChanged: true, shaKnown: true }),
    ).toBe("current");
  });

  it("ancestor of a moved HEAD with a changed path → stale", () => {
    expect(
      classifyFreshness({
        isAncestor: true,
        sameAsHead: false,
        pathChanged: true,
        shaKnown: true,
      }),
    ).toBe("stale");
  });

  it("ancestor of a moved HEAD whose path did NOT change → current", () => {
    expect(
      classifyFreshness({
        isAncestor: true,
        sameAsHead: false,
        pathChanged: false,
        shaKnown: true,
      }),
    ).toBe("current");
  });

  it("diverged pin (not an ancestor, exit 1) → unresolved", () => {
    expect(
      classifyFreshness({
        isAncestor: false,
        sameAsHead: false,
        pathChanged: true,
        shaKnown: true,
      }),
    ).toBe("unresolved");
  });
});

describe("stalenessTargets / setStaleness round-trip", () => {
  it("lists only live pinned facts oldest-first, with the pin fields", () => {
    const { mem } = openTestDb();
    // pinned + live
    const a = mem.remember({
      subject: "project:m",
      fact: "a",
      sourceCommit: SHA40,
      sourcePath: "src/a.ts",
      sourceRef: `m@${SHA40}:src/a.ts`,
    }).id;
    // pinned but superseded → excluded
    const sup = mem.remember({ subject: "project:m", fact: "old", sourceCommit: SHA40 }).id;
    mem.revise({ oldFactId: sup, newFact: "new" }); // revision does not inherit the pin
    // pinned but retracted → excluded
    const ret = mem.remember({ subject: "project:m", fact: "r", sourceCommit: SHA40 }).id;
    mem.forget({ factId: ret });
    // unpinned → excluded
    mem.remember({ subject: "user", fact: "no pin" });
    // another live pinned, written later → comes after `a`
    const b = mem.remember({ subject: "project:m", fact: "b", sourceCommit: SHA40 }).id;

    const targets = mem.stalenessTargets(50);
    expect(targets.map((t) => t.id)).toEqual([a, b]);
    expect(targets[0]).toEqual({
      id: a,
      sourceRef: `m@${SHA40}:src/a.ts`,
      sourceCommit: SHA40,
      sourcePath: "src/a.ts",
    });
    expect(targets[1]!.sourcePath).toBeNull();
  });

  it("setStaleness writes only the source-axis columns and preserves immutables", () => {
    const { mem } = openTestDb();
    const id = mem.remember({
      subject: "project:m",
      fact: "f",
      confidence: 0.8,
      sourceCommit: SHA40,
    }).id;
    const before = mem.why(id).fact;

    mem.setStaleness(id, {
      freshness: "stale",
      checkedAt: "2026-06-16T00:00:00.000Z",
      checkedHead: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    });

    const after = mem.why(id).fact;
    expect(after.freshness).toBe("stale");
    expect(after.checkedAt).toBe("2026-06-16T00:00:00.000Z");
    expect(after.checkedHead).toBe("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    // immutables untouched
    expect(after.txAt).toBe(before.txAt);
    expect(after.validFrom).toBe(before.validFrom);
    expect(after.fact).toBe("f");
    expect(after.confidence).toBe(0.8);
    expect(after.sourceCommit).toBe(SHA40);
  });

  it("setStaleness backfills source_path without clobbering an unset source_commit", () => {
    const { mem } = openTestDb();
    const id = mem.remember({ subject: "project:m", fact: "f", sourceCommit: SHA40 }).id;
    mem.setStaleness(id, {
      freshness: "current",
      checkedAt: "2026-06-16T00:00:00.000Z",
      checkedHead: SHA40,
      sourcePath: "src/x.ts",
    });
    const f = mem.why(id).fact;
    expect(f.sourcePath).toBe("src/x.ts");
    expect(f.sourceCommit).toBe(SHA40); // COALESCE kept the existing commit
    expect(f.freshness).toBe("current");
  });

  it("rejects a non-positive limit", () => {
    const { mem } = openTestDb();
    expect(() => mem.stalenessTargets(0)).toThrow();
  });
});
