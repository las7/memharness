# memharness

**A bi-temporal, provenance-carrying memory primitive for AI agents.** One
SQLite file. Zero LLM calls in the storage layer. Exposed to any agent via MCP.

Most agent memory is a bag of strings. memharness stores **facts** with three
semantics nothing else in the space combines:

1. **Bi-temporal** — every fact records *when it became true in the world*
   (`valid_from`/`valid_to`) separately from *when the agent learned it*
   (`tx_at`). So you can ask: *"what did you believe on March 1st?"*
2. **Supersession, never deletion** — corrections close the old fact and link
   it to its successor. *"What did you think before I corrected you?"* has an
   answer.
3. **Provenance per fact** — every memory cites who said it, where, and when.
   *"Why do you believe that?"* has an answer. So does *"forget everything
   from that session."*

The storage layer is deterministic: no LLM, no network, no telemetry. It's
plain SQLite — open the file with any client.

## Packages

| Package | What it is |
|---|---|
| `@memharness/core` | TypeScript library: schema, migrations, write path, recall ranking |
| `@memharness/mcp` | MCP server (stdio) exposing the seven tools to any MCP client |

## Quick start (MCP)

Claude Code:

```bash
claude mcp add memharness -- npx -y @memharness/mcp
```

Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "memharness": { "command": "npx", "args": ["-y", "@memharness/mcp"] }
  }
}
```

Cursor (`~/.cursor/mcp.json`) and Codex use the same `npx -y @memharness/mcp`
command. The database lives at `~/.memharness/memory.db` (override with
`MEMHARNESS_DB`; `XDG_DATA_HOME` honored on Linux).

## The seven tools

| Tool | What it does | The thesis it tests |
|---|---|---|
| `remember` | store an atomic fact with confidence + provenance | facts > blobs |
| `recall` | ranked current beliefs; `as_of` = beliefs at a past instant | bi-temporal |
| `revise` | supersede a belief, keep history | supersession > deletion |
| `diff` | what changed since a date (learned/revised/retracted) | the killer demo |
| `why` | provenance + full revision chain for a fact | trust/audit |
| `forget` | tombstone by id or by source (provenance-based deletion) | GDPR-shaped |
| `stats` | counts, subjects, schema version | — |

## Library use

```ts
import { Memharness } from "@memharness/core";

const mem = Memharness.open(); // ~/.memharness/memory.db
const { id } = mem.remember({
  subject: "user",
  fact: "lives in Osaka",
  sourceRef: "session-2026-06-09",
});
mem.revise({ oldFactId: id, newFact: "lives in Tokyo", validFrom: "2026-05-01" });

mem.recall({ query: "lives" });                          // current belief: Tokyo
mem.recall({ query: "lives", asOf: "2026-03-01" });      // belief then: Osaka
mem.diff({ since: "2026-06-01" });                       // learned / revised / retracted
mem.why(id);                                             // provenance + revision chain
```

Recall ranking: reciprocal-rank fusion over FTS5 BM25 (vector rank joins in a
later release) × confidence × recency decay (90-day half-life, configurable),
scored in SQL. Optional `maxTokens` budget caps output for context windows.

## Correctness

The property suite is the heart of the project: for randomized sequences of
remember/revise/forget, `recall({asOf: T})` must equal the belief set produced
by a naive, SQL-free replay of the event log — probed at every event
timestamp ±1ms. 10,000 cases run on every push to main.

Benchmarked at 100k facts (10% revision chains, 2% retractions), Apple
M-series: overall recall p95 **1.56ms** across FTS, subject-filtered, and
as-of query shapes (budget: 10ms). `pnpm bench` reproduces.

One deliberate divergence from the original prototype: retraction stores a
timestamp (`retracted_at`), not a flag, so `as_of` queries *before* the
retraction still see history — which is what the prototype's docs promised
but its SQL didn't deliver.

## Development

```bash
pnpm install
pnpm test            # unit + behavior suites (property tests at 200 runs)
pnpm test:property   # 10k randomized property cases
pnpm bench           # seed 100k facts, assert recall p95 < 10ms
```

Schema migrations are forward-only, driven by `PRAGMA user_version`. Rows are
never deleted (`forget` tombstones), so `facts.id` doubles as the insert
sequence. All timestamps are canonical fixed-width UTC ISO 8601, making
lexicographic comparison chronological.

## License

Apache-2.0
