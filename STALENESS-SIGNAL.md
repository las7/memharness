# STALENESS-SIGNAL.md — Source-Staleness Signal for memharness

> Status: design, ready to implement. Targets schema v5 (migration `m005`).
> Grounded against the tree at `299546f` on `feat/research-memory-upgrades`.

## 1. Motivation

memharness facts are bi-temporal over **valid time** (true in the world) and **transaction time** (when recorded), but neither axis captures a third reality that bit us during dogfooding: **a fact recorded from code read at one commit silently rots as the repo moves past that commit.**

The concrete failure mode, found dogfooding the store on itself (the same way `EDGE-CASES.md` was produced — "Found during dogfood (2026-06-10), grounded in the current code"): facts like *"`recallQuery` scores `RRF × confidence × importance × decay`"* or *"`INSERT_FACT` does not persist `last_accessed_at`"* are true **at the commit they were read at** and become quietly wrong after a refactor. Today such a fact:

- has no record of which commit it describes (`source_ref` is free text — `packages/core/src/migrations/m001_initial.ts:19`, default `''`),
- keeps full `confidence` and full recency score forever (`packages/core/src/sql.ts:71`), and
- is surfaced by `recall` with no warning (`packages/mcp/src/format.ts:4`).

The agent re-reads the rotted fact and trusts it. This is exactly the "silent rot" of pinned code knowledge — the bi-temporal model has no notion of *source freshness*, only world-truth and learn-time. We need a **source axis** orthogonal to the existing two, populated out-of-band (git in core is forbidden by invariant **I5** — see `packages/mcp/src/reembed.ts:1-8`), and surfaced at recall.

## 2. Design overview

We add a **source axis** alongside the world/transaction axes: a fact may be *pinned* to a git commit (and optionally a path), and a cold-path bin re-checks whether the repo has moved past that pin. Capture is split exactly where each proposal got it right: the **write path** stores only what the agent already knows (`source_commit`, `source_path`) — pure string columns, no git, I5 preserved (mirroring how `embedding`/`embedding_dim` are written but the model never runs in core). A new out-of-band bin, **`memharness-staleness`**, is the *only* place git runs — modeled bin-for-bin on `reembed.ts` — and writes back a precomputed verdict through one narrow core method, never the hot path.

The verdict is a **three-state freshness enum** (`current` / `stale` / `unresolved`), not a boolean, because the git check has three genuinely distinct outcomes (verified in this repo: `git merge-base --is-ancestor` exits 0 / 1 / 128). Recall reads the stored verdict as a plain `f.*` column — **zero git in the hot path** — and renders a `stale` tag in `fmtFact`. Ranking stays **byte-identical by default**: the signal is display-only at ship, with a *pre-wired but neutral-by-default* SQL multiplier (`@staleWeight = 1.0`) so a future demotion is a one-line config change landed symmetrically in `sql.ts` and `ranking.ts` — never a silent reorder. The forward-only migration is purely additive `ALTER TABLE ADD COLUMN` with NULL/neutral defaults, so every pre-existing and non-code fact reads identically to today until a pass runs.

## 3. Schema & migration

**Next migration number: `m005`.** Confirmed: `packages/core/src/migrations/` holds exactly `m001`–`m004`; `MIGRATIONS` in `index.ts:8` has length 4 and `runMigrations` (`index.ts:11-27`) bumps `user_version` 4→5 in one transaction. New file `packages/core/src/migrations/m005_source_staleness.ts`, appended (never reordered) to the `MIGRATIONS` array.

```ts
// packages/core/src/migrations/m005_source_staleness.ts
import type { Database } from "better-sqlite3";

/**
 * Source-staleness signal. A fourth provenance axis: which git commit/path a
 * fact was read from, and the out-of-band verdict on whether the repo has
 * moved past it. All columns are additive with NULL defaults (NULL = "not
 * source-pinned / never checked"), so existing rows migrate with zero ranking
 * and zero recall-output drift — identical to m003/m004's neutral-defaults
 * precedent. None is a belief-set predicate: like importance/kind they affect
 * display/score only, never CURRENT_FILTER / AS_OF_FILTER membership. Git never
 * runs in core (I5); freshness/checked_* are written ONLY by setStaleness().
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
```

Registration:

```ts
// packages/core/src/migrations/index.ts
import { m005 } from "./m005_source_staleness.js";
const MIGRATIONS = [m001, m002, m003, m004, m005]; // length 5 → user_version 4→5
```

