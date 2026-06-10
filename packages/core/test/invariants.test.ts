import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
import { openTestDb } from "./helpers.js";

describe("invariants", () => {
  it("I1: txAt never changes after insert, across revise and forget", () => {
    const { mem } = openTestDb();
    const a = mem.remember({ subject: "u", fact: "v1" }).id;
    const txBefore = mem.why(a).fact.txAt;
    mem.revise({ oldFactId: a, newFact: "v2" });
    expect(mem.why(a).fact.txAt).toBe(txBefore);
    mem.forget({ factId: a });
    expect(mem.why(a).fact.txAt).toBe(txBefore);
  });

  it("I2: every superseded fact has validTo set and supersededBy pointing forward", () => {
    const { mem } = openTestDb();
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(mem.remember({ subject: `s${i}`, fact: `v1 of ${i}` }).id);
    }
    let head = ids[0]!;
    for (let i = 0; i < 3; i++) {
      head = mem.revise({ oldFactId: head, newFact: `gen ${i + 2}` }).newId;
    }
    mem.forget({ factId: ids[1]! });

    for (let id = 1; id <= mem.stats().totalFacts; id++) {
      const f = mem.why(id).fact;
      if (f.supersededBy !== null) {
        expect(f.validTo).not.toBeNull();
        expect(f.supersededBy).toBeGreaterThan(f.id);
      }
    }
  });

  it("I4: row count never decreases across any operation", () => {
    const { mem } = openTestDb();
    let last = mem.stats().totalFacts;
    const a = mem.remember({ subject: "u", fact: "a" }).id;
    expect(mem.stats().totalFacts).toBeGreaterThanOrEqual(last);
    last = mem.stats().totalFacts;
    mem.revise({ oldFactId: a, newFact: "b" });
    expect(mem.stats().totalFacts).toBeGreaterThanOrEqual(last);
    last = mem.stats().totalFacts;
    mem.forget({ sourceRef: "none" });
    mem.forget({ factId: a });
    expect(mem.stats().totalFacts).toBeGreaterThanOrEqual(last);
  });

  it("I5: no network primitives anywhere in the storage layer source", () => {
    const srcDir = join(here, "..", "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".ts")) {
          const text = readFileSync(p, "utf8");
          if (/\bfetch\s*\(|node:https?|from\s+["']https?|XMLHttpRequest|node:net\b/.test(text)) {
            offenders.push(p);
          }
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });
});
