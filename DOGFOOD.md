# The dogfood gate (Phase 2)

Real daily use decides whether the temporal-provenance thesis is real or
theater. Both Claude Code and Claude Desktop on this machine point at the
local build.

## Stopping rules (asymmetric on purpose)

**Success — can land any day.** One genuine moment where `diff`, `as_of`, or
`why` answers a question you actually had, that nothing else on the machine
could answer. Not a validation poke — a real need. Screenshot it; that's the
launch demo. Gate passes immediately, Phase 3 starts.

**Kill — needs enough history first.** History can't be faked: tx_at is
immutable transaction time, so bulk imports don't create a past (the schema
enforces the experiment's integrity). Declare the thesis weak only when ALL of:

- ≥ 7 days elapsed (decision window closes 2026-06-23 regardless), and
- the log shows ≥ 50 recalls and ≥ 10 revise events (enough belief churn for
  the temporal queries to have had something to say), and
- diff / as_of-recalls / why still went unused for any real purpose.

Then stop and reassess: pivot toward teams/audit (where "what did the agent
believe when it acted" is a requirement, not a curiosity) or simplify.

## Making the data arrive faster

- Use it everywhere: tako, outerport-backend, personal — Desktop and Code.
- Correct Claude aggressively when it's wrong. Corrections become `revise`
  events, the raw material as_of/why feed on.
- Seed tonight: bulk-remember what you already know (projects, preferences).
  It doesn't create history, but it makes plain recall useful on day one,
  which keeps the loop running long enough for history to accumulate.

## Measuring

Every tool call logs op + timestamp (+ recall hit counts) — never content —
to `~/.memharness/usage.log`:

```bash
cut -d'"' -f4 ~/.memharness/usage.log | sort | uniq -c | sort -rn   # op tally
grep -c '"op":"revise"' ~/.memharness/usage.log                     # belief churn
grep -c '"hits":0' ~/.memharness/usage.log                          # zero-hit recalls (miss signal)
```

Also note, as they happen: memory misses (a zero-hit recall you knew had an
answer — like the 2026-06-09 "work employer company" miss that became the
porter-stemming fix), facts stored as mush instead of atomic statements, and
any "I wish it had just—" moment. Those are roadmap.
