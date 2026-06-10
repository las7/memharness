import { FakeClock, Memharness } from "@memharness/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

async function connected() {
  const mem = Memharness.open({ dbPath: ":memory:", clock: new FakeClock() });
  const usage: string[] = [];
  const server = createServer(mem, (op) => usage.push(op));
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { mem, client, usage };
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

  it("forget with no arguments asks for one", async () => {
    const { client } = await connected();
    const r = await client.callTool({ name: "forget", arguments: {} });
    expect(textOf(r)).toBe("Provide fact_id or source_ref.");
  });
});
