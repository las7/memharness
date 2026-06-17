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

export function openDatabase(dbPath: string): Database.Database {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  // WAL: Claude Desktop and Claude Code may both hold this file open.
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
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
