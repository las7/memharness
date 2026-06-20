// Worker for the cold-start concurrency regression test (concurrency.test.ts).
// Spawned as its own OS process so it gets an independent SQLite connection and
// genuinely races other processes opening the same brand-new db file. Args:
//   <dbPath> <tag> <count>
// Opens the db (running migrations on a fresh file) and writes <count> facts,
// then exits 0. Any open/migration/write failure exits non-zero with the error.
import { Memharness } from "../../src/memory.js";

const [dbPath, tag, countStr] = process.argv.slice(2);
try {
  const mem = Memharness.open({ dbPath: dbPath as string });
  const n = Number(countStr);
  for (let i = 0; i < n; i++) mem.remember({ subject: "c", fact: `${tag}-${i}` });
  mem.close();
  process.exit(0);
} catch (err) {
  process.stderr.write(`${(err as { code?: string }).code ?? ""} ${String(err)}\n`);
  process.exit(1);
}
