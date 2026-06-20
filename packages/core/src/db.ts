import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

/**
 * Default DB path: ~/.memharness/memory.db, honoring XDG_DATA_HOME on Linux.
 * platform/env are injectable for tests.
 */
export function resolveDefaultDbPath(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string {
  if (platform === "linux" && env.XDG_DATA_HOME) {
    return join(env.XDG_DATA_HOME, "memharness", "memory.db");
  }
  return join(homedir(), ".memharness", "memory.db");
}

/** Synchronous sleep (better-sqlite3 is synchronous) for backing off a busy db. */
function syncSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Switch the db to WAL, tolerating a concurrent opener of a fresh file.
 * journal_mode is a persistent property of the file, so only the first opener
 * must set it — but SQLite does NOT invoke the busy-timeout handler for a
 * journal_mode change, so a racing opener gets SQLITE_BUSY immediately instead
 * of waiting. Retry with a short backoff until the file reports WAL (whoever
 * wins sets it for everyone). If it never takes within the budget, proceed in
 * the default journal mode rather than crash session start: correctness holds,
 * only cross-process write concurrency is reduced.
 */
function enableWalMode(db: Database.Database): void {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if ((db.pragma("journal_mode = WAL", { simple: true }) as string) === "wal") return;
    } catch (err) {
      if ((err as { code?: string }).code !== "SQLITE_BUSY") throw err;
    }
    if ((db.pragma("journal_mode", { simple: true }) as string) === "wal") return;
    syncSleep(20);
  }
}

export function openDatabase(dbPath: string, readonly = false): Database.Database {
  if (!readonly && dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath, readonly ? { readonly: true, fileMustExist: true } : {});
  // busy_timeout FIRST, before any pragma or migration that can contend: a
  // concurrent opener (Claude Desktop + Claude Code, or two fresh sessions on a
  // not-yet-created db) then waits up to 5s for the lock instead of failing
  // immediately with SQLITE_BUSY.
  db.pragma("busy_timeout = 5000");
  if (!readonly) {
    // WAL pragmas write to the db header / create -wal, so only on a writer.
    enableWalMode(db);
    db.pragma("synchronous = NORMAL");
  }
  db.pragma("foreign_keys = ON");
  return db;
}

/**
 * Load the sqlite-vec extension (cosine KNN for hybrid recall). Returns false
 * if the native build is unavailable, so recall degrades to FTS-only rather
 * than crashing. The extension is per-connection.
 */
export function loadVecExtension(db: Database.Database): boolean {
  try {
    sqliteVec.load(db);
    db.prepare("SELECT vec_version()").pluck().get();
    return true;
  } catch {
    return false;
  }
}
