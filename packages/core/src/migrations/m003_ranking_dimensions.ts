import type { Database } from "better-sqlite3";

/**
 * Ranking dimensions: caller-supplied salience, a cognitive memory kind, and a
 * last-access timestamp for reinforce-on-access decay. All three are additive
 * columns with neutral defaults, so existing rows migrate with zero ranking
 * drift (importance 5 = pivot, kind 'semantic' = today's half-life, NULL
 * last_accessed_at = decay measured from tx_at as before). None is a belief-set
 * predicate: they affect score/order only, never as_of membership.
 */
export function m003(db: Database): void {
  db.exec(`
ALTER TABLE facts ADD COLUMN importance INTEGER NOT NULL DEFAULT 5
  CHECK (importance BETWEEN 1 AND 10);

ALTER TABLE facts ADD COLUMN kind TEXT NOT NULL DEFAULT 'semantic'
  CHECK (kind IN ('semantic','episodic','procedural'));

-- pure ranking metadata; nullable (NULL = never accessed → age falls back to tx_at)
ALTER TABLE facts ADD COLUMN last_accessed_at TEXT;
`);
}
