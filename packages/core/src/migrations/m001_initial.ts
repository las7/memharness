import type { Database } from "better-sqlite3";

export function m001(db: Database): void {
  db.exec(`
CREATE TABLE facts (
  id            INTEGER PRIMARY KEY,
  subject       TEXT NOT NULL,
  predicate     TEXT NOT NULL DEFAULT '',
  fact          TEXT NOT NULL,
  confidence    REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  -- bi-temporal: valid time (true in the world) vs transaction time (when recorded)
  valid_from    TEXT NOT NULL,
  valid_to      TEXT,
  tx_at         TEXT NOT NULL,
  -- supersession: rows are never deleted, so id doubles as the insert sequence
  superseded_by INTEGER REFERENCES facts(id),
  -- provenance
  source_agent  TEXT NOT NULL DEFAULT '',
  source_ref    TEXT NOT NULL DEFAULT '',
  -- tombstone: a timestamp (not a flag) so as_of before the retraction still sees the fact
  retracted_at  TEXT,
  -- reserved for hybrid recall (sqlite-vec), unused in v1
  embedding     BLOB
);

CREATE INDEX idx_facts_subject       ON facts(subject);
CREATE INDEX idx_facts_current       ON facts(valid_to) WHERE valid_to IS NULL;
CREATE INDEX idx_facts_tx            ON facts(tx_at);
CREATE INDEX idx_facts_source_ref    ON facts(source_ref);
CREATE INDEX idx_facts_superseded_by ON facts(superseded_by);

CREATE VIRTUAL TABLE facts_fts USING fts5(
  subject, predicate, fact, content='facts', content_rowid='id'
);

-- External-content FTS needs all three triggers even though v1 only UPDATEs
-- non-indexed columns: any future UPDATE of indexed text or manual DELETE
-- would silently corrupt the index otherwise.
CREATE TRIGGER facts_ai AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts(rowid, subject, predicate, fact)
  VALUES (new.id, new.subject, new.predicate, new.fact);
END;
CREATE TRIGGER facts_ad AFTER DELETE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, subject, predicate, fact)
  VALUES ('delete', old.id, old.subject, old.predicate, old.fact);
END;
CREATE TRIGGER facts_au AFTER UPDATE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, subject, predicate, fact)
  VALUES ('delete', old.id, old.subject, old.predicate, old.fact);
  INSERT INTO facts_fts(rowid, subject, predicate, fact)
  VALUES (new.id, new.subject, new.predicate, new.fact);
END;
`);
}
