import { tmpdir } from "node:os";
import { join } from "node:path";

export const BENCH_DB = join(tmpdir(), "memharness-bench.db");
export const FACT_COUNT = 100_000;
export const SUBJECT_COUNT = 1_000;
export const SEED_START = "2025-06-09T00:00:00.000Z"; // txAt spread over ~1 simulated year

/** Deterministic LCG so seed and bench agree on the vocabulary without sharing state. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export function makeVocabulary(): string[] {
  const rand = lcg(42);
  const syllables = ["ka", "to", "mi", "ren", "su", "ba", "lor", "chi", "den", "va", "po", "zu"];
  const words: string[] = [];
  const seen = new Set<string>();
  while (words.length < 2_000) {
    const n = 2 + Math.floor(rand() * 3);
    let w = "";
    for (let i = 0; i < n; i++) w += syllables[Math.floor(rand() * syllables.length)];
    if (!seen.has(w)) {
      seen.add(w);
      words.push(w);
    }
  }
  return words;
}

/** Zipf-ish subject popularity: squaring biases toward low indices. */
export function pickSubject(rand: () => number): string {
  return `subject:${Math.floor(SUBJECT_COUNT * rand() ** 2)}`;
}

export function percentile(sortedMs: number[], p: number): number {
  const idx = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1);
  return sortedMs[Math.max(0, idx)]!;
}
