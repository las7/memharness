# EDGE-CASES.md — update-path edge cases to resolve before Phases 3–5

> Found during dogfood (2026-06-10), grounded in the current code. Each item
> says what happens today, why it matters, and the decision to make. None of
> these block the dogfood gate; E1 and E5 should be resolved before the
> phases that depend on them (5 and 4 respectively).
>
> **2026-06-12: E1, E2, and E6 are RESOLVED** (see each item). E3/E4/E5 remain
> open — they need a semantics decision or more dogfood data.

## E1. ~~Backdated revise stores a wrong `valid_to`~~ — RESOLVED 2026-06-12

Fixed as proposed: `revise` with explicit `validFrom` now closes the old fact
at `valid_to = new.validFrom` (adjacent half-open intervals, never
overlapping), and validates `old.valid_from <= validFrom <= txAt`, throwing
ValidationError otherwise. The property oracle replays supersession with the
new fact's validFrom, and the generators now emit backdated revises (clamped
into the old fact's life). Pinned in revise.test.ts ("backdated revise closes
the old fact at the new validFrom, not txAt" + the rejection test).

Original problem, for the record:

## E1 (original). Backdated revise stores a wrong `valid_to` (breaks Phase 5)

`revise` accepts `validFrom` to backdate when the new fact became true, but
always closes the old fact at `valid_to = txAt` (memory.ts `revise`,
sql.ts `SUPERSEDE_FACT`). After a backdated revise, the old row's interval is
`[old.valid_from, txAt)` and the new row's is `[backdated_validFrom, ∞)` —
**overlapping validity intervals for the same subject/predicate.**

Today this is unobservable: `as_of(T)` applies the same `T` to both time
dimensions, and the `tx_at <= T` filter hides the new fact for any `T` inside
the overlap. But:

- `valid_to` is world-time by schema definition ("true in the world until"),
  and we're storing learn-time in it. Anything that reads `valid_to` directly
  — exports, `consolidate()` (Phase 3), users writing plain SQL (the whole
  pitch) — gets a wrong answer.
- **Phase 5 pg_mem plans `tstzrange + exclusion constraints`. Overlapping
  intervals are exactly what an exclusion constraint rejects.** Data written
  by today's SQLite backend would fail to migrate.

**Decision needed:** on revise with explicit `validFrom`, set
`old.valid_to = new.validFrom` instead of `txAt` (and validate
`old.valid_from <= new.validFrom <= txAt`, else ValidationError). Or document
single-T as_of as the permanent semantics and drop the exclusion-constraint
plan from Phase 5. The first option seems right; it needs a property-oracle
update in the same commit (the oracle replays supersession with txAt).

Test sketch (red under current behavior), following asof.test.ts conventions:

```ts
it("backdated revise closes the old fact at the new validFrom, not txAt", () => {
  const { mem, clock } = openTestDb("2026-03-01T00:00:00.000Z");
  const old = mem.remember({ subject: "user", fact: "works at A" }).id;
  clock.advance(10 * 24 * 3600 * 1000); // revise on 03-11...
  const backdate = "2026-03-05T00:00:00.000Z"; // ...but A ended 03-05
  mem.revise({ oldFactId: old, newFact: "works at B", validFrom: backdate });

  const oldRow = mem.why(old).fact;
  expect(oldRow.validTo).toBe(backdate); // currently: the 03-11 txAt
  // half-open boundary: old excluded AT backdate, included just before
  const justBefore = new Date(Date.parse(backdate) - 1).toISOString();
  expect(ids(mem.recall({ asOf: justBefore }))).toContain(old);
});
```

Note: any valid-time-only query mode added later ("what was actually true on
date X, per current knowledge") depends on E1 being fixed first.

## E2. ~~Current view ignores `valid_from`~~ — RESOLVED 2026-06-12

Fixed: `CURRENT_FILTER` now includes `f.valid_from <= @now`, so a future-dated
fact stays invisible to current recall, stats, and topSubjects until its
validFrom arrives — consistent with the as_of path. The property test's
current-mode check and oracle now probe at an explicit `now`. Pinned in
recall.test.ts and stats.test.ts ("excludes future-dated facts...").

## E3. `revise` and `forget` don't see each other

- `revise` checks `superseded_by` but not `retracted_at`: revising a
  retracted fact produces a live head whose entire ancestry is disavowed.
- `RETRACT_BY_ID` has no head check: retracting a mid-chain (superseded) fact
  is allowed, with unclear meaning — descendants derived from it stay live.
- `forget({sourceRef})` retracts heads and mid-chain rows indiscriminately.

**Decision needed:** what does retraction *mean*? "This was never true"
(should propagate to/refuse on chain neighbors) vs "stop surfacing this"
(then revise-of-retracted should probably be refused like revise-of-superseded
is, for symmetry). Pick one and pin it in invariants.test.ts.

## E4. Misfiled subject/predicate cannot be corrected without severing the chain

`revise` copies the old row's subject/predicate verbatim. But misfiling
("stored under `user`, belongs under `project:x`") is one of the most common
real corrections; the only path today is forget + remember, which loses the
provenance chain revise exists to preserve. Options: allow subject/predicate
override on revise (explicit params, off by default), or a dedicated
`refile` op. Dogfood data should show how often this bites before building.

## E5. `purge` (Phase 4) breaks invariants the rest of the design leans on

Hard delete violates "rows are never deleted," which is load-bearing in three
places:

1. **Chain integrity:** deleting a mid-chain row dangles `superseded_by`;
   `why()`'s descendant walk breaks silently on a missing row (memory.ts,
   `next === undefined` → break) — purge becomes invisible history
   truncation. Purge must repair links (stitch predecessor→successor) or
   refuse mid-chain targets.
2. **Stable ids:** tie-breaking on `(tx_at, id)` assumes id is the insert
   sequence with no holes reused; external references hold ids too (e.g.
   Seiji's Claude Code file memory points at "fact #1", "facts #11–28").
   Purge makes ids unstable as references. At minimum: document; better:
   `purge` returns the ids destroyed so callers can chase references.
3. **Provenance scope:** purge-by-sourceRef won't catch *revisions* of the
   purged fact — each revision carries its own source_ref, and the successor
   usually restates the sensitive content (the actual privacy target:
   plaintext emails, AWS account ids). Purge needs a follow-the-chain mode.

## E6. ~~Concurrent revise: the loser is flying blind~~ — RESOLVED 2026-06-12

Fixed as proposed: the revise-of-superseded ValidationError now walks the
chain and quotes the live head's id *and fact text* ("the head of the chain
is #N: \"...\" — re-check your correction against it"), so the losing agent
can re-decide instead of blindly re-applying. Pinned in revise.test.ts
("quotes the chain head's id and text...").

## Already handled (verified, no action)

- Double-forget is idempotent (`AND retracted_at IS NULL`).
- as_of boundary ties: half-open conventions pinned in asof.test.ts +
  property oracle.
- Same-millisecond writes: SystemClock +1ms bump; cross-process ties break on
  `(tx_at, id)`.
- PLAN.md §3 schema still shows `retracted INTEGER` flag — the code's
  `retracted_at` timestamp is the deliberate, test-pinned divergence; update
  PLAN.md when next touched.
