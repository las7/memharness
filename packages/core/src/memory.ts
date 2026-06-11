import type { Database, Statement } from "better-sqlite3";
import { SystemClock } from "./clock.js";
import { openDatabase, resolveDefaultDbPath } from "./db.js";
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

export class Memharness {
  private readonly db: Database;
  private readonly clock: Clock;
  private readonly ranking: ResolvedRankingOptions;
  private readonly dbPath: string;
  private readonly schemaVersion: number;
  private readonly stmts = new Map<string, Statement>();

  private constructor(db: Database, dbPath: string, clock: Clock, ranking: ResolvedRankingOptions) {
    this.db = db;
    this.dbPath = dbPath;
    this.clock = clock;
    this.ranking = ranking;
    this.schemaVersion = runMigrations(db);
  }

  static open(opts: MemharnessOptions = {}): Memharness {
    const dbPath = opts.dbPath ?? resolveDefaultDbPath();
    const db = openDatabase(dbPath);
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
    return new Memharness(db, dbPath, opts.clock ?? new SystemClock(), ranking);
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

    let rows: Array<FactRow & { fts_rank: number | null; score: number }>;
    let usedFallback = false;
    if (query !== "") {
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
        throw new ValidationError(
          `fact #${old.id} is already superseded by #${old.superseded_by}; revise the head of the chain`,
        );
      }
      // A correction inherits the old fact's salience/kind unless explicitly overridden.
      const importance = checkImportance(input.importance, old.importance);
      const kind = checkKind(input.kind, old.kind);
      const txAt = this.clock.now();
      const validFrom =
        input.validFrom !== undefined ? normalizeIso(input.validFrom, "validFrom") : txAt;
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
      });
      const newId = Number(inserted.lastInsertRowid);
      this.prep(sql.SUPERSEDE_FACT).run({ ts: txAt, newId, oldId: old.id });
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
    const total = this.prep(sql.STATS_TOTAL).get() as { c: number };
    const current = this.prep(sql.STATS_CURRENT).get() as { c: number };
    const top = this.prep(sql.STATS_TOP_SUBJECTS).all() as Array<{ subject: string; c: number }>;
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
