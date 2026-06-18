# memharness

**A bi-temporal, provenance-carrying memory primitive for AI agents.** One
SQLite file. No LLM or network calls in the storage layer. Exposed to any agent
via MCP.

Most agent memory is a bag of strings. memharness stores **facts**, and
combines three semantics that incumbents tend to split apart:

1. **Bi-temporal**: every fact records *when it became true in the world*
   (`valid_from`/`valid_to`) separately from *when the agent learned it*
   (`tx_at`). So you can ask: *"what did you believe on March 1st?"*
2. **Supersession, never deletion**: corrections close the old fact and link it
   to its successor. *"What did you think before I corrected you?"* has an
   answer.
3. **Provenance per fact**: every memory cites who said it, where, and when.
   *"Why do you believe that?"* has an answer. So does *"forget everything from
   that session."*

The storage layer is deterministic: no LLM, no network, no background daemon.
It's plain SQLite, so you can open the file with any client.

## When to use this (and when not to)

memharness is not a magic accuracy upgrade, and it is honest about that. If your
agent's memory is small and static and comfortably fits the context window, a
`CLAUDE.md` file (or just stuffing the history into the prompt) is simpler, and
on short histories full context will match or beat any external memory system.

Reach for memharness when:

- **History outgrows the window**: months of facts, many subjects, more than you
  want to (or can) paste into every prompt.
- **You need an audit trail**: *"what did the agent believe when it made this
  decision?"* (`as_of`), *"what changed since Monday?"* (`diff`), *"why does it
  believe this?"* (`why`). These are queries a bag of strings cannot answer.
- **You need provenance-scoped deletion**: *"forget everything from that
  session/file/source"* in one call (GDPR-shaped, not a string search).
- **Beliefs change over time**: corrections should supersede, not silently
  overwrite, so old reasoning stays explainable.

## How it compares

Honest, and pointed at the thing memharness actually does differently: it is a
deterministic, auditable storage layer rather than an extraction service.

| | Storage | LLM calls to **write** | `as_of` / `diff` / `why` | Embeddable / self-host |
|---|---|---|---|---|
| **memharness** | one SQLite file | none | yes: bi-temporal + provenance | yes, it's a library |
| mem0 | hosted / OSS service | yes (extraction pipeline) | partial / no | partial |
| Zep / Graphiti | hosted graph | yes (LLM ingestion) | bi-temporal, but LLM-built | partial |
| Letta / MemGPT | agent framework + DB | yes (agent-managed) | no | yes |
| Anthropic memory tool | client-side files | model edits files | no (model picks) | yes |
| plain `CLAUDE.md` / files | text files | none | no | yes |

Where the others win, plainly: mem0 and Zep do **automatic fact extraction**
from raw conversation, which memharness deliberately does not (the write path
stays model-free; a client or skill decides what is worth remembering). Plain
`CLAUDE.md` needs no install at all. memharness earns its place when you need the
temporal and provenance queries the others don't offer.

## Packages

| Package | What it is |
|---|---|
| `@memharness/core` | TypeScript library: schema, migrations, write path, recall ranking. No model, no network. |
| `@memharness/mcp` | MCP server (stdio) exposing the seven tools to any MCP client. |
| `@memharness/embed` | Optional. A local embedding model for hybrid (semantic) recall. Not installed by default. |

## Quick start (MCP)

The default install is small (SQLite plus the MCP SDK); the embedding model is
opt-in, see [Hybrid recall](#optional-hybrid-recall).

**Claude Code:**

```bash
claude mcp add memharness -- npx -y @memharness/mcp
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`)
**and Cursor** (`~/.cursor/mcp.json`) use the same JSON shape:

```json
{
  "mcpServers": {
    "memharness": { "command": "npx", "args": ["-y", "@memharness/mcp"] }
  }
}
```

**Codex** (`~/.codex/config.toml`) uses TOML, not JSON:

```toml
[mcp_servers.memharness]
command = "npx"
args = ["-y", "@memharness/mcp"]
```

