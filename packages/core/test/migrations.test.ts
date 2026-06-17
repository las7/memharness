import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDefaultDbPath } from "../src/db.js";
import { Memharness } from "../src/memory.js";

const tmpDirs: string[] = [];
function tempPath(...segments: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "memharness-test-"));
  tmpDirs.push(dir);
  return join(dir, ...segments);
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("open + migrations", () => {
  it("creates the schema on a fresh db and reports schemaVersion >= 1", () => {
    const mem = Memharness.open({ dbPath: ":memory:" });
    expect(mem.stats().schemaVersion).toBeGreaterThanOrEqual(1);
    mem.close();
  });

  it("reopening an existing db file is a no-op (data survives, no DDL errors)", () => {
    const dbPath = tempPath("memory.db");
    const first = Memharness.open({ dbPath });
    const id = first.remember({ subject: "user", fact: "persistent" }).id;
    first.close();

    const second = Memharness.open({ dbPath });
    expect(second.why(id).fact.fact).toBe("persistent");
    expect(second.stats().totalFacts).toBe(1);
    second.close();
  });

  it("refuses to open a db created by a newer memharness", async () => {
    const dbPath = tempPath("memory.db");
    const mem = Memharness.open({ dbPath });
    mem.close();
    const { default: Database } = await import("better-sqlite3");
    const raw = new Database(dbPath);
    raw.pragma("user_version = 9999");
    raw.close();

    expect(() => Memharness.open({ dbPath })).toThrow(/newer/i);
  });

  it("upgrades a v1 db in place: existing facts get the stemmed FTS index", async () => {
    const dbPath = tempPath("memory.db");
    const { default: Database } = await import("better-sqlite3");
    const { m001 } = await import("../src/migrations/m001_initial.js");
    const raw = new Database(dbPath);
    m001(raw);
    raw.pragma("user_version = 1");
    raw
      .prepare(
        "INSERT INTO facts (subject, predicate, fact, confidence, valid_from, tx_at, source_agent, source_ref) " +
          "VALUES ('user', '', 'works at Outerport', 1.0, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', '', '')",
      )
      .run();
    raw.close();

    const mem = Memharness.open({ dbPath });
    expect(mem.stats().schemaVersion).toBe(5);
    // 'work' only matches 'works' through the porter tokenizer added in m002
    const result = mem.recall({ query: "work" });
    expect(result.facts.map((f) => f.fact)).toEqual(["works at Outerport"]);
    expect(result.usedFallback).toBe(false);
    expect(() => mem.checkIntegrity()).not.toThrow();
    mem.close();
  });

  it("m003 applies neutral ranking defaults to pre-existing rows (no drift)", async () => {
    const dbPath = tempPath("memory.db");
    const { default: Database } = await import("better-sqlite3");
    const { m001 } = await import("../src/migrations/m001_initial.js");
    const { m002 } = await import("../src/migrations/m002_porter_fts.js");
    const raw = new Database(dbPath);
    m001(raw);
    m002(raw);
    raw.pragma("user_version = 2");
    raw
      .prepare(
        "INSERT INTO facts (subject, predicate, fact, confidence, valid_from, tx_at, source_agent, source_ref) " +
          "VALUES ('user', '', 'pre-existing', 1.0, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', '', '')",
      )
      .run();
    raw.close();

    const mem = Memharness.open({ dbPath });
    expect(mem.stats().schemaVersion).toBe(5);
    mem.close();

    const check = new Database(dbPath);
    const row = check.prepare("SELECT importance, kind, last_accessed_at FROM facts").get();
    check.close();
    // importance 5 = neutral pivot, kind 'semantic' = today's half-life, NULL access = age from tx_at
    expect(row).toEqual({ importance: 5, kind: "semantic", last_accessed_at: null });
  });

  it("m005 leaves source/staleness columns NULL on pre-existing rows (no drift)", async () => {
    const dbPath = tempPath("memory.db");
    const { default: Database } = await import("better-sqlite3");
    const { m001 } = await import("../src/migrations/m001_initial.js");
    const { m002 } = await import("../src/migrations/m002_porter_fts.js");
    const { m003 } = await import("../src/migrations/m003_ranking_dimensions.js");
    const { m004 } = await import("../src/migrations/m004_vec.js");
    const raw = new Database(dbPath);
    m001(raw);
    m002(raw);
    m003(raw);
    m004(raw);
    raw.pragma("user_version = 4");
    raw
      .prepare(
        "INSERT INTO facts (subject, predicate, fact, confidence, valid_from, tx_at, source_agent, source_ref) " +
          "VALUES ('user', '', 'pre-existing', 1.0, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', '', '')",
      )
      .run();
    raw.close();

    const mem = Memharness.open({ dbPath });
    expect(mem.stats().schemaVersion).toBe(5);
    mem.close();

    const check = new Database(dbPath);
    const row = check
      .prepare("SELECT source_commit, source_path, freshness, checked_at, checked_head FROM facts")
      .get();
    check.close();
    // The source axis is unpopulated on every pre-m005 row: zero ranking/recall drift.
    expect(row).toEqual({
      source_commit: null,
      source_path: null,
      freshness: null,
      checked_at: null,
      checked_head: null,
    });
  });

  it("creates missing parent directories for the db path", () => {
    const dbPath = tempPath("nested", "deeper", "memory.db");
    const mem = Memharness.open({ dbPath });
    mem.remember({ subject: "u", fact: "x" });
    mem.close();
    expect(existsSync(dbPath)).toBe(true);
  });
});

describe("resolveDefaultDbPath", () => {
  it("defaults to ~/.memharness/memory.db", () => {
    const p = resolveDefaultDbPath("darwin", {});
    expect(p.endsWith(join(".memharness", "memory.db"))).toBe(true);
  });

  it("honors XDG_DATA_HOME on linux", () => {
    const p = resolveDefaultDbPath("linux", { XDG_DATA_HOME: "/srv/data" });
    expect(p).toBe(join("/srv/data", "memharness", "memory.db"));
  });

  it("ignores XDG_DATA_HOME on darwin", () => {
    const p = resolveDefaultDbPath("darwin", { XDG_DATA_HOME: "/srv/data" });
    expect(p.endsWith(join(".memharness", "memory.db"))).toBe(true);
  });
});
