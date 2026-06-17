import { FakeClock, Memharness } from "@memharness/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

async function connected(embedQuery?: (text: string) => Promise<Float32Array>) {
  const mem = Memharness.open({ dbPath: ":memory:", clock: new FakeClock() });
  const usage: string[] = [];
  const metas: Array<Record<string, unknown> | undefined> = [];
  const server = createServer(
    mem,
    (op, meta) => {
      usage.push(op);
      metas.push(meta);
    },
    embedQuery,
  );
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { mem, client, usage, metas };
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map((c) => c.text ?? "").join("\n");
}

describe("memharness MCP server", () => {
  it("exposes all seven tools", async () => {
    const { client } = await connected();
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["diff", "forget", "recall", "remember", "revise", "stats", "why"]);
  });

  it("round-trips remember → recall → revise → why → diff → forget → stats", async () => {
    const { client, usage } = await connected();

    const r1 = await client.callTool({
      name: "remember",
      arguments: { subject: "user", fact: "lives in Osaka", source_ref: "session-1" },
    });
    expect(textOf(r1)).toBe("Remembered as fact #1.");

    const recall1 = await client.callTool({ name: "recall", arguments: { query: "Osaka" } });
    expect(textOf(recall1)).toContain("[#1] user : lives in Osaka");

    const revised = await client.callTool({
      name: "revise",
      arguments: { old_fact_id: 1, new_fact: "lives in Tokyo" },
    });
    expect(textOf(revised)).toBe("Fact #1 superseded by #2.");

    const why = await client.callTool({ name: "why", arguments: { fact_id: 2 } });
    expect(textOf(why)).toContain("superseded ←");

    const diff = await client.callTool({
      name: "diff",
      arguments: { since: "2026-01-01" },
    });
    expect(textOf(diff)).toContain("LEARNED (1):");
    expect(textOf(diff)).toContain("REVISED (1):");

    const forgot = await client.callTool({
      name: "forget",
      arguments: { source_ref: "session-1" },
    });
    expect(textOf(forgot)).toBe("Retracted 1 fact(s).");

    const stats = await client.callTool({ name: "stats", arguments: {} });
    expect(textOf(stats)).toContain("Total facts ever: 2");

    expect(usage).toEqual(["remember", "recall", "revise", "why", "diff", "forget", "stats"]);
  });

  it("supports as_of time travel through the tool layer", async () => {
    const { client } = await connected();
    await client.callTool({
      name: "remember",
      arguments: { subject: "user", fact: "prefers tabs" },
    });
    await client.callTool({
      name: "revise",
      arguments: {
        old_fact_id: 1,
        new_fact: "prefers spaces",
        valid_from: "2026-01-01T00:00:30.000Z",
      },
    });
    // FakeClock starts 2026-01-01T00:00:00Z; the remember landed at :00
    const past = await client.callTool({
      name: "recall",
      arguments: { as_of: "2026-01-01T00:00:00.500Z" },
    });
    expect(textOf(past)).toContain("prefers tabs");
    expect(textOf(past)).not.toContain("prefers spaces");
  });

  it("returns isError results for domain errors instead of crashing", async () => {
    const { client } = await connected();
    const r = await client.callTool({ name: "why", arguments: { fact_id: 99 } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("no fact #99");
  });

  it("nudges toward atomic facts when a remember is paragraph-sized", async () => {
    const { client } = await connected();
    const short = await client.callTool({
      name: "remember",
      arguments: { subject: "user", fact: "drinks oolong tea" },
    });
    expect(textOf(short)).toBe("Remembered as fact #1.");

    const long = await client.callTool({
      name: "remember",
      arguments: {
        subject: "project:x",
        fact:
          "The project is a pnpm monorepo with two packages, uses Biome for linting and " +
          "vitest for tests, targets Node 20.19 and above, is licensed Apache-2.0, stores " +
          "data in SQLite via better-sqlite3, and deploys nowhere yet because it has not " +
          "launched; the benchmark suite runs weekly in CI on ubuntu-latest runners.",
      },
    });
    expect(textOf(long)).toContain("Remembered as fact #2.");
    expect(textOf(long)).toContain("split compound knowledge");
  });

  it("maps basis to confidence (categorical beats scalar for model calibration)", async () => {
    const { mem, client } = await connected();
    await client.callTool({
      name: "remember",
      arguments: { subject: "user", fact: "stated thing" },
    });
    await client.callTool({
      name: "remember",
      arguments: { subject: "user", fact: "deduced thing", basis: "inferred" },
    });
    await client.callTool({
      name: "remember",
      arguments: { subject: "user", fact: "checked thing", basis: "verified" },
    });
    await client.callTool({
      name: "remember",
      arguments: { subject: "user", fact: "override thing", basis: "inferred", confidence: 0.42 },
    });
    expect(mem.why(1).fact.confidence).toBe(1.0); // default = user-stated
    expect(mem.why(2).fact.confidence).toBe(0.6);
    expect(mem.why(3).fact.confidence).toBe(0.95);
    expect(mem.why(4).fact.confidence).toBe(0.42); // explicit confidence wins
  });

  it("refuses notebook-sized facts with guidance to split", async () => {
    const { mem, client } = await connected();
    const r = await client.callTool({
      name: "remember",
      arguments: { subject: "project:x", fact: "a".repeat(1600) },
    });
    expect(textOf(r)).toContain("Not stored");
    expect(textOf(r)).toContain("one assertion each");
    expect(mem.stats().totalFacts).toBe(0);
  });

  it("logs recall hit counts (zero-hit recalls are the miss signal)", async () => {
    const { client, usage, metas } = await connected();
    await client.callTool({ name: "recall", arguments: { query: "nothing stored yet" } });
    await client.callTool({
      name: "remember",
      arguments: { subject: "user", fact: "drinks oolong tea" },
    });
    await client.callTool({ name: "recall", arguments: { query: "oolong" } });

    expect(usage).toEqual(["recall", "remember", "recall"]);
    expect(metas[0]?.hits).toBe(0); // the observable memory miss
    expect(metas[2]?.hits).toBe(1);
    // meta carries counters only, never fact content
    expect(JSON.stringify(metas)).not.toContain("oolong");
  });

  it("round-trips importance and kind, and filters recall by kind", async () => {
    const { mem, client } = await connected();
    await client.callTool({
      name: "remember",
      arguments: { subject: "user", fact: "core identity fact", importance: 9, kind: "semantic" },
    });
    await client.callTool({
      name: "remember",
      arguments: { subject: "user", fact: "run pnpm build to deploy", kind: "procedural" },
    });
    expect(mem.why(1).fact.importance).toBe(9);
    expect(mem.why(2).fact.kind).toBe("procedural");
    // default importance/kind when unspecified
    expect(mem.why(2).fact.importance).toBe(5);
    expect(mem.why(1).fact.kind).toBe("semantic");

    const proc = await client.callTool({
      name: "recall",
      arguments: { subject: "user", kind: "procedural" },
    });
    expect(textOf(proc)).toContain("run pnpm build to deploy");
    expect(textOf(proc)).not.toContain("core identity fact");

    // revise inherits importance/kind unless overridden
    await client.callTool({
      name: "revise",
      arguments: { old_fact_id: 1, new_fact: "core identity fact v2" },
    });
    expect(mem.why(3).fact.importance).toBe(9);
    expect(mem.why(3).fact.kind).toBe("semantic");
  });

  it("runs hybrid recall when a query embedder is wired (vector finds what FTS misses)", async () => {
    // synthetic embedder — no model: "tea"-ish queries point at the tea vector
    const embed = async (text: string): Promise<Float32Array> =>
      Float32Array.from(/tea|beverage|drink/i.test(text) ? [1, 0, 0] : [0, 1, 0]);
    const { mem, client, metas } = await connected(embed);

    const a = mem.remember({ subject: "user", fact: "drinks oolong" }).id;
    const b = mem.remember({ subject: "user", fact: "deploys on fridays" }).id;
    mem.setEmbedding(a, [1, 0, 0], "test");
    mem.setEmbedding(b, [0, 1, 0], "test");

    // "beverage" lexically matches neither fact; the vector leg still finds "oolong"
    const r = await client.callTool({ name: "recall", arguments: { query: "beverage" } });
    expect(textOf(r)).toContain("drinks oolong");
    expect(metas.at(-1)?.hybrid).toBe(true);
  });

  it("forget with no arguments asks for one", async () => {
    const { client } = await connected();
    const r = await client.callTool({ name: "forget", arguments: {} });
    expect(textOf(r)).toBe("Provide fact_id or source_ref.");
  });

  it("round-trips source_commit/source_path and surfaces pin= in recall", async () => {
    const { mem, client } = await connected();
    await client.callTool({
      name: "remember",
      arguments: {
        subject: "project:memharness",
        fact: "INSERT_FACT now writes source_commit",
        source_commit: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
        source_path: "packages/core/src/sql.ts",
      },
    });
    expect(mem.why(1).fact.sourceCommit).toBe("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0");
    expect(mem.why(1).fact.sourcePath).toBe("packages/core/src/sql.ts");

    const r = await client.callTool({ name: "recall", arguments: { query: "INSERT_FACT" } });
    expect(textOf(r)).toContain("pin=packages/core/src/sql.ts@a1b2c3d");
  });

  it("nudges on a code-map-smelling fact but not on a normal decision/prose fact", async () => {
    const { client } = await connected();
    // Reads like a structural map an Explore agent could rebuild: long + many paths.
    const codeMap = await client.callTool({
      name: "remember",
      arguments: {
        subject: "project:memharness",
        fact:
          "Recall flows through packages/mcp/src/server.ts into packages/core/src/memory.ts " +
          "recall(), which calls recallQuery in packages/core/src/sql.ts and formats via " +
          "packages/mcp/src/format.ts fmtFact.",
      },
    });
    expect(textOf(codeMap)).toContain("reads like a code map");

    // A pinned code fact should NOT get the nudge (the agent already pinned it).
    const pinned = await client.callTool({
      name: "remember",
      arguments: {
        subject: "project:memharness",
        fact:
          "Recall flows through packages/mcp/src/server.ts into packages/core/src/memory.ts " +
          "recall(), which calls recallQuery in packages/core/src/sql.ts and formats via " +
          "packages/mcp/src/format.ts fmtFact.",
        source_commit: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      },
    });
    expect(textOf(pinned)).not.toContain("reads like a code map");

    // A normal long decision/prose fact must NOT trip the heuristic (low false positives).
    const decision = await client.callTool({
      name: "remember",
      arguments: {
        subject: "project:memharness",
        fact:
          "We chose a three-state freshness enum over a boolean because the git ancestry check " +
          "has three genuinely distinct outcomes and conflating diverged with unknown loses the " +
          "one distinction an operator most needs when deciding whether to trust a pinned fact.",
      },
    });
    expect(textOf(decision)).not.toContain("reads like a code map");
  });
});
