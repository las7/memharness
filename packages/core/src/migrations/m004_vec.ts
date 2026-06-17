import type { Database } from "better-sqlite3";

/**
 * Hybrid recall metadata. The embedding BLOB itself was reserved in m001;
 * these columns record the vector's dimension and source model so recall can
 * skip dimension-mismatched rows and a reembed pass can detect model drift.
 * Embeddings are computed out-of-band (a cold backfill), never in the write
 * path — invariant I5 (no model/network in core) is preserved.
 */
export function m004(db: Database): void {
  db.exec(`
ALTER TABLE facts ADD COLUMN embedding_dim INTEGER;
ALTER TABLE facts ADD COLUMN embedding_model TEXT;
`);
}
