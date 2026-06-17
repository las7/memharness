import type { Database, Statement } from "better-sqlite3";
import { SystemClock } from "./clock.js";
import { loadVecExtension, openDatabase, resolveDefaultDbPath } from "./db.js";
import { NotFoundError, ValidationError } from "./errors.js";
import { runMigrations } from "./migrations/index.js";
import { DEFAULT_RANKING, MIN_HALFLIFE_FACTOR, type ResolvedRankingOptions } from "./ranking.js";
import * as sql from "./sql.js";
import { normalizeIso } from "./time.js";
import { estimateTokens } from "./tokens.js";
import type {
  Clock,
  DiffInput,
  DiffResult,
  Fact,
  ForgetInput,
  ForgetResult,
  MemharnessOptions,
  MemoryKind,
  RecallInput,
  RecallResult,
  RememberInput,
  RememberResult,
  ReviseInput,
  ReviseResult,
  ScoredFact,
  StatsResult,
  WhyResult,
} from "./types.js";

interface FactRow {
  id: number;
  subject: string;
  predicate: string;
  fact: string;
  confidence: number;
  importance: number;
  kind: MemoryKind;
  valid_from: string;
  valid_to: string | null;
  tx_at: string;
  superseded_by: number | null;
  source_agent: string;
  source_ref: string;
  source_commit: string | null;
  source_path: string | null;
  freshness: "current" | "stale" | "unresolved" | null;
  checked_at: string | null;
  checked_head: string | null;
  retracted_at: string | null;
  last_accessed_at: string | null;
}

function rowToFact(row: FactRow): Fact {
  return {
    id: row.id,
    subject: row.subject,
    predicate: row.predicate,
    fact: row.fact,
    confidence: row.confidence,
    importance: row.importance,
    kind: row.kind,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    txAt: row.tx_at,
    supersededBy: row.superseded_by,
    sourceAgent: row.source_agent,
    sourceRef: row.source_ref,
    sourceCommit: row.source_commit,
    sourcePath: row.source_path,
    freshness: row.freshness,
    checkedAt: row.checked_at,
    checkedHead: row.checked_head,
    retractedAt: row.retracted_at,
    lastAccessedAt: row.last_accessed_at,
  };
}

function checkConfidence(confidence: number | undefined): number {
  if (confidence === undefined) return 1.0;
  if (
    typeof confidence !== "number" ||
    Number.isNaN(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new ValidationError(`confidence must be in [0, 1], got ${confidence}`);
  }
  return confidence;
}

function checkImportance(importance: number | undefined, fallback: number): number {
  if (importance === undefined) return fallback;
  if (!Number.isInteger(importance) || importance < 1 || importance > 10) {
    throw new ValidationError(`importance must be an integer in [1, 10], got ${importance}`);
  }
  return importance;
}

const KINDS: readonly MemoryKind[] = ["semantic", "episodic", "procedural"];

function checkKind(kind: MemoryKind | undefined, fallback: MemoryKind): MemoryKind {
  if (kind === undefined) return fallback;
  if (!KINDS.includes(kind)) {
    throw new ValidationError(`kind must be one of ${KINDS.join(", ")}, got ${kind}`);
  }
  return kind;
}

function requireText(value: string | undefined, label: string): string {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") throw new ValidationError(`${label} must be a non-empty string`);
  return trimmed;
}

/** Tokens wrapped as quoted FTS5 phrases, internal quotes doubled: never a syntax error. */
function ftsPhrases(query: string): string[] {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replaceAll('"', '""')}"`);
}