Why five columns and not three (rejecting Proposal A's lean shape and Proposal C's six-column shape):
- `source_commit` + `source_path` are the **pin** — agent-supplied, immutable provenance.
- `freshness` is the **verdict** as a tri-state enum, not a boolean `source_stale` (Proposal A) or an integer `source_distance` (Proposal B). The git check has three real outcomes and conflating "diverged" with "SHA gone" (both → "stale" in A) loses the one distinction an operator most needs: *did the repo move, or can we no longer tell?*
- `checked_at` + `checked_head` make the **staleness of the staleness check itself** visible (Proposal A's `staleness_checked_head` idea, kept). Without them a `current` verdict is unfalsifiable.
- We drop Proposal C's separate `revalidated_at`/`revalidated_head` naming for the shorter `checked_*`, and drop its line-range/blame machinery entirely (see §8).

Migration test (new case in `packages/core/test/migrations.test.ts`, following the m003 neutral-defaults case at lines 77-103): insert a pre-existing v4 row, open at v5, assert `{ source_commit: null, source_path: null, freshness: null, checked_at: null, checked_head: null }` — proving zero drift.

## 4. Write path

**`source_commit` and `source_path` are optional and captured at write time by the agent**, who is the only party that knows what commit it read the code at. Core stays git-free (I5): it stores the strings verbatim, exactly as it stores `source_ref` today.

Core changes (`packages/core/src/`):

- **`types.ts`**: add to `Fact` (after `sourceRef`, line 23): `sourceCommit: string | null; sourcePath: string | null; freshness: "current" | "stale" | "unresolved" | null; checkedAt: string | null; checkedHead: string | null;`. Add `sourceCommit?: string; sourcePath?: string;` to both `RememberInput` and `ReviseInput`.
- **`memory.ts`**: extend `FactRow` (lines 30-46) and `rowToFact` (48-66) with the five snake↔camel fields. In `remember` (217-228) and `revise` (394-405), pass `sourceCommit: input.sourceCommit ?? null, sourcePath: input.sourcePath ?? null`.
- **`sql.ts` `INSERT_FACT` (lines 4-6)**: add `source_commit, source_path` to the column list and `@sourceCommit, @sourcePath` to `VALUES`. `freshness`/`checked_at`/`checked_head` are **never** named here — they default NULL and are written only by `setStaleness` below.

MCP changes (`packages/mcp/src/server.ts`): add to **both** `remember` and `revise` `inputSchema`:

```ts
source_commit: z.string().optional()
  .describe("Git SHA you read this code at; pins the fact for staleness checking. Omit for non-code facts."),
source_path: z.string().optional()
  .describe("Repo-relative file path this fact describes, if any."),
```

threaded into the `mem.remember`/`mem.revise` calls (lines 144-154, 272-281) as `sourceCommit: args.source_commit, sourcePath: args.source_path`. The `remember` tool description ("Always fill source_ref…") gains: *"If the fact describes code you just read at a known commit, also set source_commit (and source_path) so staleness checking can flag it when the repo moves."*

**Backward compatibility (total):**
- Both args are optional; existing callers, the `context.ts` bin, and the dogfood eval harness keep working verbatim.
- `source_ref` is **untouched and still primary** — `source_commit` is a *new sibling* SHA column, not an overload, exactly as m004 added `embedding_dim` beside the reserved `embedding` BLOB rather than packing the dimension into it. Free-text `source_ref` (`"auth.ts"`, a session id, a URL) stays valid and staleness-exempt.
- **Lazy backfill of the existing corpus** (kept from Proposal C): facts written before m005, or by agents that don't pass `source_commit`, can still be pinned. On its first run the `memharness-staleness` bin parses a structured ref of the form `repo@<sha>[:<path>]` — or a bare 7–40-hex SHA — out of the existing free-text `source_ref` (indexable via `idx_facts_source_ref`, `m001:29`) and back-populates `source_commit`/`source_path` through the same `setStaleness` method. Refs with no parseable SHA stay unpinned. This means the feature works on the corpus already in the db without a re-remember, and no fact is ever rewritten on read.

## 5. Recall path

**Recall computes nothing at query time.** The verdict is read straight through `SELECT f.*` (`sql.ts:70`, `:126`) into `rowToFact` and out to `ScoredFact` — one already-loaded enum, **zero git/subprocess in the hot path** (the hard constraint, identical to how `reembed` keeps the model out of recall).

The signal surfaces in `fmtFact` (`packages/mcp/src/format.ts:4-19`), the single render seam, gated like `imp=`/`kind=` are (shown only when non-default):

```ts
// after the existing `if (f.sourceRef) meta.push(...)` at format.ts:9
if (f.sourceCommit) {
  const short = f.sourceCommit.slice(0, 7);
  meta.push(`pin=${(f.sourcePath ? f.sourcePath + "@" : "") + short}`);
}
if (f.freshness === "stale") meta.push("STALE");
else if (f.freshness === "unresolved") meta.push("stale?"); // SHA gone — can't verify
```

`fmtRecall` (`format.ts:21-30`) gains a footer note when any returned fact is non-`current`, mirroring its existing `(truncated …)` note: `notes.push("(some pinned facts may have drifted — run memharness-staleness, or re-verify against current code)")`.

**BEFORE** (today — a fact read at commit `a1b2c3d`, repo since moved on):

```
Current beliefs:
[#42] project:memharness (describes) : recallQuery scores RRF × confidence × importance × decay  {conf=0.80, src=mcp, ref=sql.ts}
```

**AFTER** (same fact, after a `memharness-staleness` pass finds the pin is an ancestor of a moved HEAD):

```
Current beliefs:
[#42] project:memharness (describes) : recallQuery scores RRF × confidence × importance × decay  {conf=0.80, src=mcp, ref=sql.ts, pin=packages/core/src/sql.ts@a1b2c3d, STALE}
(some pinned facts may have drifted — run memharness-staleness, or re-verify against current code)
```

The agent now sees the pin *and* that the file changed since, and can re-read before trusting it. `why` (`fmtWhy`, `format.ts:49-54`) gains `checked_head`/`checked_at` in its time-detail line so an operator can see how fresh the check itself is.

Optional later: a `freshness` filter param on recall (a `FRESHNESS_FILTER` clause beside `KIND_FILTER`, `sql.ts:30`) so a caller can ask for only-`current` or only-`stale` facts — deferred to Phase 3.

### Cold-path write-back and the bin

Core gains exactly two methods (in `memory.ts`, both pure SQL, no git), the source-axis analogues of `embedTargets`/`setEmbedding`:

```ts
// work-list: live, pinned facts oldest-first (EMBED_TARGETS shape, sql.ts:89)
stalenessTargets(limit: number): Array<{ id; sourceRef; sourceCommit; sourcePath }>

// the ONLY writer of freshness/checked_*; UPDATE of source-axis columns only —
// never tx_at/valid_*/fact/confidence, so I1 (tx_at immutable) and I4 (never
// delete) hold. May also set source_commit/source_path on first-run backfill.
setStaleness(id: number, v: { freshness; checkedAt; checkedHead; sourceCommit?; sourcePath? }): void
```

backed by new SQL in `sql.ts` (`STALENESS_TARGETS`, `SET_STALENESS`).

New bin **`memharness-staleness`** (`packages/mcp/src/staleness.ts`), wired into `packages/mcp/package.json` `bin` beside `memharness-reembed`/`memharness-context`:

```json
"memharness-staleness": "dist/staleness.js"
```

It is **read-mostly**: default `--check` only computes verdicts; `--flag` writes them (default on); a `--revise` mode (Phase 3) can drive the existing `revise` path to downgrade confidence on confirmed-stale facts, preserving the chain. Per distinct `source_commit`, for the repo the pin belongs to, it runs (primitives verified in this repo at `299546f`):

1. `git rev-parse HEAD` → `checked_head`.
2. `git merge-base --is-ancestor <source_commit> HEAD`:
   - **exit 0 and** `source_commit != HEAD` → repo moved past the pin → candidate `stale`; if `source_path` is set, confirm with `git diff --quiet <source_commit> HEAD -- <source_path>` (CHANGED → `stale`, UNCHANGED → `current`). Path-level granularity avoids flagging a fact whose file an unrelated commit never touched.
   - **exit 0 and** `source_commit == HEAD` → `current`.
   - **exit 1** (diverged — pin not an ancestor) → `unresolved` (we can't reason about drift across a branch we're not on).
   - **exit 128** (SHA unknown here — force-pushed, different repo, shallow clone) → `unresolved`, **never silently `current`**.

The exit-1-vs-128 distinction is the crux: Proposal A maps both unresolvable *and* diverged to "stale (conservative)", which over-flags every multi-repo or branch case in a global db; we map genuinely-unverifiable to `unresolved` so the operator is never *falsely reassured* (`current`) nor *falsely alarmed* (`stale`). The bin prints a `reembed`-style summary to stderr: `checked N / current C / stale S / unresolved U`, listing stale ids.

## 6. Ranking impact

**At ship: zero.** `freshness` never appears in the score expression (`(rrf) * confidence * IMPORTANCE_BOOST_EXPR * DECAY_EXPR`, `sql.ts:71`/`:127`) nor in `ranking.ts score()` (`:63-72`). The score-parity keystone test (`packages/core/test/ranking-features.test.ts:13-46`, which pins `f.score` to `score()` to 6 decimals) stays green untouched, and `DEFAULT_RANKING` is unchanged. Surfacing a flag is strictly safer than silently reordering, and keeps the slice additive — this is the discipline m003 documents for itself.

**Pre-wired, neutral-by-default demotion (the safe graft of Proposal B).** So a future demotion is a *config flip*, not a schema/parity change, we land — in **the same commit, symmetrically in both files** — a multiplier that is the identity at its default:

```sql
-- sql.ts, factored into a constant and multiplied into score in BOTH
-- recallQuery (:71) and hybridRecallQuery (:127):
STALENESS_FACTOR = (CASE WHEN f.freshness = 'stale' THEN @staleWeight ELSE 1.0 END)
-- score := (rrf) * f.confidence * IMPORTANCE_BOOST_EXPR * DECAY_EXPR * STALENESS_FACTOR
```

```ts
// ranking.ts score(): mirror exactly
const staleFactor = input.freshness === "stale" ? opts.staleWeight : 1;
return rrf * input.confidence * boost * decay * staleFactor;
```

with `staleWeight: 1.0` added to `DEFAULT_RANKING` (and `ResolvedRankingOptions`/`RankingOptions`/`Memharness.open`, threaded like `importanceWeight` at `ranking.ts:32`, `memory.ts:155`), and `freshness` added to `ScoreInput` plus `staleWeight` to the recall param block (`memory.ts:250-259`).

This stays **100% SQL** — only `CASE`, already used (`EFFECTIVE_HALFLIFE_EXPR`, `sql.ts:46-53`); no new SQLite function. It is a **bounded multiplier in (0,1]**, **identically 1.0** whenever `freshness != 'stale'` (every `current`, `unresolved`, NULL, and pre-migration row), so it **cannot perturb any existing ranking** and the parity test passes for all existing cases unchanged. It composes commutatively with the other three multiplicative factors — no RRF re-normalization, unlike an additive penalty. We deliberately apply it **only to `stale`**, not `unresolved`: an unverifiable pin shouldn't be demoted on suspicion. New parity cases assert a `stale` fact at `staleWeight<1` ranks below an equal `current` one and below itself at default. We reject Proposal B's `pow(0.5, distance/halfLife)` distance-decay form: commit-distance is a noisy, expensive-to-maintain proxy (every pass must recount), and a graded penalty invites silent mid-pack reordering — a single CASE weight is auditable and the operator opts in.

## 7. Phased rollout

**Phase 1 — Smallest shippable slice (capture + surface, no scoring, no git):**
`m005` migration + columns + neutral-defaults test. `Fact`/`FactRow`/`rowToFact`/`INSERT_FACT` carry the fields. `remember`/`revise` accept `source_commit`/`source_path`. `fmtFact` renders `pin=` (no `STALE`/`stale?` tags yet — `freshness` is still NULL everywhere). **Outcome:** agents start pinning code facts; provenance is visible in recall and `why`; nothing about ranking or output changes for any existing fact. This is fully useful alone (you can manually `why` a fact and see its pin) and de-risks the schema before any git logic exists.

**Phase 2 — The check (out-of-band verdict + flag):**
`stalenessTargets`/`setStaleness` core methods + SQL. The `memharness-staleness` bin (`--check`/`--flag`) with the three-state git classification and stderr summary. `fmtFact` renders `STALE`/`stale?`; `fmtRecall` footer. `source_ref` SHA-parsing backfill so the existing corpus participates. Wire the bin into the same SessionStart/post-merge hook that drives `context.ts`. **Outcome:** drifted facts are flagged; the agent re-verifies.

**Phase 3 — Optional teeth (config-gated):**
Flip `staleWeight` below 1.0 to demote (the pre-wired §6 multiplier, with parity cases). Add the recall `freshness` filter. Add `--revise` mode (downgrade confidence + annotate via the existing supersession chain, never auto-retract). All opt-in; default behavior stays Phase-2-identical.

## 8. Alternatives considered & rejected

- **Proposal A — boolean `source_stale` flag, display-only forever.** *Kept:* its core insight that the verdict is precomputed out-of-band and read as a plain column with zero hot-path git, and surfacing `checked_head` so the check's own staleness is visible. *Rejected as the whole design because:* (1) a **boolean** collapses the three genuinely distinct git outcomes — `merge-base --is-ancestor` exits 0/1/128 in this repo (verified) — and A explicitly maps both "diverged" and "unresolvable SHA" to `stale`, which over-flags every cross-repo and off-branch fact in a *global* db (memharness spans projects), the exact secondary risk A itself flags but only defers. Our `unresolved` state fixes this. (2) A *forecloses* ranking impact ("explicitly NOT doing that"); we keep its safety while pre-wiring the neutral multiplier so demotion is a config flip, not a re-architecture. (3) Three columns are too few to record *when/against-what* the check ran without overloading.

- **Proposal B — source freshness as a second `pow(0.5, distance/halfLife)` decay factor.** *Kept:* the discipline of a **bounded multiplicative factor that is identically 1.0 for every non-pinned/pre-migration row**, composing commutatively with the existing three factors, mirrored bit-for-bit in `ranking.ts`/`sql.ts` so the parity test holds — this is precisely how we pre-wire the demotion in §6. *Rejected as the whole design because:* (1) it makes staleness **scoring-first and silent** — a rotted fact sinks in the ranking with no visible reason, which is "a louder version of the disease" (silent rot → silent demotion); the operator can't tell a low-ranked stale fact from a low-ranked old one. (2) `source_distance` (commit count) is an expensive, fragile signal: every pass must `rev-list --count` and a force-push/rebase/shallow-clone makes the count meaningless (B fails-safe to distance 0, i.e. *no* penalty — so the very facts most likely rotted are the ones it won't flag). A binary "did the path change" check is cheaper and truer. (3) graded distance-decay invites continuous mid-pack reordering that's hard to audit; we prefer a visible flag plus an opt-in single-weight CASE.

