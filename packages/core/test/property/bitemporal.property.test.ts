import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/clock.js";
import { Memharness } from "../../src/memory.js";
import { type Op, SOURCE_REFS, SUBJECTS, factText, opSequence } from "./generators.js";
import { Oracle } from "./oracle.js";

const NUM_RUNS = Number(process.env.FC_NUM_RUNS ?? 200);
const BIG = 1_000_000; // effectively no limit

/**
 * The crown-jewel property (I3): for ANY sequence of remember/revise/forget,
 * and ANY probe instant T, recall({asOf: T}) returns exactly the belief set
 * that a naive replay of the event log produces. Plus: current-mode recall
 * matches, rows never disappear (I4), and supersession stays well-formed (I2).
 */
function runScenario(ops: Op[]): void {
  const clock = new FakeClock("2026-01-01T00:00:00.000Z", 0);
  const mem = Memharness.open({ dbPath: ":memory:", clock });
  const oracle = new Oracle();

  try {
    for (const op of ops) {
      clock.advance(op.deltaMs);
      switch (op.type) {
        case "remember": {
          const validFrom = new Date(Date.parse(clock.peek()) + op.validFromOffsetMs).toISOString();
          const { id, txAt } = mem.remember({
            subject: SUBJECTS[op.subjectIdx]!,
            fact: factText(op.words),
            confidence: op.confidence,
            sourceRef: SOURCE_REFS[op.sourceRefIdx]!,
            validFrom,
          });
          oracle.remember({
            id,
            subject: SUBJECTS[op.subjectIdx]!,
            validFrom,
            txAt,
            sourceRef: SOURCE_REFS[op.sourceRefIdx]!,
          });
          break;
        }
        case "revise": {
          // only facts that are not yet superseded are valid targets
          const targets = [...oracle.facts.values()].filter((f) => f.supersededBy === null);
          if (targets.length === 0) break;
          const target = targets[op.targetSeed % targets.length]!;
          // Backdate to now − backdateMs. If the target was itself backdated
          // (validFrom < txAt, a real world-time interval) we must clamp at its
          // validFrom or the revise inverts a meaningful interval and is
          // rejected. But if the target was never backdated (validFrom === txAt,
          // just a learning instant) the correction may land earlier — the
          // "remember now, learn it was true earlier" flow — so we don't clamp.
          // Future-dated targets fall back to a plain revise.
          const t = clock.peek();
          let validFrom: string | undefined;
          if (op.backdateMs > 0 && target.validFrom <= t) {
            const neverBackdated = target.validFrom === target.txAt;
            const floor = neverBackdated ? 0 : Date.parse(target.validFrom);
            validFrom = new Date(Math.max(Date.parse(t) - op.backdateMs, floor)).toISOString();
          }
          const { newId, txAt } = mem.revise({
            oldFactId: target.id,
            newFact: factText(op.words),
            validFrom,
          });
          oracle.revise({
            oldId: target.id,
            newId,
            ts: txAt,
            validFrom: validFrom ?? txAt,
            subject: target.subject,
          });
          break;
        }
        case "forgetById": {
          const all = [...oracle.facts.keys()];
          if (all.length === 0) break;
          const id = all[op.targetSeed % all.length]!;
          mem.forget({ factId: id });
          const actual = mem.why(id).fact.retractedAt;
          if (actual !== null) oracle.forget([id], actual);
          break;
        }
        case "forgetBySource": {
          const ref = SOURCE_REFS[op.sourceRefIdx]!;
          const expectedIds = oracle.idsForSourceRef(ref);
          const r = mem.forget({ sourceRef: ref });
          expect(new Set(r.retractedIds)).toEqual(new Set(expectedIds));
          if (r.retractedIds.length > 0) {
            const ts = mem.why(r.retractedIds[0]!).fact.retractedAt!;
            oracle.forget(r.retractedIds, ts);
          }
          break;
        }
      }
    }

    // --- I4: nothing ever deleted
    expect(mem.stats().totalFacts).toBe(oracle.facts.size);

    // --- current-mode recall matches the oracle. Jump past the largest
    // future validFrom the generators emit (+1 day) so the recall's internal
    // now() and the oracle's probe agree on which facts are already valid.
    clock.advance(3 * 86_400_000);
    const current = new Set(mem.recall({ limit: BIG }).facts.map((f) => f.id));
    expect(current).toEqual(oracle.currentBeliefs(clock.peek()));

    // --- I2: superseded ⇒ closed validity, forward pointer
    for (const f of oracle.facts.values()) {
      const real = mem.why(f.id).fact;
      expect(real.supersededBy).toBe(f.supersededBy);
      if (real.supersededBy !== null) {
        expect(real.validTo).not.toBeNull();
        expect(real.supersededBy).toBeGreaterThan(real.id);
      }
    }

    // --- I3: as_of(T) === oracle belief set, probed at every event time ±1ms
    const events = oracle.eventTimestamps();
    const probes = new Set<string>();
    for (const t of events) {
      const ms = Date.parse(t);
      probes.add(t);
      probes.add(new Date(ms - 1).toISOString());
      probes.add(new Date(ms + 1).toISOString());
    }
    if (events.length >= 2) {
      const mid = (Date.parse(events[0]!) + Date.parse(events[events.length - 1]!)) / 2;
      probes.add(new Date(Math.floor(mid)).toISOString());
    }
    for (const T of probes) {
      const got = new Set(mem.recall({ asOf: T, limit: BIG }).facts.map((f) => f.id));
      const want = oracle.beliefSet(T);
      expect(got, `belief set diverged at asOf=${T}`).toEqual(want);
    }
  } finally {
    mem.close();
  }
}

describe("bi-temporal property (oracle replay)", () => {
  it(`as_of(T) equals replayed belief set for random op sequences (${NUM_RUNS} runs)`, () => {
    fc.assert(
      fc.property(opSequence, (ops) => {
        runScenario(ops);
      }),
      { numRuns: NUM_RUNS, verbose: true },
    );
  });
});
