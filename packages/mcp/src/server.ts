import { type Memharness, MemharnessError } from "@memharness/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fmtDiff, fmtRecall, fmtStats, fmtWhy } from "./format.js";

/** meta carries op-level counters (hit counts, flags) — never fact content. */
export type UsageLogger = (op: string, meta?: Record<string, unknown>) => void;

/**
 * Optional embedding provider; when supplied, recall runs hybrid (FTS + vector)
 * and the server keeps stored facts embedded automatically (no separate reembed
 * step). `model` tags the vectors so a model change re-embeds cleanly.
 */
export interface EmbedProvider {
  model: string;
  query: (text: string) => Promise<Float32Array>;
  documents: (texts: string[]) => Promise<Float32Array[]>;
}

interface TextResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

function text(t: string): TextResult {
  return { content: [{ type: "text", text: t }] };
}

/** Beyond this, a "fact" is a notebook entry; the write is refused with guidance. */
const MAX_FACT_CHARS = 1500;

/** Models classify far better than they calibrate: basis is the confidence input. */
const BASIS_CONFIDENCE = {
  "user-stated": 1.0,
  verified: 0.95,
  reported: 0.8,
  inferred: 0.6,
} as const;

/** A fact must be at least this long to even be a code-map-smell candidate. */
const CODEMAP_MIN_CHARS = 160;
/** File-path-like tokens: a slash-separated path ending in a common source extension. */
const FILE_PATH_RE =
  /[\w.-]+\/[\w./-]*\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|rb|c|h|cpp|cc|hpp|sql|json|toml|yaml|yml|sh)\b/gi;
/** Dotted or deeply-snake_cased symbol names, e.g. `foo.barBaz` or `some_long_helper_name`. */
const SYMBOL_RE = /\b\w+(?:\.\w+){2,}\b|\b\w+_\w+_\w+\w*\b/g;

/**
 * Conservative "code-map smell" heuristic: does this fact read like a structural
 * map an Explore agent could reconstruct from the repo (file lists / call graphs /
 * symbol tables), rather than a decision/rationale/gotcha worth remembering?
 * Tuned for low false positives: it must be long AND carry several path/symbol
 * tokens. Advisory only — the caller never blocks the write on it.
 */
function looksLikeCodeMap(fact: string): boolean {
  if (fact.length < CODEMAP_MIN_CHARS) return false;
  const paths = (fact.match(FILE_PATH_RE) ?? []).length;
  const symbols = new Set(fact.match(SYMBOL_RE) ?? []).size;
  // Several real file paths is the strongest signal on its own.
  if (paths >= 3) return true;
  // Or a path or two plus a cluster of dotted/snake symbol names.
  if (paths >= 1 && symbols >= 3) return true;
  // Or many distinct symbol-table-like names with no prose justification.
  if (symbols >= 5) return true;
  return false;
}

/**
 * Wraps a Memharness instance as an MCP server. logUsage receives the op name
 * only (dogfood-gate instrumentation; never fact content).
 */
