#!/usr/bin/env node
// memharness-context: compact memory dump for session-start injection (e.g. a
// Claude Code SessionStart hook). Prompt-steered recall is pull and decays
// under harness drift; this makes memory push, like file-based memory.
// Contract: stdout is injected into the model's context verbatim; any failure
// must print nothing and exit 0 — a hook must never break session start.
import { appendFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Memharness, estimateTokens, resolveDefaultDbPath } from "@memharness/core";
import { fmtFact } from "./format.js";

interface Args {
  subjects: string[];
  maxTokens: number;
  limit: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { subjects: [], maxTokens: 600, limit: 8 };
  for (let i = 0; i < argv.length; i++) {
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${argv[i - 1]} needs a value`);
      return v;
    };
    if (argv[i] === "--subject") args.subjects.push(next());
    else if (argv[i] === "--max-tokens") args.maxTokens = Number(next());
    else if (argv[i] === "--limit") args.limit = Number(next());
    else throw new Error(`unknown flag ${argv[i]}`);
  }
  if (args.subjects.length === 0) args.subjects = ["user"];
  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = process.env.MEMHARNESS_DB ?? resolveDefaultDbPath();
  // Never create a db as a hook side effect.
  if (dbPath !== ":memory:" && !existsSync(dbPath)) process.exit(0);
  const mem = Memharness.open({ dbPath });

  const sections: string[] = [];
  let budget = args.maxTokens;
  const hits: Record<string, number> = {};
  for (const subject of args.subjects) {
    if (budget <= 0) break;
    const r = mem.recall({ subject, limit: args.limit, maxTokens: budget });
    hits[subject] = r.facts.length;
    if (r.facts.length === 0) continue;
    const lines = [`## ${subject}`, ...r.facts.map((f) => fmtFact(f))];
    const section = lines.join("\n");
    budget -= estimateTokens(section);
    sections.push(section);
  }

  if (sections.length > 0) {
    const requested = new Set(args.subjects);
    const others = mem
      .stats()
      .topSubjects.filter((t) => !requested.has(t.subject))
      .map((t) => `${t.subject} (${t.count})`);
    const out = [
      "Long-term memory (memharness), injected at session start. For anything " +
        "deeper, use the memharness MCP tools: recall (supports as_of), remember " +
        "for new durable facts, revise — never re-remember — for corrections.",
      ...sections,
    ];
    if (others.length > 0) out.push(`Other subjects on file: ${others.join(", ")}.`);
    process.stdout.write(`${out.join("\n\n")}\n`);
  }

  // Dogfood-gate instrumentation, same shape as the MCP server's. A distinct
  // op keeps hook injections from inflating agent-initiated recall counts.
  if (dbPath !== ":memory:") {
    try {
      appendFileSync(
        join(dirname(dbPath), "usage.log"),
        `${JSON.stringify({ op: "context", at: new Date().toISOString(), hits })}\n`,
      );
    } catch {
      // instrumentation must never break the hook
    }
  }
} catch (err) {
  process.stderr.write(`memharness-context: ${err instanceof Error ? err.message : err}\n`);
  process.exit(0);
}
