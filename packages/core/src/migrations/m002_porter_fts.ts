import type { Database } from "better-sqlite3";

/**
 * Rebuild the FTS index with porter stemming ("work" matches "works"/"worked").
 * Porter wraps unicode61, so non-Latin text tokenizes exactly as before.
 * Trigger DDL is duplicated from m001 on purpose: migrations are frozen history.
 */
export function m002(db: Database): void {
  db.exec(`
DROP TRIGGER facts_ai;
DROP TRIGGER facts_ad;
DROP TRIGGER facts_au;
DROP TABLE facts_fts;

CREATE VIRTUAL TABLE facts_fts USING fts5(
  subject, predicate, fact, content='facts', content_rowid='id',
  tokenize='porter unicode61'
);

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

INSERT INTO facts_fts(facts_fts) VALUES ('rebuild');
`);
}
