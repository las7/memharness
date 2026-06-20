// Every SQL string lives here: the seam that keeps a future driver swap
// (e.g. node:sqlite, Postgres) mechanical.

export const INSERT_FACT = `
INSERT INTO facts (subject, predicate, fact, confidence, importance, kind, valid_from, valid_to, tx_at, source_agent, source_ref, source_commit, source_path)
VALUES (@subject, @predicate, @fact, @confidence, @importance, @kind, @validFrom, NULL, @txAt, @sourceAgent, @sourceRef, @sourceCommit, @sourcePath)`;

export const GET_FACT = "SELECT * FROM facts WHERE id = ?";

export const GET_PREDECESSOR = "SELECT * FROM facts WHERE superseded_by = ?";

export const SUPERSEDE_FACT =
  "UPDATE facts SET valid_to = @ts, superseded_by = @newId WHERE id = @oldId";

export const RETRACT_BY_ID =
  "UPDATE facts SET retracted_at = @ts WHERE id = @id AND retracted_at IS NULL RETURNING id";

export const RETRACT_BY_SOURCE_REF =
  "UPDATE facts SET retracted_at = @ts WHERE source_ref = @sourceRef AND retracted_at IS NULL RETURNING id";

export const CURRENT_FILTER =
  "f.valid_from <= @now AND f.valid_to IS NULL AND f.superseded_by IS NULL AND f.retracted_at IS NULL";

export const AS_OF_FILTER = `f.tx_at <= @asOf AND f.valid_from <= @asOf
  AND (f.valid_to IS NULL OR f.valid_to > @asOf)
  AND (f.retracted_at IS NULL OR f.retracted_at > @asOf)`;

export const SUBJECT_FILTER = "f.subject = @subject";

export const KIND_FILTER = "f.kind = @kind";

export const LIKE_FILTER = `(f.subject LIKE @pattern ESCAPE '\\'
  OR f.predicate LIKE @pattern ESCAPE '\\'
  OR f.fact LIKE @pattern ESCAPE '\\')`;

/**
 * Per-row effective half-life: base(kind) × (1 + importanceHlWeight·(importance−5)),
 * floored so importance can never make decay non-positive. Mirrors
 * ranking.ts effectiveHalfLife.
 */
export const EFFECTIVE_HALFLIFE_EXPR = `(
  (CASE f.kind
     WHEN 'episodic'   THEN @hlEpisodic
     WHEN 'procedural' THEN @hlProcedural
     ELSE @hlSemantic
   END)
  * max(@minHlFactor, 1.0 + @importanceHlWeight * (f.importance - 5))
)`;

/** Age in days from last access (reinforce-on-access) or txAt, clamped at 0 for future stamps. */
export const AGE_EXPR =
  "max(0, julianday(@now) - julianday(COALESCE(f.last_accessed_at, f.tx_at)))";

/** Recency decay: 0.5^(age / effectiveHalfLife). */
export const DECAY_EXPR = `pow(0.5, ${AGE_EXPR} / ${EFFECTIVE_HALFLIFE_EXPR})`;

/** Direct salience multiplier: 1 + importanceWeight·(importance−5). */
export const IMPORTANCE_BOOST_EXPR = "(1.0 + @importanceWeight * (f.importance - 5))";

/**
 * Source-staleness multiplier. 'stale'/'unresolved' demote; 'current', NULL
 * (unpinned/unchecked), and any unknown value are neutral. Mirrors
 * ranking.ts freshnessFactor.
 */
export const FRESHNESS_FACTOR_EXPR = `(CASE f.freshness
  WHEN 'stale'      THEN @staleWeight
  WHEN 'unresolved' THEN @unresolvedWeight
  ELSE 1.0
END)`;

