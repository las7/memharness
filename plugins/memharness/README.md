# memharness (Claude Code plugin)

One-command install of [memharness](https://github.com/las7/memharness) long-term
memory, plus the scaffolding that makes it proactive. Installing the raw MCP
server gives you the tools but leaves recall up to the model; this plugin adds
the session-start recall and capture behavior so memory just works.

## What it bundles

- **MCP server** (`.mcp.json`): runs `npx -y @memharness/mcp`, exposing the 7
  tools (`remember`, `recall`, `revise`, `diff`, `why`, `forget`, `stats`). The
  database lives at `~/.memharness/memory.db` (override with `MEMHARNESS_DB`).
- **SessionStart hook**: runs `memharness-context` and injects your most relevant
  current beliefs into context at the start of every session, so the agent
  starts already knowing your durable facts. Exits quietly when the store is
  empty.
- **PostToolUse hook** (`hooks/capture-on-commit.sh`): after a `git commit`,
  nudges the agent to capture any durable facts the work established.
- **Skill** (`skills/memharness`): the proactive-use policy (recall before
  answering, atomic writes with provenance, revise-not-contradict, the
  store-the-delta litmus test, canonical subject naming).

## Install

```
/plugin marketplace add las7/memharness
/plugin install memharness@memharness
/reload-plugins
```

The MCP server and hooks activate on enable; no restart needed.

## Two things the plugin cannot do (Claude Code constraints)

1. **It cannot auto-allow tool permissions.** The first `recall`/`remember` call
   prompts for approval once. To skip the prompt, add to your
   `~/.claude/settings.local.json`:

   ```json
   { "permissions": { "allow": ["mcp__memharness__recall", "mcp__memharness__remember", "mcp__memharness__revise", "mcp__memharness__stats"] } }
   ```

2. **It cannot ship a `CLAUDE.md`.** The proactive-use policy ships as the bundled
   skill instead, which the model invokes when memory is relevant. The server's
   own `instructions` string also carries a condensed version to every MCP client.

## Optional: hybrid (semantic) recall

Vector recall is opt-in and pulls a larger embedding model. Enable it by setting
`MEMHARNESS_HYBRID=1` in the MCP server env (edit `.mcp.json` to add
`"env": { "MEMHARNESS_HYBRID": "1" }`) and installing `@memharness/embed`.

## Non-Claude-Code clients

The MCP server works in any client (Claude Desktop, Cursor, Codex, and others);
see the main repo's README for per-client config. The hooks and skill are
Claude-Code-only, so on other clients use the server `instructions` string and
the per-client rules-file snippets documented in the main repo.
