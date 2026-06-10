import { FakeClock } from "../src/clock.js";
import { Memharness } from "../src/memory.js";
import type { RememberInput } from "../src/types.js";

export interface TestDb {
  mem: Memharness;
  clock: FakeClock;
}

/** In-memory db with a deterministic clock starting 2026-01-01, advancing 1s per op. */
export function openTestDb(startIso = "2026-01-01T00:00:00.000Z", autoStepMs = 1000): TestDb {
  const clock = new FakeClock(startIso, autoStepMs);
  const mem = Memharness.open({ dbPath: ":memory:", clock });
  return { mem, clock };
}

export function seedFact(mem: Memharness, overrides: Partial<RememberInput> = {}): number {
  const input: RememberInput = {
    subject: "user",
    fact: "drinks oolong tea",
    ...overrides,
  };
  return mem.remember(input).id;
}

/** Ids of a recall result as a sorted array, for set comparison. */
export function ids(result: { facts: Array<{ id: number }> }): number[] {
  return result.facts.map((f) => f.id).sort((a, b) => a - b);
}