export function recallQuery(opts: { fts: boolean; filters: string[] }): string {
  const where = opts.filters.length > 0 ? `WHERE ${opts.filters.join(" AND ")}` : "";
  if (opts.fts) {
    // Drive from the (small, capped) FTS match set and look facts up by primary
    // key, instead of scanning every current fact and probing FTS per row.
    // MATERIALIZED pins that join order: without it SQLite drives from the ~88k
    // current facts and the unfiltered keyword path degrades to ~12ms.
    return `
WITH m AS MATERIALIZED (
  SELECT rowid AS id, row_number() OVER (ORDER BY rank) AS fts_rank
  FROM facts_fts WHERE facts_fts MATCH @match
  ORDER BY rank LIMIT @cap
)
SELECT f.*, m.fts_rank AS fts_rank,
       (1.0 / (@rrfK + m.fts_rank)) * f.confidence * ${IMPORTANCE_BOOST_EXPR} * ${DECAY_EXPR} * ${FRESHNESS_FACTOR_EXPR} AS score
FROM m CROSS JOIN facts f ON f.id = m.id
${where}
ORDER BY score DESC, f.tx_at DESC, f.id DESC
LIMIT @limit`;
  }
  return `
SELECT f.*, NULL AS fts_rank,
       1.0 * f.confidence * ${IMPORTANCE_BOOST_EXPR} * ${DECAY_EXPR} * ${FRESHNESS_FACTOR_EXPR} AS score
FROM facts f
${where}
ORDER BY score DESC, f.tx_at DESC, f.id DESC
LIMIT @limit`;
}

/**
 * Current beliefs for one subject, id + fact text only — the candidate set the
 * write-path near-duplicate / contradiction check scores lexically in JS. Capped
 * because a subject's live belief set is small; this is a pre-insert advisory, not
 * a hot path. Pure read, no reinforce.
 */
export const CURRENT_SUBJECT_FACTS = `SELECT f.id, f.fact FROM facts f
WHERE ${CURRENT_FILTER} AND ${SUBJECT_FILTER}
LIMIT @cap`;

/** Nearest current same-subject facts by cosine distance — the optional vector leg of nearDuplicates. */
export const SUBJECT_VEC_NEIGHBORS = `SELECT f.id, vec_distance_cosine(f.embedding, @queryVec) AS dist
FROM facts f
WHERE ${CURRENT_FILTER} AND ${SUBJECT_FILTER}
  AND f.embedding IS NOT NULL AND f.embedding_dim = @queryDim
ORDER BY dist LIMIT @cap`;

/** Reinforce-on-access: freshen last_accessed_at for the returned current-mode facts (ranking only). */
export const REINFORCE_ACCESS =
  "UPDATE facts SET last_accessed_at = ? WHERE id IN (SELECT value FROM json_each(?))";

/** Attach a vector to a fact (cold backfill; never the write path). */
export const SET_EMBEDDING =
  "UPDATE facts SET embedding = @embedding, embedding_dim = @dim, embedding_model = @model WHERE id = @id";

export const COUNT_EMBEDDED = "SELECT COUNT(*) AS c FROM facts WHERE embedding IS NOT NULL";

/** Facts lacking a current-model embedding (oldest first) — the reembed backfill work-list. */
export const EMBED_TARGETS = `SELECT id, subject, predicate, fact FROM facts
WHERE embedding IS NULL OR embedding_model IS NULL OR embedding_model != @model
ORDER BY id LIMIT @limit`;

/**
 * Live, pinned facts oldest-first — the source-staleness work-list (EMBED_TARGETS
 * shape). Hits the partial idx_facts_pinned (m005). source_ref is returned for
 * first-run backfill (parsing a SHA out of free-text refs). Only facts that are
 * still current (not superseded, not retracted) are checked.
 */
export const STALENESS_TARGETS = `SELECT id, source_ref, source_commit, source_path FROM facts
WHERE source_commit IS NOT NULL AND retracted_at IS NULL AND superseded_by IS NULL
ORDER BY id LIMIT @limit`;

/**
 * The ONLY writer of freshness/checked_*; UPDATE of source-axis columns only —
 * never tx_at, valid_from/valid_to, fact, or confidence, so I1 (tx_at immutable)
 * and I4 (never delete) hold. source_commit/source_path are optionally
 * overwritten for first-run backfill (COALESCE keeps existing values when unset).
 */
export const SET_STALENESS = `UPDATE facts SET
  freshness = @freshness,
  checked_at = @checkedAt,
  checked_head = @checkedHead,
  source_commit = COALESCE(@sourceCommit, source_commit),
  source_path = COALESCE(@sourcePath, source_path)
WHERE id = @id`;

