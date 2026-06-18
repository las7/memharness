#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Memharness, resolveDefaultDbPath } from "@memharness/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type EmbedProvider, createServer } from "./server.js";

const dbPath = process.env.MEMHARNESS_DB ?? resolveDefaultDbPath();

let mem: Memharness;
try {
  mem = Memharness.open({ dbPath });
} catch (err) {
  // The MCP client only sees "server exited" otherwise, so name the path and the
  // likely fix (the override env var) before bailing out.
  const reason = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    `memharness: could not open the memory database at ${dbPath}\n  ${reason}\n  Check that the directory exists and is writable, or set MEMHARNESS_DB to another path.\n`,
  );
  process.exit(1);
}

// Optional local usage log (op name + timestamp only, never fact content): an
// opt-in debugging aid, off by default so a fresh install writes nothing the
// user didn't ask for. Enable with MEMHARNESS_DEBUG=1.
const usageLog =
  process.env.MEMHARNESS_DEBUG === "1" && dbPath !== ":memory:"
    ? join(dirname(dbPath), "usage.log")
    : null;
const logUsage = (op: string, meta?: Record<string, unknown>): void => {
  if (usageLog === null) return;
  try {
    appendFileSync(usageLog, `${JSON.stringify({ op, at: new Date().toISOString(), ...meta })}\n`);
  } catch {
    // instrumentation must never break the server
  }
};

// Hybrid recall is opt-in (MEMHARNESS_HYBRID=1): it lazy-loads a ~130MB local
// embedding model into the server process, so the default stays lightweight.
// Only wire it when sqlite-vec actually loaded — otherwise the vector leg can't
// be queried and embedding would be wasted work.
let embed: EmbedProvider | undefined;
if (process.env.MEMHARNESS_HYBRID === "1" && mem.vecEnabled) {
  try {
    const e = await import("@memharness/embed");
    // Surface the one-time model download instead of a silent ~20s stall.
    const seen = new Set<string>();
    e.setEmbedProgress((p) => {
      if (p.status === "initiate" && p.file) {
        if (seen.has(p.file)) return;
        seen.add(p.file);
        process.stderr.write(`memharness: downloading embedding model (${p.file})…\n`);
      } else if (p.status === "ready") {
        process.stderr.write("memharness: embedding model ready\n");
      }
    });
    embed = {
      model: e.EMBED_MODEL,
      query: (text) => e.embedQuery(text),
      documents: (texts) => e.embedDocuments(texts),
    };
  } catch {
    // @memharness/embed is an optional peer dependency (kept out of the default
    // install so it stays light) → tell the user how to turn hybrid on, then
    // stay FTS-only.
    process.stderr.write(
      "memharness: MEMHARNESS_HYBRID=1 but @memharness/embed is not installed; " +
        "recall stays FTS-only. Install it to enable hybrid recall, e.g.\n" +
        "  npx -y -p @memharness/mcp -p @memharness/embed memharness-mcp\n",
    );
  }
} else if (process.env.MEMHARNESS_HYBRID === "1" && !mem.vecEnabled) {
  process.stderr.write(
    "memharness: MEMHARNESS_HYBRID=1 but sqlite-vec did not load here; recall stays FTS-only.\n",
  );
}

const server = createServer(mem, logUsage, embed);
await server.connect(new StdioServerTransport());
