# @memharness/core

The TypeScript core of [memharness](https://github.com/las7/memharness): a
bi-temporal, provenance-carrying memory primitive for AI agents. Schema,
forward-only migrations, the write path, and recall ranking, over one SQLite
file (better-sqlite3). No LLM, no network, no background daemon.

For the MCP server, see [`@memharness/mcp`](https://www.npmjs.com/package/@memharness/mcp).

## Use

```ts
import { Memharness } from "@memharness/core";

const mem = Memharness.open(); // ~/.memharness/memory.db

const { id } = mem.remember({
  subject: "user",
  fact: "lives in Osaka",
  sourceRef: "session-2026-06-09",
});
mem.revise({ oldFactId: id, newFact: "lives in Tokyo", validFrom: "2026-05-01" });

mem.recall({ query: "lives" }).facts[0].fact;             // "lives in Tokyo"
mem.recall({ query: "lives", asOf: "2026-04-15" });       // belief as held then
mem.diff({ since: "2026-06-01" });                        // learned / revised / retracted
mem.why(id);                                              // provenance + revision chain
```

## What it guarantees

- **Bi-temporal**: `valid_from`/`valid_to` (world time) are tracked separately
  from `tx_at` (when the agent learned it). `recall({ asOf })` is deterministic
  and reproducible for any past instant.
- **Supersession, never deletion**: `revise` closes the old fact and links it
  forward; `forget` tombstones. Rows are never deleted.
- **Provenance per fact**: source agent, source ref, and optional source commit.

Recall ranking is RRF over FTS5 BM25 (plus a vector rank when you supply a query
vector), times confidence, times recency decay, scored entirely in SQL, with a
substring fallback for partial words and typos.

The property suite checks that `recall({ asOf: T })` equals a naive SQL-free
replay of the event log, probed at every event timestamp ±1ms, across 10,000
randomized cases.

## License

Apache-2.0