/**
 * Hybrid recall: RRF-fuse an FTS rank list and a vector-KNN rank list, then
 * apply confidence × importance × decay. Either leg may be absent (a fact
 * present in only one list still scores). The vector CTE brute-forces cosine
 * distance over embedded rows of the matching dimension. Filters apply to the
 * outer rows; the existing recallQuery still serves the rank-free / LIKE paths.
 */
export function hybridRecallQuery(opts: { fts: boolean; vec: boolean; filters: string[] }): string {
  const ctes: string[] = [];
  if (opts.fts) {
    ctes.push(
      "fts AS (SELECT rowid AS id, row_number() OVER (ORDER BY rank) AS r " +
        "FROM facts_fts WHERE facts_fts MATCH @match ORDER BY rank LIMIT @cap)",
    );
  }
  if (opts.vec) {
    ctes.push(
      "vec AS (SELECT id, row_number() OVER (ORDER BY vec_distance_cosine(embedding, @queryVec)) AS r " +
        "FROM facts WHERE embedding IS NOT NULL AND embedding_dim = @queryDim " +
        "ORDER BY vec_distance_cosine(embedding, @queryVec) LIMIT @cap)",
    );
  }
  const ftsRrf = opts.fts ? "(CASE WHEN fts.id IS NULL THEN 0 ELSE 1.0/(@rrfK + fts.r) END)" : "0";
  const vecRrf = opts.vec ? "(CASE WHEN vec.id IS NULL THEN 0 ELSE 1.0/(@rrfK + vec.r) END)" : "0";
  const presence = [opts.fts ? "fts.id IS NOT NULL" : null, opts.vec ? "vec.id IS NOT NULL" : null]
    .filter(Boolean)
    .join(" OR ");
  const joins = [
    opts.fts ? "LEFT JOIN fts ON fts.id = f.id" : "",
    opts.vec ? "LEFT JOIN vec ON vec.id = f.id" : "",
  ].join(" ");
  const where = [`(${presence})`, ...opts.filters].join(" AND ");
  return `
WITH ${ctes.join(",\n")}
SELECT f.*, ${opts.fts ? "fts.r" : "NULL"} AS fts_rank, ${opts.vec ? "vec.r" : "NULL"} AS vec_rank,
       (${ftsRrf} + ${vecRrf}) * f.confidence * ${IMPORTANCE_BOOST_EXPR} * ${DECAY_EXPR} * ${FRESHNESS_FACTOR_EXPR} AS score
FROM facts f ${joins}
WHERE ${where}
ORDER BY score DESC, f.tx_at DESC, f.id DESC
LIMIT @limit`;
}

export const DIFF_LEARNED = `SELECT * FROM facts f
WHERE f.tx_at >= @since AND f.superseded_by IS NULL AND f.retracted_at IS NULL
  AND (@subject IS NULL OR f.subject = @subject)
ORDER BY f.tx_at, f.id`;

export const DIFF_REVISED = `SELECT * FROM facts f
WHERE f.valid_to >= @since AND f.superseded_by IS NOT NULL
  AND (@subject IS NULL OR f.subject = @subject)
ORDER BY f.valid_to, f.id`;

export const DIFF_RETRACTED = `SELECT * FROM facts f
WHERE f.retracted_at >= @since
  AND (@subject IS NULL OR f.subject = @subject)
ORDER BY f.retracted_at, f.id`;

export const STATS_TOTAL = "SELECT COUNT(*) AS c FROM facts";

export const STATS_CURRENT = `SELECT COUNT(*) AS c FROM facts f WHERE ${CURRENT_FILTER}`;

export const STATS_TOP_SUBJECTS = `SELECT f.subject, COUNT(*) AS c FROM facts f
WHERE ${CURRENT_FILTER}
GROUP BY f.subject ORDER BY c DESC, f.subject LIMIT 10`;

export const FTS_INTEGRITY_CHECK =
  "INSERT INTO facts_fts(facts_fts, rank) VALUES ('integrity-check', 1)";
