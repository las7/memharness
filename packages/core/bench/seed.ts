import { existsSync, rmSync } from "node:fs";
import { FakeClock } from "../src/clock.js";
import { Memharness } from "../src/memory.js";
import { BENCH_DB, FACT_COUNT, SEED_START, lcg, makeVocabulary, pickSubject } from "./lib.js";

const reuse = process.argv.includes("--reuse");
if (reuse && existsSync(BENCH_DB)) {
  console.log(`reusing ${BENCH_DB}`);
  process.exit(0);
}
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(BENCH_DB + suffix, { force: true });
}

const rand = lcg(7);
const vocab = makeVocabulary();
// ~315s between facts spreads 100k txAt over ~1 simulated year
const clock = new FakeClock(SEED_START, 315_000);
const mem = Memharness.open({ dbPath: BENCH_DB, clock });

const t0 = process.hrtime.bigint();
const liveIds: number[] = [];
let revisions = 0;
let retractions = 0;

for (let i = 0; i < FACT_COUNT; i++) {
  const roll = rand();
  if (roll < 0.1 && liveIds.length > 100) {
    // 10%: revise a random earlier live fact (creates supersession chains)
    const slot = Math.floor(rand() * liveIds.length);
    const wordCount = 6 + Math.floor(rand() * 15);
    const words = Array.from({ length: wordCount }, () => vocab[Math.floor(rand() * vocab.length)]);
    const { newId } = mem.revise({ oldFactId: liveIds[slot]!, newFact: words.join(" ") });
    liveIds[slot] = newId;
    revisions++;
  } else {
    const wordCount = 6 + Math.floor(rand() * 15);
    const words = Array.from({ length: wordCount }, () => vocab[Math.floor(rand() * vocab.length)]);
    const { id } = mem.remember({
      subject: pickSubject(rand),
      fact: words.join(" "),
      confidence: 0.5 + rand() * 0.5,
      sourceRef: `session-${Math.floor(rand() * 500)}`,
      sourceAgent: "bench",
    });
    if (roll > 0.98) {
      // 2%: immediately retracted
      mem.forget({ factId: id });
      retractions++;
    } else {
      liveIds.push(id);
    }
  }
  if ((i + 1) % 20_000 === 0) console.log(`  ${i + 1}/${FACT_COUNT}`);
}

const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
const s = mem.stats();
console.log(
  `seeded ${s.totalFacts} facts (${revisions} revisions, ${retractions} retractions, ` +
    `${s.currentBeliefs} current) in ${seconds.toFixed(1)}s → ${BENCH_DB}`,
);
mem.close();
