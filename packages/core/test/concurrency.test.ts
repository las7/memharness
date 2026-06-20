// Regression test for the cold-start open/migration race: two+ processes
// opening a brand-new db file at the same instant used to crash one of them
// (SQLITE_BUSY on the journal_mode=WAL pragma, or "table facts already exists"
// when both raced the user_version check and re-ran m001). Each worker is a
// real OS process so it gets its own SQLite connection and genuinely contends
// on the file lock — in-process opens are serialized and would not reproduce it.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Memharness } from "../src/memory.js";

const here = dirname(fileURLToPath(import.meta.url));
const worker = join(here, "helpers", "concurrent-open.ts");

function runWorker(
  dbPath: string,
  tag: string,
  count: number,
): Promise<{ code: number | null; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", worker, dbPath, tag, String(count)], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => {
      err += String(d);
    });
    child.on("exit", (code) => resolve({ code, err }));
  });
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("cold-start concurrency", () => {
  it("N processes opening a brand-new db at once all succeed with no lost writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memh-conc-"));
    dirs.push(dir);
    const dbPath = join(dir, "memory.db");
    const N = 4;
    const each = 50;

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => runWorker(dbPath, `w${i}`, each)),
    );
    // No opener may crash on the migration/journal_mode race.
    for (const r of results) expect(r.code, `worker exited ${r.code}: ${r.err}`).toBe(0);

    // Every write from every process persisted: no silent loss under contention.
    // Assert on the raw total, NOT recall(): a fresh reader's clock can briefly
    // sit behind the writers' monotonic-bumped valid_from, so CURRENT_FILTER
    // (valid_from <= now) transiently hides the very newest facts from recall.
    // That visibility effect is separate from durability — the rows are all here.
    const mem = Memharness.open({ dbPath });
    expect(mem.stats().totalFacts).toBe(N * each);
    expect(mem.stats().schemaVersion).toBeGreaterThanOrEqual(1);
    mem.close();
  }, 30_000);
});
