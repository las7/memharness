/** Cognitive kind of a memory: stable facts/preferences vs one-off events vs how-to. */
export type MemoryKind = "semantic" | "episodic" | "procedural";

/** A single atomic fact row. Timestamps are canonical ISO 8601 UTC: YYYY-MM-DDTHH:mm:ss.sssZ. */
export interface Fact {
  id: number;
  subject: string;
  predicate: string;
  fact: string;
  confidence: number;
  /** Caller-supplied salience, 1..10. 5 = neutral. Ranking metadata only. */
  importance: number;
  /** Cognitive memory kind. Ranking metadata only. */
  kind: MemoryKind;
  /** When this became true in the world (valid time). */
  validFrom: string;
  /** When this stopped being true in the world. null = open-ended. */
  validTo: string | null;
  /** When this was recorded (transaction time). Immutable after insert (I1). */
  txAt: string;
  supersededBy: number | null;
  sourceAgent: string;
  sourceRef: string;
  /** When this was retracted (tombstoned). null = not retracted. Never deleted (I4). */
  retractedAt: string | null;
  /** Last time this fact was surfaced by a current-mode recall (reinforce-on-access). null = never. Ranking metadata only. */
  lastAccessedAt: string | null;
}

export interface Clock {
  /** Strictly increasing canonical ISO timestamps. */
  now(): string;
}

export interface RankingOptions {
  /** Base recency-decay half-life in days (for 'semantic'). Default 90. */
  halfLifeDays?: number;
  /** Reciprocal-rank-fusion constant. Default 60. */
  rrfK?: number;
  /** Direct ranking-multiplier slope per importance step from 5. Default 0.05. */
  importanceWeight?: number;
  /** Half-life modulation slope per importance step from 5. Default 0.15. */
  importanceHalfLifeWeight?: number;
  /** Base half-life per kind. Defaults: semantic 90, episodic 30, procedural 180. */
  kindHalfLifeDays?: Partial<Record<MemoryKind, number>>;
}

export interface MemharnessOptions {
  /** Path to the SQLite file, or ":memory:". Default: ~/.memharness/memory.db (XDG-aware on Linux). */
  dbPath?: string;
  clock?: Clock;
  ranking?: RankingOptions;
}

export interface RememberInput {
  subject: string;
  fact: string;
  predicate?: string;
  /** 0..1. Default 1.0. */
  confidence?: number;
  /** Caller-supplied salience, integer 1..10. Default 5 (neutral). */
  importance?: number;
  /** Cognitive memory kind. Default 'semantic'. */
  kind?: MemoryKind;
  sourceRef?: string;
  sourceAgent?: string;
  /** ISO 8601; normalized. Default: now. */
  validFrom?: string;
}

export interface RememberResult {
  id: number;
  txAt: string;
}

export interface RecallInput {
  query?: string;
  subject?: string;
  /** Restrict to one memory kind. */
  kind?: MemoryKind;
  /** Query embedding for hybrid recall. Fused with FTS via RRF; ignored if sqlite-vec is unavailable. */
  queryVector?: Float32Array | number[];
  /** ISO date or datetime. Returns beliefs as held at that instant. */
  asOf?: string;
  /** Max facts returned. Default 8. */
  limit?: number;
  /** Token budget over the formatted fact text (~4 chars/token). */
  maxTokens?: number;
}

export interface ScoredFact extends Fact {
  score: number;
}

export interface RecallResult {
  facts: ScoredFact[];
  /** Normalized echo of the asOf bound, or null for current-belief mode. */
  asOf: string | null;
  /** True if maxTokens cut results short. */
  truncated: boolean;
  /** True if the FTS query failed to parse and the LIKE fallback was used. */
  usedFallback: boolean;
}

export interface ReviseInput {
  oldFactId: number;
  newFact: string;
  confidence?: number;
  /** Integer 1..10. Default: inherit the old fact's importance. */
  importance?: number;
  /** Default: inherit the old fact's kind. */
  kind?: MemoryKind;
  sourceRef?: string;
  sourceAgent?: string;
  /** When the new belief became true in the world. Default: now. */
  validFrom?: string;
}

export interface ReviseResult {
  oldId: number;
  newId: number;
  txAt: string;
}

export interface DiffInput {
  since: string;
  subject?: string;
}

export interface DiffResult {
  since: string;
  learned: Fact[];
  revised: Array<{ old: Fact; new: Fact | null }>;
  retracted: Fact[];
}

export interface WhyResult {
  fact: Fact;
  /** Facts this one (transitively) superseded, nearest first. */
  ancestors: Fact[];
  /** Facts that (transitively) superseded this one, nearest first. */
  descendants: Fact[];
}

export type ForgetInput =
  | { factId: number; sourceRef?: undefined }
  | { sourceRef: string; factId?: undefined };

export interface ForgetResult {
  retractedCount: number;
  retractedIds: number[];
}

export interface StatsResult {
  dbPath: string;
  totalFacts: number;
  currentBeliefs: number;
  topSubjects: Array<{ subject: string; count: number }>;
  schemaVersion: number;
}
