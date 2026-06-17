#!/usr/bin/env node
// memharness-reembed: backfill vector embeddings for facts that lack a current
// one. This is the COLD path — embeddings are computed here, never in the write
// path — so @memharness/core stays model-free and offline (invariant I5).
// Usage: [MEMHARNESS_DB=...] memharness-reembed
import { Memharness, resolveDefaultDbPath } from "@memharness/core";
import { EMBED_MODEL, embedDocuments } from "@memharness/embed";

const BATCH = 64;

const dbPath = process.env.MEMHARNESS_DB ?? resolveDefaultDbPath();
const mem = Memharness.open({ dbPath });
if (!mem.vecEnabled) {
  process.stderr.write(
    "warning: sqlite-vec did not load here; embeddings are stored but this process can't query them.\n",
  );
}

let total = 0;
for (;;) {
  const targets = mem.embedTargets(EMBED_MODEL, BATCH);
  if (targets.length === 0) break;
  const texts = targets.map((t) => [t.subject, t.predicate, t.fact].filter(Boolean).join(": "));
  const vecs = await embedDocuments(texts);
  for (let i = 0; i < targets.length; i++) {
    const v = vecs[i];
    if (v !== undefined) mem.setEmbedding(targets[i]!.id, v, EMBED_MODEL);
  }
  total += targets.length;
  process.stderr.write(`embedded ${total} (${mem.embeddedCount()} facts now carry vectors)\n`);
}
mem.close();
process.stderr.write(`reembed done: ${total} fact(s) embedded with ${EMBED_MODEL}.\n`);