function buildLikePattern(query: string): string {
  return `%${query.replaceAll(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/** Pack a float vector into a little-endian Float32 BLOB for sqlite-vec, with its dimension. */
function toVecBlob(vector: Float32Array | number[]): { blob: Buffer; dim: number } {
  const f32 = vector instanceof Float32Array ? vector : Float32Array.from(vector);
  return { blob: Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength), dim: f32.length };
}

export class Memharness {
  private readonly db: Database;
  private readonly clock: Clock;
  private readonly ranking: ResolvedRankingOptions;
  private readonly dbPath: string;
  private readonly schemaVersion: number;
  /** Whether sqlite-vec loaded; false → recall is FTS-only. */
  readonly vecEnabled: boolean;
  private readonly stmts = new Map<string, Statement>();

  private constructor(
    db: Database,
    dbPath: string,
    clock: Clock,
    ranking: ResolvedRankingOptions,
    vecEnabled: boolean,
  ) {
    this.db = db;
    this.dbPath = dbPath;
    this.clock = clock;
    this.ranking = ranking;
    this.vecEnabled = vecEnabled;
    this.schemaVersion = runMigrations(db);
  }

  static open(opts: MemharnessOptions = {}): Memharness {
    const dbPath = opts.dbPath ?? resolveDefaultDbPath();
    const db = openDatabase(dbPath);
    const vecEnabled = loadVecExtension(db);
    const ranking: ResolvedRankingOptions = {
      halfLifeDays: opts.ranking?.halfLifeDays ?? DEFAULT_RANKING.halfLifeDays,
      rrfK: opts.ranking?.rrfK ?? DEFAULT_RANKING.rrfK,
      importanceWeight: opts.ranking?.importanceWeight ?? DEFAULT_RANKING.importanceWeight,
      importanceHalfLifeWeight:
        opts.ranking?.importanceHalfLifeWeight ?? DEFAULT_RANKING.importanceHalfLifeWeight,
      kindHalfLifeDays: {
        ...DEFAULT_RANKING.kindHalfLifeDays,
        ...opts.ranking?.kindHalfLifeDays,
      },
    };
    return new Memharness(db, dbPath, opts.clock ?? new SystemClock(), ranking, vecEnabled);
  }

  /**
   * Attach an embedding to a fact for hybrid recall. Computed out-of-band (a
   * reembed pass), never in remember/revise — keeps the write path model-free
   * (I5). No-op-safe to call repeatedly; overwrites the prior vector.
   */
  setEmbedding(id: number, vector: Float32Array | number[], model: string): void {
    const { blob, dim } = toVecBlob(vector);
    if (dim < 1) throw new ValidationError("embedding vector must be non-empty");
    const m = requireText(model, "model");
    this.prep(sql.SET_EMBEDDING).run({ id, embedding: blob, dim, model: m });
  }

  /** Count of facts that currently carry an embedding (for reembed progress). */
  embeddedCount(): number {
    return (this.prep(sql.COUNT_EMBEDDED).get() as { c: number }).c;
  }

  /** Facts lacking a current-model embedding, oldest first — the reembed backfill work-list. */
  embedTargets(
    model: string,
    limit: number,
  ): Array<{ id: number; subject: string; predicate: string; fact: string }> {
    return this.prep(sql.EMBED_TARGETS).all({
      model: requireText(model, "model"),
      limit,
    }) as Array<{
      id: number;
      subject: string;
      predicate: string;
      fact: string;
    }>;
  }

  /**
   * Live, pinned facts oldest-first — the source-staleness work-list (the
   * source-axis analogue of embedTargets). Pure SQL, no git: the bin runs git
   * and writes verdicts back via setStaleness. source_ref is returned so the
   * bin can backfill a SHA out of free-text refs on its first run.
   */
  stalenessTargets(limit: number): Array<{
    id: number;
    sourceRef: string;
    sourceCommit: string;
    sourcePath: string | null;
  }> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ValidationError(`limit must be a positive integer, got ${limit}`);
    }
    return (
      this.prep(sql.STALENESS_TARGETS).all({ limit }) as Array<{
        id: number;
        source_ref: string;
        source_commit: string;
        source_path: string | null;
      }>
    ).map((r) => ({
      id: r.id,
      sourceRef: r.source_ref,
      sourceCommit: r.source_commit,
      sourcePath: r.source_path,
    }));
  }

  /**
   * Write a precomputed staleness verdict (the source-axis analogue of
   * setEmbedding). The ONLY writer of freshness/checked_*; touches source-axis
   * columns only — never tx_at, valid_from/valid_to, fact, or confidence
   * (preserving I1/I4). May set source_commit/source_path on first-run backfill.
   * No git here (I5):
   * the git logic lives in the memharness-staleness bin.
   */
  setStaleness(
    id: number,
    v: {
      freshness: "current" | "stale" | "unresolved";
      checkedAt: string;
      checkedHead: string;
      sourceCommit?: string;
      sourcePath?: string;
    },
  ): void {
    this.prep(sql.SET_STALENESS).run({
      id,
      freshness: v.freshness,
      checkedAt: v.checkedAt,
      checkedHead: v.checkedHead,
      sourceCommit: v.sourceCommit ?? null,
      sourcePath: v.sourcePath ?? null,
    });
  }

  private prep(sqlText: string): Statement {
    let stmt = this.stmts.get(sqlText);
    if (stmt === undefined) {
      stmt = this.db.prepare(sqlText);
      this.stmts.set(sqlText, stmt);
    }
    return stmt;
  }

  remember(input: RememberInput): RememberResult {
    const subject = requireText(input.subject, "subject");
    const fact = requireText(input.fact, "fact");
    const confidence = checkConfidence(input.confidence);
    const importance = checkImportance(input.importance, 5);
    const kind = checkKind(input.kind, "semantic");
    const txAt = this.clock.now();
    const validFrom =
      input.validFrom !== undefined ? normalizeIso(input.validFrom, "validFrom") : txAt;
    const result = this.prep(sql.INSERT_FACT).run({
      subject,
      predicate: (input.predicate ?? "").trim(),
      fact,
      confidence,
      importance,
      kind,
      validFrom,
      txAt,
      sourceAgent: input.sourceAgent ?? "",
      sourceRef: input.sourceRef ?? "",
      sourceCommit: input.sourceCommit ?? null,
      sourcePath: input.sourcePath ?? null,
    });
    return { id: Number(result.lastInsertRowid), txAt };
  }

  recall(input: RecallInput = {}): RecallResult {
    const query = (input.query ?? "").trim();
    const subject = (input.subject ?? "").trim();
    const limit = input.limit ?? 8;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ValidationError(`limit must be a positive integer, got ${limit}`);
    }
    if (
      input.maxTokens !== undefined &&
      (!Number.isInteger(input.maxTokens) || input.maxTokens < 1)
    ) {
      throw new ValidationError(`maxTokens must be a positive integer, got ${input.maxTokens}`);
    }
    const asOf = input.asOf !== undefined ? normalizeIso(input.asOf, "asOf") : null;

    const kind = input.kind !== undefined ? checkKind(input.kind, "semantic") : null;

    const filters: string[] = [asOf !== null ? sql.AS_OF_FILTER : sql.CURRENT_FILTER];
    const params: Record<string, unknown> = {
      now: this.clock.now(),
      hlSemantic: this.ranking.halfLifeDays,
      hlEpisodic: this.ranking.kindHalfLifeDays.episodic,
      hlProcedural: this.ranking.kindHalfLifeDays.procedural,
      importanceWeight: this.ranking.importanceWeight,
      importanceHlWeight: this.ranking.importanceHalfLifeWeight,
      minHlFactor: MIN_HALFLIFE_FACTOR,
      limit,
    };
    if (asOf !== null) params.asOf = asOf;
    if (subject !== "") {
      filters.push(sql.SUBJECT_FILTER);
      params.subject = subject;
    }
    if (kind !== null) {
      filters.push(sql.KIND_FILTER);
      params.kind = kind;
    }

    const vec = this.vecEnabled && input.queryVector !== undefined && input.queryVector.length > 0;

    let rows: Array<FactRow & { fts_rank: number | null; score: number }>;
    let usedFallback = false;
    if (vec) {
      // Hybrid: RRF-fuse FTS (lexical) and vector KNN (semantic). The FTS leg is
      // included whenever there's also a text query, so facts not yet embedded
      // still surface lexically; the vector leg backstops paraphrase.
      const { blob, dim } = toVecBlob(input.queryVector as Float32Array | number[]);
      const vecParams = { ...params, rrfK: this.ranking.rrfK, queryVec: blob, queryDim: dim };
      if (query !== "") {
        const match = ftsPhrases(query).join(" OR ");
        try {
          rows = this.prep(sql.hybridRecallQuery({ fts: true, vec: true, filters })).all({
            ...vecParams,
            match,
          }) as typeof rows;
        } catch {
          // FTS parse edge case → vector only
          rows = this.prep(sql.hybridRecallQuery({ fts: false, vec: true, filters })).all(
            vecParams,
          ) as typeof rows;
        }
      } else {
        rows = this.prep(sql.hybridRecallQuery({ fts: false, vec: true, filters })).all(
          vecParams,
        ) as typeof rows;
      }
    } else if (query !== "") {
      // Escalating match: all tokens → any token → substring. Each stage keeps
      // every temporal/subject filter; only the text predicate loosens.
      const phrases = ftsPhrases(query);
      const matches = [phrases.join(" ")];
      if (phrases.length > 1) matches.push(phrases.join(" OR "));
      rows = [];
      for (const match of matches) {
        try {
          rows = this.prep(sql.recallQuery({ fts: true, filters })).all({
            ...params,
            match,
            rrfK: this.ranking.rrfK,
          }) as typeof rows;
        } catch {
          rows = [];
        }
        if (rows.length > 0) break;
      }
      if (rows.length === 0) {
        // FTS whiffed entirely (partial word, punctuation-only, parser edge
        // case): substring matching as the last resort.
        usedFallback = true;
        rows = this.prep(
          sql.recallQuery({ fts: false, filters: [...filters, sql.LIKE_FILTER] }),
        ).all({
          ...params,
          pattern: buildLikePattern(query),
        }) as typeof rows;
      }
    } else {
      rows = this.prep(sql.recallQuery({ fts: false, filters })).all(params) as typeof rows;
    }

    const facts: ScoredFact[] = [];
    let truncated = false;
    let budget = input.maxTokens ?? Number.POSITIVE_INFINITY;
    for (const row of rows) {
      const cost = estimateTokens([row.subject, row.predicate, row.fact].filter(Boolean).join(" "));
      if (cost > budget) {
        truncated = true;
        break;
      }
      budget -= cost;
      facts.push({ ...rowToFact(row), score: row.score });
    }

    // Reinforce-on-access: surfacing a current belief freshens its decay clock.
    // Current mode only (historical as_of recall is a pure read), and only the
    // facts actually returned. Writes last_accessed_at — never a belief-set
    // predicate — so membership, as_of, and I1 (tx_at) are untouched.
    if (asOf === null && facts.length > 0) {
      const accessedIds = facts.map((f) => f.id);
      this.prep(sql.REINFORCE_ACCESS).run(this.clock.now(), JSON.stringify(accessedIds));
    }

    return { facts, asOf, truncated, usedFallback };
  }

  revise(input: ReviseInput): ReviseResult {
    const newFact = requireText(input.newFact, "newFact");
    const confidence = checkConfidence(input.confidence);
    const run = this.db.transaction((): ReviseResult => {
      const old = this.prep(sql.GET_FACT).get(input.oldFactId) as FactRow | undefined;
      if (old === undefined) throw new NotFoundError(`no fact #${input.oldFactId}`);
      if (old.superseded_by !== null) {
        // Quote the live head so a caller revising off a stale recall can
        // re-decide against the current text instead of blindly re-applying.
        let head: FactRow = old;
        while (head.superseded_by !== null) {
          const next = this.prep(sql.GET_FACT).get(head.superseded_by) as FactRow | undefined;
          if (next === undefined) break;
          head = next;
        }
        throw new ValidationError(
          `fact #${old.id} is already superseded by #${old.superseded_by}; ` +
            `the head of the chain is #${head.id}: "${head.fact}" — ` +
            `re-check your correction against it, then revise #${head.id} if still needed`,
        );
      }
      // A correction inherits the old fact's salience/kind unless explicitly overridden.
      const importance = checkImportance(input.importance, old.importance);
      const kind = checkKind(input.kind, old.kind);
      const txAt = this.clock.now();
      let validFrom = txAt;
      if (input.validFrom !== undefined) {
        validFrom = normalizeIso(input.validFrom, "validFrom");
        // The old fact's validity closes at validFrom (world time), so the
        // backdate must land inside [old.valid_from, txAt] or the two
        // intervals would overlap or invert.
        if (validFrom < old.valid_from || validFrom > txAt) {
          throw new ValidationError(
            `validFrom must be within [${old.valid_from} (old fact's validFrom), ${txAt} (now)], got ${validFrom}`,
          );
        }
      }
      const inserted = this.prep(sql.INSERT_FACT).run({
        subject: old.subject,
        predicate: old.predicate,
        fact: newFact,
        confidence,
        importance,
        kind,
        validFrom,
        txAt,
        sourceAgent: input.sourceAgent ?? "",
        sourceRef: input.sourceRef ?? "",
        // A revision usually means the agent looked again at a new commit, so the
        // pin does NOT inherit (null unless re-supplied) — spec §9 open-question 4.
        sourceCommit: input.sourceCommit ?? null,
        sourcePath: input.sourcePath ?? null,
      });
      const newId = Number(inserted.lastInsertRowid);
      // Close the old fact where the new one opens (validFrom = txAt unless
      // backdated): adjacent half-open validity intervals, never overlapping.
      this.prep(sql.SUPERSEDE_FACT).run({ ts: validFrom, newId, oldId: old.id });
      return { oldId: old.id, newId, txAt };
    });
    return run();
  }

  diff(input: DiffInput): DiffResult {
    const since = normalizeIso(input.since, "since");
    const subject = (input.subject ?? "").trim() || null;
    const params = { since, subject };
    const learned = (this.prep(sql.DIFF_LEARNED).all(params) as FactRow[]).map(rowToFact);
    const revised = (this.prep(sql.DIFF_REVISED).all(params) as FactRow[]).map((row) => {
      const successor = this.prep(sql.GET_FACT).get(row.superseded_by) as FactRow | undefined;
      return { old: rowToFact(row), new: successor !== undefined ? rowToFact(successor) : null };
    });
    const retracted = (this.prep(sql.DIFF_RETRACTED).all(params) as FactRow[]).map(rowToFact);
    return { since, learned, revised, retracted };
  }

  why(factId: number): WhyResult {
    const row = this.prep(sql.GET_FACT).get(factId) as FactRow | undefined;
    if (row === undefined) throw new NotFoundError(`no fact #${factId}`);

    const ancestors: Fact[] = [];
    let prev = this.prep(sql.GET_PREDECESSOR).get(factId) as FactRow | undefined;
    while (prev !== undefined) {
      ancestors.push(rowToFact(prev));
      prev = this.prep(sql.GET_PREDECESSOR).get(prev.id) as FactRow | undefined;
    }

    const descendants: Fact[] = [];
    let cursor = row;
    while (cursor.superseded_by !== null) {
      const next = this.prep(sql.GET_FACT).get(cursor.superseded_by) as FactRow | undefined;
      if (next === undefined) break;
      descendants.push(rowToFact(next));
      cursor = next;
    }
    return { fact: rowToFact(row), ancestors, descendants };
  }

  forget(input: ForgetInput): ForgetResult {
    const ts = this.clock.now();
    let rows: Array<{ id: number }>;
    if (typeof input.factId === "number") {
      rows = this.prep(sql.RETRACT_BY_ID).all({ ts, id: input.factId }) as Array<{ id: number }>;
    } else if (typeof input.sourceRef === "string") {
      const sourceRef = input.sourceRef.trim();
      if (sourceRef === "") {
        throw new ValidationError("sourceRef must be non-empty (refusing to retract everything)");
      }
      rows = this.prep(sql.RETRACT_BY_SOURCE_REF).all({ ts, sourceRef }) as Array<{ id: number }>;
    } else {
      throw new ValidationError("forget needs a factId or a sourceRef");
    }
    const retractedIds = rows.map((r) => r.id);
    return { retractedCount: retractedIds.length, retractedIds };
  }

  stats(): StatsResult {
    const now = this.clock.now();
    const total = this.prep(sql.STATS_TOTAL).get() as { c: number };
    const current = this.prep(sql.STATS_CURRENT).get({ now }) as { c: number };
    const top = this.prep(sql.STATS_TOP_SUBJECTS).all({ now }) as Array<{
      subject: string;
      c: number;
    }>;
    return {
      dbPath: this.dbPath,
      totalFacts: total.c,
      currentBeliefs: current.c,
      topSubjects: top.map((r) => ({ subject: r.subject, count: r.c })),
      schemaVersion: this.schemaVersion,
    };
  }

  /** Verifies FTS index consistency and foreign keys; throws on corruption. */
  checkIntegrity(): void {
    this.db.exec(sql.FTS_INTEGRITY_CHECK);
    const broken = this.db.pragma("foreign_key_check") as unknown[];
    if (broken.length > 0) {
      throw new Error(`foreign_key_check found ${broken.length} violation(s)`);
    }
  }

  close(): void {
    this.db.close();
  }
}
