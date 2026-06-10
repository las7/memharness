import { type Memharness, MemharnessError } from "@memharness/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fmtDiff, fmtRecall, fmtStats, fmtWhy } from "./format.js";

/** meta carries op-level counters (hit counts, flags) — never fact content. */
export type UsageLogger = (op: string, meta?: Record<string, unknown>) => void;

interface TextResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

function text(t: string): TextResult {
  return { content: [{ type: "text", text: t }] };
}

/**
 * Wraps a Memharness instance as an MCP server. logUsage receives the op name
 * only (dogfood-gate instrumentation; never fact content).
 */
export function createServer(mem: Memharness, logUsage: UsageLogger = () => {}): McpServer {
  const server = new McpServer(
    { name: "memharness", version: "0.1.0" },
    {
      instructions:
        "memharness is the agent's long-term memory. Use it proactively, not only when asked:\n" +
        "- At the start of a task, recall relevant context (e.g. subject 'user' and the " +
        "project being worked on) before answering questions that may depend on it.\n" +
        "- When you learn a durable fact — a preference, decision, correction, or stable " +
        "property of the user, a project, or the environment — call remember immediately, " +
        "with source_ref set to where it came from.\n" +
        "- When new information contradicts a stored belief, recall the old fact and use " +
        "revise (not remember or forget) so history is preserved.\n" +
        "- Do not store transient task state, secrets, or credentials.\n" +
        "Facts are bi-temporal: recall's as_of answers what was believed at a past time, and " +
        "valid_from on remember/revise backdates when something became true in the world.",
    },
  );

  const handle =
    (op: string, fn: () => string, meta?: () => Record<string, unknown>) => (): TextResult => {
      try {
        const out = text(fn());
        logUsage(op, meta?.());
        return out;
      } catch (err) {
        logUsage(op, { error: true });
        if (err instanceof MemharnessError) {
          return { ...text(`Error: ${err.message}`), isError: true };
        }
        throw err;
      }
    };

  server.registerTool(
    "remember",
    {
      description:
        "Store an atomic fact in long-term memory. Use for durable knowledge about the " +
        "user, their projects, preferences, decisions, and environment — not transient " +
        "task state. If this contradicts an existing belief, find it with recall and use " +
        "revise instead. Always fill source_ref with where this came from (session, file, URL) if known.",
      inputSchema: {
        subject: z.string().describe("What the fact is about, e.g. 'user' or 'project:memharness'"),
        fact: z.string().describe("The atomic statement itself"),
        predicate: z
          .string()
          .optional()
          .describe("Optional relation type, e.g. 'prefers', 'works-on'"),
        confidence: z.number().min(0).max(1).optional().describe("0..1, default 1.0"),
        source_ref: z
          .string()
          .optional()
          .describe("Where this came from: session id, file path, URL, utterance"),
        source_agent: z.string().optional().describe("Which agent/app is writing this"),
        valid_from: z
          .string()
          .optional()
          .describe("ISO 8601: when this became true in the world, if not now"),
      },
    },
    (args) =>
      handle("remember", () => {
        const r = mem.remember({
          subject: args.subject,
          fact: args.fact,
          predicate: args.predicate,
          confidence: args.confidence,
          sourceRef: args.source_ref,
          sourceAgent: args.source_agent ?? "mcp",
          validFrom: args.valid_from,
        });
        return `Remembered as fact #${r.id}.`;
      })(),
  );

  server.registerTool(
    "recall",
    {
      description:
        "Retrieve relevant memories. A plain call returns current beliefs ranked by " +
        "relevance × confidence × recency. as_of (ISO date, e.g. '2026-06-01') returns what " +
        "was believed AT THAT TIME — including facts since revised or retracted. Use as_of to " +
        "answer 'what did you think before I corrected you?'. subject filters to one entity.",
      inputSchema: {
        query: z.string().optional().describe("Free-text search over the facts"),
        subject: z.string().optional().describe("Exact subject filter, e.g. 'user'"),
        as_of: z
          .string()
          .optional()
          .describe("ISO date/datetime: return beliefs as held at that instant"),
        limit: z.number().int().min(1).optional().describe("Max facts, default 8"),
        max_tokens: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Token budget for the returned facts"),
      },
    },
    (args) => {
      // hits/fallback/asOf land in the usage log: a zero-hit recall is the
      // observable signature of a memory miss (or an empty db).
      let last: { hits: number; fallback: boolean } | undefined;
      return handle(
        "recall",
        () => {
          const r = mem.recall({
            query: args.query,
            subject: args.subject,
            asOf: args.as_of,
            limit: args.limit,
            maxTokens: args.max_tokens,
          });
          last = { hits: r.facts.length, fallback: r.usedFallback };
          return fmtRecall(r);
        },
        () => ({
          hits: last?.hits,
          fallback: last?.fallback || undefined,
          asOf: args.as_of !== undefined || undefined,
        }),
      )();
    },
  );

  server.registerTool(
    "revise",
    {
      description:
        "Replace a belief with an updated one. The old fact is closed and linked to its " +
        "successor — history is preserved, never deleted. Use when the user corrects you or " +
        "circumstances change. Find the old fact's id with recall first. valid_from can " +
        "backdate when the new state actually began (e.g. 'moved last month').",
      inputSchema: {
        old_fact_id: z.number().int().describe("Id of the fact being superseded"),
        new_fact: z.string().describe("The corrected statement"),
        confidence: z.number().min(0).max(1).optional(),
        source_ref: z.string().optional(),
        source_agent: z.string().optional(),
        valid_from: z
          .string()
          .optional()
          .describe("ISO 8601: when the new state became true, if not now"),
      },
    },
    (args) =>
      handle("revise", () => {
        const r = mem.revise({
          oldFactId: args.old_fact_id,
          newFact: args.new_fact,
          confidence: args.confidence,
          sourceRef: args.source_ref,
          sourceAgent: args.source_agent ?? "mcp",
          validFrom: args.valid_from,
        });
        return `Fact #${r.oldId} superseded by #${r.newId}.`;
      })(),
  );

  server.registerTool(
    "diff",
    {
      description:
        "What changed in memory since a given ISO date: new facts learned, beliefs revised, " +
        "facts retracted. The 'what have you learned about X since Monday?' query.",
      inputSchema: {
        since: z.string().describe("ISO date/datetime to diff from"),
        subject: z.string().optional().describe("Limit to one subject"),
      },
    },
    (args) =>
      handle("diff", () => fmtDiff(mem.diff({ since: args.since, subject: args.subject })))(),
  );

  server.registerTool(
    "why",
    {
      description:
        "Full provenance and revision chain for a fact: where it came from, when it was " +
        "learned, what it superseded, and what superseded it. Use to answer 'why do you " +
        "believe that?' or to audit a belief before revising it.",
      inputSchema: {
        fact_id: z.number().int().describe("The fact to explain"),
      },
    },
    (args) => handle("why", () => fmtWhy(mem.why(args.fact_id)))(),
  );

  server.registerTool(
    "forget",
    {
      description:
        "Retract a fact by id, or retract EVERYTHING from a given source_ref " +
        "(provenance-based deletion: 'forget everything from that session'). Tombstoned, not " +
        "erased: as_of queries before the retraction still show history; current recall " +
        "never returns it.",
      inputSchema: {
        fact_id: z.number().int().optional().describe("Retract this fact"),
        source_ref: z.string().optional().describe("Retract every fact recorded from this source"),
      },
    },
    (args) =>
      handle("forget", () => {
        if (args.fact_id === undefined && args.source_ref === undefined) {
          return "Provide fact_id or source_ref.";
        }
        const r =
          args.fact_id !== undefined
            ? mem.forget({ factId: args.fact_id })
            : mem.forget({ sourceRef: args.source_ref as string });
        return `Retracted ${r.retractedCount} fact(s).`;
      })(),
  );

  server.registerTool(
    "stats",
    {
      description: "Memory database statistics: counts, top subjects, schema version, db path.",
      inputSchema: {},
    },
    () => handle("stats", () => fmtStats(mem.stats()))(),
  );

  return server;
}
