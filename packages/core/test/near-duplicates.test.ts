import { describe, expect, it } from "vitest";
import { openTestDb } from "./helpers.js";

describe("nearDuplicates (write-path dedup/contradiction gate)", () => {
  it("surfaces a near-identical existing belief in the same subject", () => {
    const { mem } = openTestDb();
    const existing = mem.remember({
      subject: "user",
      fact: "Seiji prefers no em-dashes in prose, use commas instead",
    }).id;
    const hits = mem.nearDuplicates({
      subject: "user",
      text: "Seiji prefers no em-dashes in product copy, use commas instead",
    });
    expect(hits.map((h) => h.id)).toContain(existing);
    expect(hits[0]!.similarity).toBeGreaterThan(0.5);
    mem.close();
  });

  it("does not surface unrelated facts", () => {
    const { mem } = openTestDb();
    mem.remember({ subject: "user", fact: "lives in Osaka and works remotely" });
    const hits = mem.nearDuplicates({
      subject: "user",
      text: "deploys the backend with terraform and ecs run-task",
    });
    expect(hits).toHaveLength(0);
    mem.close();
  });

  it("is scoped to the subject — a similar fact under another subject is ignored", () => {
    const { mem } = openTestDb();
    mem.remember({ subject: "project:a", fact: "the guard rejects deeply nested html input" });
    const hits = mem.nearDuplicates({
      subject: "project:b",
      text: "the guard rejects deeply nested html input",
    });
    expect(hits).toHaveLength(0);
    mem.close();
  });

  it("ignores superseded and retracted beliefs", () => {
    const { mem } = openTestDb();
    const v1 = mem.remember({ subject: "user", fact: "uses the indigo accent color theme" }).id;
    mem.revise({ oldFactId: v1, newFact: "uses the green accent color theme entirely" });
    const dropped = mem.remember({
      subject: "user",
      fact: "uses the crimson accent color theme",
    }).id;
    mem.forget({ factId: dropped });
    const hits = mem.nearDuplicates({
      subject: "user",
      text: "uses the indigo accent color theme",
    });
    // v1 is superseded, `dropped` is retracted → neither should surface.
    expect(hits.map((h) => h.id)).not.toContain(v1);
    expect(hits.map((h) => h.id)).not.toContain(dropped);
    mem.close();
  });

  it("respects the minSimilarity floor", () => {
    const { mem } = openTestDb();
    mem.remember({ subject: "user", fact: "enjoys ascii art animations on landing pages" });
    const loose = mem.nearDuplicates({
      subject: "user",
      text: "enjoys ascii art on websites",
      minSimilarity: 0.1,
    });
    const strict = mem.nearDuplicates({
      subject: "user",
      text: "enjoys ascii art on websites",
      minSimilarity: 0.95,
    });
    expect(loose.length).toBeGreaterThan(0);
    expect(strict).toHaveLength(0);
    mem.close();
  });
});
