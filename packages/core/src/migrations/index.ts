import type { Database } from "better-sqlite3";
import { MemharnessError } from "../errors.js";
import { m001 } from "./m001_initial.js";
import { m002 } from "./m002_porter_fts.js";
import { m003 } from "./m003_ranking_dimensions.js";
import { m004 } from "./m004_vec.js";
import { m005 } from "./m005_source_staleness.js";

const MIGRATIONS: Array<(db: Database) => void> = [m001, m002, m003, m004, m005];

/** Forward-only, user_version-driven. Returns the resulting schema version. */
export function runMigrations(db: Database): number {
  const tooNew = (v: number): MemharnessError =>
    new MemharnessError(
      "SCHEMA_TOO_NEW",
      `database schema version ${v} is newer than this @memharness/core understands ` +
        `(max ${MIGRATIONS.length}); upgrade the package`,
    );
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > MIGRATIONS.length) throw tooNew(current);
  // Fast path: already current — don't take a write lock on every open.
  if (current === MIGRATIONS.length) return current;
  // Apply pending migrations under a single BEGIN IMMEDIATE so two processes
  // opening a fresh db serialize on the write lock (busy_timeout makes the loser
  // wait, not crash). Re-read user_version inside the lock: a peer may have
  // migrated while we waited, leaving nothing to do. Without this, the loser
  // raced the user_version check and re-ran m001 -> "table facts already exists".
  db.transaction(() => {
    let v = db.pragma("user_version", { simple: true }) as number;
    if (v > MIGRATIONS.length) throw tooNew(v);
    for (; v < MIGRATIONS.length; v++) {
      MIGRATIONS[v]!(db);
      db.pragma(`user_version = ${v + 1}`);
    }
  }).immediate();
  return MIGRATIONS.length;
}
