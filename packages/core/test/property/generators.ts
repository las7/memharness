import fc from "fast-check";

export const SUBJECTS = ["user", "project:a", "project:b", "env"] as const;
export const SOURCE_REFS = ["session-1", "session-2", "file:notes.md"] as const;
const WORDS = ["tea", "tokyo", "sqlite", "vim", "deploy", "alpha", "beta", "gamma"] as const;

/** Milliseconds between ops. 0 exercises same-millisecond collisions. */
const deltaMs = fc.constantFrom(0, 1, 7, 86_400_000);

export type Op =
  | {
      type: "remember";
      subjectIdx: number;
      words: number[];
      confidence: number;
      validFromOffsetMs: number; // relative to op time; negative = backdated, positive = future
      sourceRefIdx: number;
      deltaMs: number;
    }
  | { type: "revise"; targetSeed: number; words: number[]; backdateMs: number; deltaMs: number }
  | { type: "forgetById"; targetSeed: number; deltaMs: number }
  | { type: "forgetBySource"; sourceRefIdx: number; deltaMs: number };

const rememberOp: fc.Arbitrary<Op> = fc.record({
  type: fc.constant("remember" as const),
  subjectIdx: fc.nat(SUBJECTS.length - 1),
  words: fc.array(fc.nat(WORDS.length - 1), { minLength: 1, maxLength: 4 }),
  confidence: fc.double({ min: 0, max: 1, noNaN: true }),
  validFromOffsetMs: fc.constantFrom(-30 * 86_400_000, -3_600_000, -1, 0, 1, 86_400_000),
  sourceRefIdx: fc.nat(SOURCE_REFS.length - 1),
  deltaMs,
});

const reviseOp: fc.Arbitrary<Op> = fc.record({
  type: fc.constant("revise" as const),
  targetSeed: fc.nat(1000),
  words: fc.array(fc.nat(WORDS.length - 1), { minLength: 1, maxLength: 4 }),
  // 0 = plain revise; >0 = backdated validFrom (clamped into the old fact's life)
  backdateMs: fc.constantFrom(0, 1, 3_600_000, 86_400_000),
  deltaMs,
});

const forgetByIdOp: fc.Arbitrary<Op> = fc.record({
  type: fc.constant("forgetById" as const),
  targetSeed: fc.nat(1000),
  deltaMs,
});

const forgetBySourceOp: fc.Arbitrary<Op> = fc.record({
  type: fc.constant("forgetBySource" as const),
  sourceRefIdx: fc.nat(SOURCE_REFS.length - 1),
  deltaMs,
});

export const opSequence: fc.Arbitrary<Op[]> = fc.array(
  fc.oneof(
    { weight: 5, arbitrary: rememberOp },
    { weight: 3, arbitrary: reviseOp },
    { weight: 2, arbitrary: forgetByIdOp },
    { weight: 1, arbitrary: forgetBySourceOp },
  ),
  { minLength: 1, maxLength: 25 },
);

export function factText(words: number[]): string {
  return words.map((w) => WORDS[w]).join(" ");
}