The database lives at `~/.memharness/memory.db` (override with `MEMHARNESS_DB`;
`XDG_DATA_HOME` is honored on Linux). Nothing else is written unless you turn on
the optional [debug log](#optional-local-usage-log).

## The seven tools

| Tool | What it does | The thesis it tests |
|---|---|---|
| `remember` | store an atomic fact with confidence + provenance | facts > blobs |
| `recall` | ranked current beliefs; `as_of` returns beliefs at a past instant | bi-temporal |
| `revise` | supersede a belief, keep history | supersession > deletion |
| `diff` | what changed since a date (learned/revised/retracted) | the audit demo |
| `why` | provenance + full revision chain for a fact | trust / audit |
| `forget` | tombstone by id or by source (provenance-based deletion) | GDPR-shaped |
| `stats` | counts, subjects, schema version | — |

## Library use

```ts
import { Memharness } from "@memharness/core";

const mem = Memharness.open(); // ~/.memharness/memory.db

// Learn something now, then learn it was actually true earlier.
const { id } = mem.remember({
  subject: "user",
  fact: "lives in Osaka",
  sourceRef: "session-2026-06-09",
});
mem.revise({ oldFactId: id, newFact: "lives in Tokyo", validFrom: "2026-05-01" });

mem.recall({ query: "lives" }).facts[0].fact;   // "lives in Tokyo" (current belief)
mem.diff({ since: "2026-06-01" });               // { learned, revised, retracted }
mem.why(id);                                     // { fact, ancestors, descendants }
```

`recall` returns a `RecallResult` (`{ facts: ScoredFact[]; asOf; truncated;
usedFallback }`), not a bare string. `asOf` time-travels: `mem.recall({ query:
"lives", asOf: "2026-04-15" })` returns what was believed *as held on that date*.
That honors transaction time, so a fact learned today is not visible to a query
about the past.

Recall ranking is reciprocal-rank fusion over FTS5 BM25 (plus a vector rank when
[hybrid recall](#optional-hybrid-recall) is enabled), times confidence, times
recency decay (90-day half-life, configurable), scored in SQL. An optional
`maxTokens` budget caps output for context windows. A substring fallback catches
partial words and typos, in both FTS-only and hybrid modes.

## Optional: hybrid recall

By default, recall is FTS5 keyword search plus recency/confidence ranking: no
model, fully offline. Hybrid recall adds a **semantic** leg via a local
embedding model (BGE-small, ~130MB, downloaded once from the HuggingFace hub
then fully offline: no API key, no per-query network). Enable it in two steps:

1. Install the optional embedding package alongside the server. With `npx`:

   ```bash
   npx -y -p @memharness/mcp -p @memharness/embed memharness-mcp
   ```

   (or `npm i -g @memharness/embed` for a global install).

2. Set `MEMHARNESS_HYBRID=1` in the server's environment.

The server then keeps stored facts embedded automatically: facts you `remember`
become semantically searchable on the next `recall`, with no separate backfill
step. The first hybrid recall prints download progress to stderr while the model
loads. If the package isn't installed, the server says so and stays FTS-only; it
never fails closed.

At the library level, recall is embedding-provider-agnostic: pass your own query
vector to `recall({ queryVector })` and attach document vectors with
`setEmbedding(...)`, from any model you like.

## A worked example

Two sessions, weeks apart. The agent learns a preference, the user later
corrects it, and a downstream question asks what the agent believed *at the
time*:

```ts
// June 9: the agent learns a deploy target and acts on it.
const { id } = mem.remember({
  subject: "project:acme",
  fact: "deploys via Heroku",
  sourceRef: "session-2026-06-09",
});

// June 16: turns out the team moved to Fly back on June 1.
mem.revise({
  oldFactId: id,
  newFact: "deploys via Fly.io",
  validFrom: "2026-06-01",
  sourceRef: "session-2026-06-16",
});

mem.recall({ subject: "project:acme" }).facts[0].fact; // "deploys via Fly.io"

// "Why did the CI config you wrote on June 9 target Heroku?"
mem.recall({ subject: "project:acme", asOf: "2026-06-09" }).facts[0].fact;
//   "deploys via Heroku": what the agent honestly believed that day.

mem.why(id);   // the full chain: Heroku, superseded by Fly.io, with sources.
mem.diff({ since: "2026-06-15" });  // surfaces the Heroku -> Fly.io revision.
```

No bag-of-strings memory can answer the `as_of` question, because it overwrote
Heroku the moment it learned Fly.io.

## Correctness

The property suite is the heart of the project: for randomized sequences of
remember/revise/forget, `recall({asOf: T})` must equal the belief set produced
by a naive, SQL-free replay of the event log, probed at every event
timestamp ±1ms. 10,000 cases run on every push to main.

Benchmarked at 100k facts (10% revision chains, 2% retractions) on a developer
laptop (Apple Silicon): overall recall p95 **~1.3ms** against a 10ms budget,
across four query shapes (two-term keyword, keyword + subject, subject-only, and
`as_of` + keyword). `pnpm bench` seeds the database and asserts the budget, so
the number is reproducible rather than quoted.

One deliberate divergence from the original prototype: retraction stores a
timestamp (`retracted_at`), not a flag, so `as_of` queries *before* the
retraction still see history, which is what the prototype's docs promised but
its SQL didn't deliver.

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

### Optional: local usage log

For debugging or measuring your own usage, set `MEMHARNESS_DEBUG=1` and the
server appends an op-name and timestamp line (never fact content) to a
`usage.log` next to the database. It is off by default, fully local, and never
networked.

## License

Apache-2.0