export function createServer(
  mem: Memharness,
  logUsage: UsageLogger = () => {},
  embed?: EmbedProvider,
): McpServer {
  /** Document text for a fact, matching the memharness-reembed CLI exactly. */
  const docText = (f: { subject: string; predicate: string; fact: string }): string =>
    [f.subject, f.predicate, f.fact].filter(Boolean).join(": ");

  /**
   * Keep the vector index current: embed any facts that lack a current-model
   * vector. Runs before a hybrid recall so facts written via `remember` (or the
   * core library, or before hybrid was enabled) are searchable without a manual
   * reembed pass. Cheap when nothing is pending; the first call after enabling
   * hybrid does the one-time backfill. Failures degrade to whatever is embedded.
   */
  let backfilling: Promise<void> | undefined;
  const backfillEmbeddings = async (): Promise<void> => {
    if (!embed) return;
    // Collapse concurrent recalls onto a single in-flight backfill.
    if (backfilling) return backfilling;
    backfilling = (async () => {
      try {
        let embedded = 0;
        for (;;) {
          const targets = mem.embedTargets(embed.model, 64);
          if (targets.length === 0) break;
          const vecs = await embed.documents(targets.map(docText));
          for (let i = 0; i < targets.length; i++) {
            const v = vecs[i];
            if (v !== undefined) mem.setEmbedding(targets[i]!.id, v, embed.model);
          }
          embedded += targets.length;
        }
        if (embedded > 0) {
          process.stderr.write(`memharness: embedded ${embedded} fact(s) for hybrid recall\n`);
        }
      } catch {
        // Model unavailable / offline → recall proceeds on whatever is embedded.
      } finally {
        backfilling = undefined;
      }
    })();
    return backfilling;
  };
  const server = new McpServer(
    { name: "memharness", version: "0.1.1" },
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
        "- Keep facts atomic: one assertion per remember call.\n" +
        "- Prefer facts recorded nowhere else (decisions, preferences, corrections, context) " +
        "over knowledge derivable from files the agent can read anyway.\n" +
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
        "Store ONE atomic fact in long-term memory: a single assertion, ideally one sentence " +
        "(aim for under 250 characters; writes over 1500 are rejected). Split compound " +
        "knowledge into multiple remember calls so each piece can be revised independently " +
        "later. Use for durable knowledge about the user, their projects, preferences, " +
        "decisions, and environment — not transient task state. If this contradicts an " +
        "existing belief, find it with recall and use revise instead. Always fill source_ref " +
        "with where this came from (session, file, URL) if known. If the fact describes code " +
        "you just read at a known commit, also set source_commit (and source_path) so staleness " +
        "checking can flag it when the repo moves past that commit.",
      inputSchema: {
        subject: z.string().describe("What the fact is about, e.g. 'user' or 'project:memharness'"),
        fact: z.string().describe("The atomic statement itself"),
        predicate: z
          .string()
          .optional()
          .describe("Optional relation type, e.g. 'prefers', 'works-on'"),
        basis: z
          .enum(["user-stated", "verified", "reported", "inferred"])
          .optional()
          .describe(
            "How you know this: user-stated (they told you), verified (you checked " +
              "directly), reported (read in docs/code but not confirmed), inferred " +
              "(your deduction). Sets confidence. Default user-stated",
          ),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Numeric override for basis; rarely needed"),
        importance: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe(
            "1–10 salience: how strongly this should rank up and resist decay. Default 5 " +
              "(neutral). Reserve 8–10 for durable, high-stakes facts (core identity, hard " +
              "constraints); 1–3 for incidental detail.",
          ),
        kind: z
          .enum(["semantic", "episodic", "procedural"])
          .optional()
          .describe(
            "semantic = stable facts/preferences (slow decay), episodic = events/one-offs " +
              "(fast decay), procedural = how-to/workflow (slow decay). Default semantic.",
          ),
        source_ref: z
          .string()
          .optional()
          .describe("Where this came from: session id, file path, URL, utterance"),
        source_commit: z
          .string()
          .optional()
          .describe(
            "Git SHA you read this code at; pins the fact for staleness checking. " +
              "Omit for non-code facts.",
          ),
        source_path: z
          .string()
          .optional()
          .describe("Repo-relative file path this fact describes, if any."),
        source_agent: z.string().optional().describe("Which agent/app is writing this"),
        valid_from: z
          .string()
          .optional()
          .describe("ISO 8601: when this became true in the world, if not now"),
      },
    },
    (args) =>
      handle("remember", () => {
        if (args.fact.length > MAX_FACT_CHARS) {
          return `Not stored: ${args.fact.length} characters is a briefing note, not a fact. Split it into separate remember calls, one assertion each, and try again.`;
        }
        const r = mem.remember({
          subject: args.subject,
          fact: args.fact,
          predicate: args.predicate,
          confidence: args.confidence ?? BASIS_CONFIDENCE[args.basis ?? "user-stated"],
          importance: args.importance,
          kind: args.kind,
          sourceRef: args.source_ref,
          sourceCommit: args.source_commit,
          sourcePath: args.source_path,
          sourceAgent: args.source_agent ?? "mcp",
          validFrom: args.valid_from,
        });
        // In-result feedback steers models far better than upfront instructions.
        const nudges: string[] = [];
        if (args.fact.length > 280) {
          nudges.push(
            "that fact is long — next time split compound knowledge into separate remember " +
              "calls so each piece can be revised independently.",
          );
        }
        // Code-map smell: a long, path/symbol-dense fact an Explore agent could
        // reconstruct from the repo. Advisory only — never blocks the write.
        if (args.source_commit === undefined && looksLikeCodeMap(args.fact)) {
          nudges.push(
            "this reads like a code map an Explore agent could reconstruct from the repo — " +
              "consider storing the decision/rationale/gotcha instead, or pin it with source_commit.",
          );
        }
        const nudge = nudges.length > 0 ? ` Note: ${nudges.join(" ")}` : "";
        return `Remembered as fact #${r.id}.${nudge}`;
      })(),
  );

  server.registerTool(
    "recall",
    {
      description:
        "Retrieve relevant memories. A plain call returns current beliefs ranked by " +
        "relevance × confidence × importance × recency (recency is freshened each time a fact " +
        "is recalled). as_of (ISO date, e.g. '2026-06-01') returns what " +
        "was believed AT THAT TIME — including facts since revised or retracted. Use as_of to " +
        "answer 'what did you think before I corrected you?'. subject filters to one entity; " +
        "kind filters to semantic/episodic/procedural.",
      inputSchema: {
        query: z.string().optional().describe("Free-text search over the facts"),
        subject: z.string().optional().describe("Exact subject filter, e.g. 'user'"),
        kind: z
          .enum(["semantic", "episodic", "procedural"])
          .optional()
          .describe("Filter to one memory kind"),
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
    async (args) => {
      // hits/fallback/asOf land in the usage log: a zero-hit recall is the
      // observable signature of a memory miss (or an empty db).
      let last: { hits: number; fallback: boolean } | undefined;
      // Embed the query for hybrid recall when an embedder is wired and there's
      // text to embed. Failure (model missing, etc.) silently degrades to FTS.
      let queryVector: Float32Array | undefined;
      if (embed && args.query !== undefined && args.query.trim() !== "") {
        try {
          // Make sure stored facts are embedded before we lean on the vector
          // leg, so a just-remembered fact is immediately recall-able.
          await backfillEmbeddings();
          queryVector = await embed.query(args.query);
        } catch {
          queryVector = undefined;
        }
      }
      return handle(
        "recall",
        () => {
          const r = mem.recall({
            query: args.query,
            subject: args.subject,
            kind: args.kind,
            asOf: args.as_of,
            limit: args.limit,
            maxTokens: args.max_tokens,
            queryVector,
          });
          last = { hits: r.facts.length, fallback: r.usedFallback };
          return fmtRecall(r);
        },
        () => ({
          hits: last?.hits,
          fallback: last?.fallback || undefined,
          asOf: args.as_of !== undefined || undefined,
          hybrid: queryVector !== undefined || undefined,
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
        "backdate when the new state actually began (e.g. 'moved last month'). importance and " +
        "kind are inherited from the old fact unless you override them.",
      inputSchema: {
        old_fact_id: z.number().int().describe("Id of the fact being superseded"),
        new_fact: z.string().describe("The corrected statement"),
        basis: z
          .enum(["user-stated", "verified", "reported", "inferred"])
          .optional()
          .describe("How you know the correction. Sets confidence. Default user-stated"),
        confidence: z.number().min(0).max(1).optional().describe("Numeric override for basis"),
        importance: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe("1–10 salience override; default inherits the old fact's importance"),
        kind: z
          .enum(["semantic", "episodic", "procedural"])
          .optional()
          .describe("Override the memory kind; default inherits the old fact's kind"),
        source_ref: z.string().optional(),
        source_commit: z
          .string()
          .optional()
          .describe(
            "Git SHA you re-read this code at; re-pins the corrected fact. " +
              "Not inherited from the old fact — supply it if the correction came from code.",
          ),
        source_path: z
          .string()
          .optional()
          .describe("Repo-relative file path the corrected fact describes, if any."),
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
          confidence: args.confidence ?? BASIS_CONFIDENCE[args.basis ?? "user-stated"],
          importance: args.importance,
          kind: args.kind,
          sourceRef: args.source_ref,
          sourceCommit: args.source_commit,
          sourcePath: args.source_path,
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
