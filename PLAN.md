# PLAN.md — Bi-temporal Memory Primitive for AI Agents

> Hand this file to Claude Code. Work through phases in order; each phase has
> acceptance criteria that must pass before moving on. Ask before deviating
> from the "Non-goals" section.

## 1. What we're building and why

**One-liner:** a bi-temporal, provenance-carrying memory primitive for AI
agents, as boring storage — SQLite first, Postgres extension second — exposed
to any agent via MCP. "pgvector for agent memory."

**Core thesis (validated by research, June 2026):**
- The field is converging on plain files/SQL + smart agents (Letta's
  grep-beats-frameworks result; engram; claude-mem; Anthropic files-as-memory).
- No incumbent does the three semantics that matter: **bi-temporal facts**
  ("what did you believe in March?"), **supersession** (revise, never delete),
  **provenance per fact** ("why do you believe that?").
- Storage primitives survive vendor absorption (labs shipping native memory
  makes the substrate MORE valuable); hosted memory APIs don't.
- Zero LLM calls in the storage layer — that's the differentiator vs.
  Zep/Graphiti (hours-long LLM ingestion) and mem0 (extraction pipeline).

**Differentiation vs. known prior art (do not duplicate):**
- mem0/Zep/Letta — hosted/framework memory services. We are an embeddable schema.
- Constructive agentic-db (Apr 2026) — maximalist Postgres platform (CRM, skills,
  orchestration). We are minimalist: one concern, facts.
- Minigraf — bi-temporal but a new engine + Datalog. We never invent an engine
  or a query language: plain SQL, existing databases.
- pgGraph (Evokoa) — graph traversal over existing tables. Different layer;
  potentially complementary later.
- sqlite-memory, engram — SQLite memory without temporal/provenance semantics.

**Working prototype exists:** `server.py` in this directory (Python, ~300
lines, tested). It defines the tool semantics: remember, recall (with as_of),
revise, diff, why, forget, stats. Treat it as the spec, not the codebase.

## 2. Product shape

Two artifacts in one monorepo:

1. **`@memharness/core`** (name TBD — see Phase 0): TypeScript library +
   SQLite schema. All memory logic: schema migrations, write path, recall
   ranking, consolidation. Distributed on npm.
2. **`@memharness/mcp`**: thin MCP server wrapping core. Installed with one
   command: `npx -y @memharness/mcp` in any MCP client config (Claude
   Desktop, Claude Code, Codex, OpenClaw, Cursor).

Later (Phase 5): `pg_mem` — Postgres extension implementing the same schema
with tstzrange + exclusion constraints + RLS.

**Stack decisions (defaults; flag if you disagree):**
- TypeScript + better-sqlite3 (sync, fast, ubiquitous). FTS5 for keyword.
- Vectors: `sqlite-vec` extension, embeddings OPTIONAL — pluggable provider
  (any OpenAI-compatible /v1/embeddings endpoint, incl. Ollama). Without a
  provider, recall = FTS5 + recency/confidence. Never require an API key.
- License: Apache-2.0. Single package manager: pnpm. Tests: vitest.
- DB file default: `~/.memharness/memory.db` (XDG-aware on Linux).

## 3. Schema (the heart — get this right)

```sql
CREATE TABLE facts (
  id            INTEGER PRIMARY KEY,
  subject       TEXT NOT NULL,            -- entity: 'user', 'project:foo'
  predicate     TEXT NOT NULL DEFAULT '', -- optional relation: 'prefers'
  fact          TEXT NOT NULL,            -- atomic statement
  confidence    REAL NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  -- bi-temporal
  valid_from    TEXT NOT NULL,            -- true in the world from (ISO 8601 UTC)
  valid_to      TEXT,                     -- NULL = currently believed
  tx_at         TEXT NOT NULL,            -- when recorded (immutable)
  -- supersession (never DELETE; UPDATE only valid_to/superseded_by/retracted)
  superseded_by INTEGER REFERENCES facts(id),
  -- provenance
  source_agent  TEXT NOT NULL DEFAULT '',
  source_ref    TEXT NOT NULL DEFAULT '', -- session/file/URL/utterance
  retracted     INTEGER NOT NULL DEFAULT 0,
  embedding     BLOB                      -- nullable; sqlite-vec format
);
-- invariants to enforce in code + tests:
-- I1: tx_at never changes after insert
-- I2: a superseded fact has valid_to set and superseded_by pointing forward
-- I3: as_of(T) is deterministic and reproducible for any past T
-- I4: forget() tombstones; it never deletes rows
-- I5: no LLM/network calls anywhere in the write or read path (embeddings
--     are the single exception, and only when a provider is configured)
```

**Recall ranking (v1):** score = RRF over (FTS5 BM25 rank, vector cosine rank
if available) × confidence × recency decay (half-life configurable, default
90 days, applied to tx_at). Return within a token budget (`max_tokens` param,
estimate 4 chars/token). All weights configurable, sane defaults.

