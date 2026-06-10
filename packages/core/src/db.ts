import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

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