- **Proposal C — `memharness-revalidate` with line-range `git blame`/`git log -L` and a six-column schema.** *Kept:* the three-state `freshness` enum (`current`/`stale`/`unresolved`), the `source_ref` SHA-parsing **lazy backfill** of the existing corpus, the read-mostly bin defaulting to flag-only with an opt-in `--revise` that downgrades-not-deletes through the existing chain, and the principle that the cure must not corrupt the belief set. *Rejected as the whole design because of its over-build:* the `#Lrange` line-range refinement via `git blame`/`git log -L` against the pinned blob is the most complex and least reliable part — line numbers drift, blame is slow per-fact, and it's the kind of heuristic `EDGE-CASES.md` (E4/E5) says to validate against dogfood data *before* building. We take C's conservative file-granularity classification and drop the line-range machinery entirely; its `revalidated_at`/`revalidated_head` pair is renamed to the shorter `checked_*`. (Honest note: this synthesis *is* essentially C's skeleton with B's neutral multiplier and A's hot-path-read discipline grafted on — credited as such.)

## 9. Open questions

1. **Which repo does a pin belong to?** The db is global; a `source_commit` can resolve in one worktree and not another. Phase 2 assumes the bin runs *inside* the relevant repo and treats unknown SHAs (exit 128) as `unresolved`. Cleaner: scope a pass to facts whose `source_path`/`source_ref` is inside the current worktree, or store a `repo` identifier. Deferred pending dogfood data on how often pins cross repos — matching how E4/E5 defer until real usage.
2. **`source_path` granularity vs. precision.** File-level over-flags a fact about function `foo` when an unrelated edit touches the same file. Accepted for Phase 2 (conservative: flag only on real path change; `unresolved` when unsure). Symbol/line precision is explicitly out of scope (see §8, Proposal C rejection).
3. **Backfill ambiguity.** A free-text `source_ref` may contain a hex run that *looks* like a SHA but isn't (e.g. a hash in a URL). The parser should require `repo@<sha>` structure or a standalone 7–40-hex token bounded by non-hex; mis-parses must land as `unresolved`, never `stale`. Needs a small parser test corpus from real `source_ref` values in the dogfood db.
4. **Should `revise` clear or inherit the pin?** A correction that re-reads code at a *new* commit should set a fresh `source_commit`; one that merely rewords should arguably inherit (like `importance`/`kind` inherit at `memory.ts:379-380`). Phase 1 default: do **not** inherit (NULL unless re-supplied), since a revision usually means the agent looked again. Revisit after dogfood.
5. **Hook cadence.** Running `memharness-staleness` on every post-merge could thrash a large db; a `--since`/oldest-first throttle (the `stalenessTargets` limit) bounds work per run, but the right cadence (post-merge vs. nightly cron) is unvalidated.
6. **Interaction with reinforce-on-access.** A `current`-mode recall freshens `last_accessed_at` (`memory.ts:349-352`) even for a `STALE` fact — so recalling a rotted fact *raises* its recency score while the flag says distrust it. Probably fine (the flag is the override), but worth confirming the two signals don't fight once `staleWeight < 1` is enabled.