## 4. Phases

### Phase 0 — Repo bootstrap (half a day)
- Pick final name (check npm/GitHub availability; criteria: short, no "AI").
- pnpm monorepo: `packages/core`, `packages/mcp`. CI: lint, typecheck, test.
- Port the Python prototype's semantics into a failing-test suite first
  (TDD: the prototype's behaviors are the spec).
**Accept:** CI green on empty implementations + full red test suite written.

### Phase 1 — Core library (1–2 weeks)
- Schema + migrations (versioned, forward-only).
- Write path: remember / revise / forget with invariants I1–I5 enforced.
- Read path: recall (current + as_of), diff, why, stats.
- FTS5 search; recency/confidence ranking; token-budgeted output.
- Property-based tests for bi-temporal correctness: for random sequences of
  remember/revise/forget, as_of(T) must equal the belief set reconstructed by
  replaying events up to T. This test is the project's crown jewel.
**Accept:** 100% of prototype behaviors pass; property tests pass 10k cases;
read p95 < 10ms at 100k facts (benchmark script included).

### Phase 2 — MCP server + dogfood gate (1 week + 2 weeks calendar)
- MCP server over stdio: tools remember, recall, revise, diff, why, forget,
  stats. Tool descriptions must teach the model WHEN to use each (copy and
  refine from prototype docstrings).
- One-command install docs for Claude Desktop, Claude Code, Codex, Cursor.
- **Dogfood gate:** Seiji runs it daily for 2 weeks. Instrument: log every
  tool call (locally, op + timestamp only) so usage is measurable.
  - Kill criterion: if diff/as_of/why go unused in 2 weeks of real use,
    STOP and reassess (pivot to team/audit use case or simplify).
  - Success: one screenshot-worthy moment where diff/as_of answers something
    nothing else could → that's the launch demo.
**Accept:** gate decision made on data, not vibes.

### Phase 3 — Hybrid recall + consolidation (1 week)
- sqlite-vec integration; pluggable embedding provider; RRF fusion.
- `consolidate()`: offline pass (CLI command, not daemon) that (a) flags
  near-duplicate facts (embedding similarity > threshold) for merge,
  (b) decays confidence of stale facts, (c) emits a human-readable report.
  NO automatic LLM merging in v1 — propose, don't mutate (invariant I5).
**Accept:** recall quality A/B-able via the bench script; consolidation is
idempotent and never loses history.

### Phase 4 — Launch (1 week)
- README with the 30-second demo: install → two sessions → `diff` shows the
  agent's beliefs changing. Asciinema recording.
- Comparison table: vs mem0/Zep/claude-mem/agentic-db on the three killer
  queries (as_of / diff / why) — factual, link their docs.
- Blog post: "Your agent's memory should be a database, not a service" —
  lead with the Letta grep result and the bi-temporal demo.
- Show HN + post in the exact threads from research (r/ClaudeAI memory
  threads, HN context threads). Answer every comment for 48h.
**Accept:** shipped. Measure: installs (npm), GitHub issues opened by
strangers (the real adoption signal), not stars.

### Phase 5 — Postgres (after launch traction, 3–4 weeks)
- `pg_mem`: same semantics; tstzrange + GiST exclusion constraints for
  validity; RLS policies for per-agent ACLs (the multi-agent story);
  pgvector for embeddings. Pure SQL/PLpgSQL first (an extension installable
  via `CREATE EXTENSION` OR a plain schema.sql — decide based on packaging
  pain); pgrx/Rust only if measurably needed.
- The join demo: memory facts JOIN application tables — the thing no memory
  SaaS can do. Make it the headline.
**Accept:** same property-test suite passes against Postgres backend.

### Phase 6 — Benchmark (parallel track, can start anytime)
- Separate repo: longitudinal memory eval. Replays multi-session agent
  traces; measures task outcomes with/without memory backends (ours, mem0,
  Zep, claude-mem, plain-files baseline). The plain-files baseline MUST be
  included — intellectual honesty is the moat.
- Publish results even where we lose. Especially where we lose.

## 5. Non-goals (do not build without explicit discussion)

- No hosted service, no auth, no telemetry phoning home.
- No agent framework, no orchestration, no chat UI.
- No automatic LLM-based fact extraction in core (clients/skills may do it;
  the storage layer stays deterministic).
- No new query language. SQL and seven tools, that's it.
- No graph traversal engine (pgGraph/AGE territory; revisit only if users ask).
- No Windows-specific work in v1 beyond "it doesn't crash."

## 6. Open questions for Seiji (answer before Phase 0)

1. Name.
2. TypeScript core OK, or strong preference for Rust/Python?
3. Personal GitHub or new org?
4. Benchmark (Phase 6) before or after launch? Research said
   benchmark-first builds credibility; launch-first builds momentum. Default
   here: launch first, benchmark within a month after.
