# @memharness/mcp

MCP server (stdio) for [memharness](https://github.com/las7/memharness): a
bi-temporal, provenance-carrying memory primitive for AI agents. One SQLite
file, no LLM or network calls in the storage layer.

It exposes seven tools to any MCP client: `remember`, `recall` (with `as_of`
time travel), `revise`, `diff`, `why`, `forget`, `stats`.

## Install

**Claude Code:**

```bash
claude mcp add memharness -- npx -y @memharness/mcp
```

**Claude Desktop / Cursor** (JSON config):

```json
{
  "mcpServers": {
    "memharness": { "command": "npx", "args": ["-y", "@memharness/mcp"] }
  }
}
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.memharness]
command = "npx"
args = ["-y", "@memharness/mcp"]
```

The database lives at `~/.memharness/memory.db` (override with `MEMHARNESS_DB`).

## Why bi-temporal

Every fact records *when it became true in the world* separately from *when the
agent learned it*, corrections supersede instead of overwriting, and every fact
carries its source. So `as_of` can answer "what did you believe when you made
this decision?", `why` can answer "why do you believe that?", and `forget` can
drop everything from a given source.

## Optional: hybrid recall

Recall is FTS5 keyword search by default (no model, fully offline). For semantic
recall, install the optional embedding package and set `MEMHARNESS_HYBRID=1`:

```bash
npx -y -p @memharness/mcp -p @memharness/embed memharness-mcp
```

The local embedding model (BGE-small, ~130MB) is downloaded once, then offline.
Stored facts are embedded automatically; there is no separate backfill step.

## Optional: local usage log

Set `MEMHARNESS_DEBUG=1` to append an op-name and timestamp line (never fact
content) to a `usage.log` beside the database. Off by default, fully local.

See the [main README](https://github.com/las7/memharness#readme) for the full
story, comparisons, and a worked example.

## License

Apache-2.0
