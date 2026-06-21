# Contributing to memharness

Thanks for hacking on memharness. This gets you from a fresh clone to a green,
runnable local build in one command.

## Prerequisites

- **Node >= 22.13** (`.nvmrc` pins the 22 line; `nvm use` picks a current 22.x).
- **pnpm 11** via Corepack (bundled with Node): `corepack enable`. The repo pins
  the exact version in `package.json` (`packageManager`), so Corepack uses it
  automatically.

## Setup

```bash
git clone https://github.com/las7/memharness.git
cd memharness
pnpm bootstrap        # install + build + test, from clone to green
```

`pnpm bootstrap` is just `pnpm install && pnpm build && pnpm test`.

> **Gotcha: `dist/` is gitignored.** Each package's compiled output lives in
> `dist/`, which is not committed, so a fresh clone has no build yet. You must
> run `pnpm build` (or `pnpm bootstrap`) before anything that points at
> `packages/*/dist/...`, including a local MCP server config. If a client says
> the memharness server "exited immediately," the usual cause is an unbuilt or
> stale `dist`.

## Running your local build in a client

Point your MCP client at the built entrypoint (after `pnpm build`):

```json
{
  "mcpServers": {
    "memharness": {
      "command": "node",
      "args": ["/absolute/path/to/memharness/packages/mcp/dist/index.js"]
    }
  }
}
```

Health-check an install at any time:

```bash
node packages/mcp/dist/doctor.js     # or: npx -y -p @memharness/mcp memharness-doctor
```

## Develop

```bash
pnpm dev        # parallel tsc --watch across packages; rebuilds dist on save
```

Restart your client (or its MCP connection) to pick up a rebuilt server.

## Tests and quality gates

```bash
pnpm test            # all unit + integration tests (vitest)
pnpm test:property   # the bi-temporal property suite (oracle replay)
pnpm bench           # recall benchmark at 100k facts; asserts the p95 budget
pnpm lint            # Biome
pnpm format          # Biome autofix
```

The property suite is the heart of correctness: randomized
remember/revise/forget sequences whose `recall({asOf})` must equal a naive
replay of the event log. CI runs it at a high `FC_NUM_RUNS`; please keep it
green. The benchmark guards recall latency, so if you touch ranking or the
recall SQL, run `pnpm bench` and keep it under budget.

## Style

- Biome for lint/format (`pnpm format` before committing).
- Keep SQL in `packages/core/src/sql.ts` (the single seam for a future driver
  swap). Keep the write path model-free: no network or LLM calls in
  remember/revise.
