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
