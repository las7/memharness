// Every SQL string lives here: the seam that keeps a future driver swap
// (e.g. node:sqlite, Postgres) mechanical.

export const INSERT_FACT = `
INSERT INTO facts (subject, predicate, fact, confidence, importance, kind, valid_from, valid_to, tx_at, source_agent, source_ref)
VALUES (@subject, @predicate, @fact, @confidence, @importance, @kind, @validFrom, NULL, @txAt, @sourceAgent, @sourceRef)`;

export const GET_FACT = "SELECT * FROM facts WHERE id = ?";

export const GET_PREDECESSOR = "SELECT * FROM facts WHERE superseded_by = ?";

export const SUPERSEDE_FACT =
  "UPDATE facts SET valid_to = @ts, superseded_by = @newId WHERE id = @oldId";

export const RETRACT_BY_ID =
  "UPDATE facts SET retracted_at = @ts WHERE id = @id AND retracted_at IS NULL RETURNING id";

export const RETRACT_BY_SOURCE_REF =
  "UPDATE facts SET retracted_at = @ts WHERE source_ref = @sourceRef AND retracted_at IS NULL RETURNING id";

export const CURRENT_FILTER =
  "f.valid_to IS NULL AND f.superseded_by IS NULL AND f.retracted_at IS NULL";

export const AS_OF_FILTER = `f.tx_at <= @asOf AND f.valid_from <= @asOf
  AND (f.valid_to IS NULL OR f.valid_to > @asOf)
  AND (f.retracted_at IS NULL OR f.retracted_at > @asOf)`;

export const SUBJECT_FILTER = "f.subject = @subject";

export const KIND_FILTER = "f.kind = @kind";

export const FTS_JOIN = `JOIN (
  SELECT rowid, row_number() OVER (ORDER BY rank) AS fts_rank
  FROM facts_fts WHERE facts_fts MATCH @match
) m ON m.rowid = f.id`;

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

export function recallQuery(opts: { fts: boolean; filters: string[] }): string {
  const rrf = opts.fts ? "(1.0 / (@rrfK + m.fts_rank))" : "1.0";
  const join = opts.fts ? FTS_JOIN : "";
  const where = opts.filters.length > 0 ? `WHERE ${opts.filters.join(" AND ")}` : "";
  return `
SELECT f.*, ${opts.fts ? "m.fts_rank" : "NULL"} AS fts_rank,
       ${rrf} * f.confidence * ${IMPORTANCE_BOOST_EXPR} * ${DECAY_EXPR} AS score
FROM facts f ${join}
${where}
ORDER BY score DESC, f.tx_at DESC, f.id DESC
LIMIT @limit`;
}

/** Reinforce-on-access: freshen last_accessed_at for the returned current-mode facts (ranking only). */
export const REINFORCE_ACCESS =
  "UPDATE facts SET last_accessed_at = ? WHERE id IN (SELECT value FROM json_each(?))";

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
