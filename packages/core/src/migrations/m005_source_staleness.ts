import type { Database } from "better-sqlite3";

/**
 * Source-staleness signal. A fourth provenance axis: which git commit/path a
 * fact was read from, and the out-of-band verdict on whether the repo has
 * moved past it. All columns are additive with NULL defaults (NULL = "not
 * source-pinned / never checked"), so existing rows migrate with zero ranking
 * and zero recall-output drift — identical to m003/m004's neutral-defaults
 * precedent. None is a belief-set predicate: like importance/kind they affect
 * display/score only, never CURRENT_FILTER / AS_OF_FILTER membership. Git never
 * runs in core (I5); freshness/checked_* are written ONLY by setStaleness()
 * (Phase 2) — in Phase 1 nobody writes them and they stay NULL on every row.
 */
export function m005(db: Database): void {
  db.exec(`
ALTER TABLE facts ADD COLUMN source_commit TEXT;        -- 40-hex SHA the fact was read from; NULL = not code-pinned
ALTER TABLE facts ADD COLUMN source_path   TEXT;        -- file the fact describes; NULL = whole-repo / none
ALTER TABLE facts ADD COLUMN freshness     TEXT
  CHECK (freshness IS NULL OR freshness IN ('current','stale','unresolved'));  -- NULL = unchecked/unpinned
ALTER TABLE facts ADD COLUMN checked_at    TEXT;        -- canonical ISO: when the bin last checked this fact; NULL = never
ALTER TABLE facts ADD COLUMN checked_head  TEXT;        -- the HEAD SHA checked against; surfaces how stale the *check* is

-- Partial work-list index, mirroring idx_facts_current's style (m001:27):
-- the bin scans only live, pinned facts.
CREATE INDEX idx_facts_pinned ON facts(source_commit)
  WHERE source_commit IS NOT NULL AND retracted_at IS NULL AND superseded_by IS NULL;
`);
}
