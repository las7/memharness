# The dogfood gate (Phase 2)

Two weeks of real daily use decide whether the temporal-provenance thesis is
real or theater. Both Claude Code and Claude Desktop on this machine are
already pointed at the local build.

**Week 1 — accumulate.** Use Claude normally. Let it remember things. Correct
it when it's wrong (corrections trigger `revise` — the interesting data).
Optional system-prompt nudge:

> Use memharness to remember durable facts about me and my projects
> (remember/revise) and recall them at the start of relevant tasks. Always
> fill source_ref with the current session/topic.

**Week 2 — ask the killer questions** and note honestly whether they matter:

- "What have you learned about my project since last Monday?" (`diff`)
- "What did you believe about X before I corrected you?" (`recall` + `as_of`)
- "Why do you think I prefer Y?" (`why`)
- "Forget everything from that session." (`forget` by source_ref)

**Measuring.** Every tool call is logged (op + timestamp only, no content) to
`~/.memharness/usage.log`. Tally with:

```bash
cut -d'"' -f4 ~/.memharness/usage.log | sort | uniq -c | sort -rn
```

**Kill criterion:** if after two weeks the tally shows only `remember`/`recall`
and `diff`/`as_of`-recalls/`why` go unused, the thesis is weak for individual
users — stop and reassess (pivot to team/audit, or simplify).

**Success criterion:** one moment where `diff` or `as_of` answers something
nothing else on the machine could. Screenshot it. That's the launch demo.

Gate decision date: **2026-06-23** (two weeks from setup).
