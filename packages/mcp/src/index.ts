#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Memharness, resolveDefaultDbPath } from "@memharness/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const dbPath = process.env.MEMHARNESS_DB ?? resolveDefaultDbPath();
const mem = Memharness.open({ dbPath });

// Dogfood-gate instrumentation: op name + timestamp only, locally, never content.
const usageLog = dbPath === ":memory:" ? null : join(dirname(dbPath), "usage.log");
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
let embedQuery: ((text: string) => Promise<Float32Array>) | undefined;
if (process.env.MEMHARNESS_HYBRID === "1") {
  try {
    const embed = await import("@memharness/embed");
    embedQuery = (text: string) => embed.embedQuery(text);
  } catch {
    // embed package or model unavailable → recall stays FTS-only
  }
}

const server = createServer(mem, logUsage, embedQuery);
await server.connect(new StdioServerTransport());
