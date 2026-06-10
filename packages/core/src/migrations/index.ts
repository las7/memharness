import type { Database } from "better-sqlite3";
import { MemharnessError } from "../errors.js";
import { m001 } from "./m001_initial.js";

const MIGRATIONS: Array<(db: Database) => void> = [m001];

/** Forward-only, user_version-driven. Returns the resulting schema version. */
export function runMigrations(db: Database): number {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    throw new MemharnessError(
      "SCHEMA_TOO_NEW",
      `database schema version ${current} is newer than this @memharness/core understands ` +
        `(max ${MIGRATIONS.length}); upgrade the package`,
    );
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      MIGRATIONS[v]!(db);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return MIGRATIONS.length;
}
