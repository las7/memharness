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
const logUsage = (op: string): void => {
  if (usageLog === null) return;
  try {
    appendFileSync(usageLog, `${JSON.stringify({ op, at: new Date().toISOString() })}\n`);
  } catch {
    // instrumentation must never break the server
  }
};

const server = createServer(mem, logUsage);
await server.connect(new StdioServerTransport());
