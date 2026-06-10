import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/errors.js";
import { openTestDb } from "./helpers.js";

describe("remember", () => {
  it("returns sequential ids starting at 1", () => {
    const { mem } = openTestDb();
    expect(mem.remember({ subject: "user", fact: "a" }).id).toBe(1);
    expect(mem.remember({ subject: "user", fact: "b" }).id).toBe(2);
    expect(mem.remember({ subject: "user", fact: "c" }).id).toBe(3);
  });

  it("trims whitespace from subject, predicate, and fact", () => {
    const { mem } = openTestDb();
    const id = mem.remember({
      subject: "  user ",
      predicate: " prefers\t",
      fact: "  dark mode\n",
    }).id;
    const f = mem.why(id).fact;
    expect(f.subject).toBe("user");
    expect(f.predicate).toBe("prefers");
    expect(f.fact).toBe("dark mode");
  });

  it("applies defaults: predicate '', confidence 1.0, sourceRef '', sourceAgent '', validFrom = txAt", () => {
    const { mem } = openTestDb();
    const { id, txAt } = mem.remember({ subject: "user", fact: "a" });
    const f = mem.why(id).fact;
    expect(f.predicate).toBe("");
    expect(f.confidence).toBe(1.0);
    expect(f.sourceRef).toBe("");
    expect(f.sourceAgent).toBe("");
    expect(f.validFrom).toBe(txAt);
    expect(f.validTo).toBeNull();
    expect(f.supersededBy).toBeNull();
    expect(f.retractedAt).toBeNull();
  });

  it("stores an explicit past validFrom while txAt stays now (bi-temporal split)", () => {
    const { mem } = openTestDb("2026-06-01T00:00:00.000Z");
    const { id, txAt } = mem.remember({
      subject: "user",
      fact: "moved to Tokyo",
      validFrom: "2026-05-01T00:00:00.000Z",
    });
    const f = mem.why(id).fact;
    expect(f.validFrom).toBe("2026-05-01T00:00:00.000Z");
    expect(f.txAt).toBe(txAt);
    expect(txAt >= "2026-06-01T00:00:00.000Z").toBe(true);
  });

  it("rejects confidence outside [0,1]", () => {
    const { mem } = openTestDb();
    expect(() => mem.remember({ subject: "u", fact: "f", confidence: 1.5 })).toThrow(
      ValidationError,
    );
    expect(() => mem.remember({ subject: "u", fact: "f", confidence: -0.1 })).toThrow(
      ValidationError,
    );
  });

  it("rejects empty subject or fact", () => {
    const { mem } = openTestDb();
    expect(() => mem.remember({ subject: "", fact: "f" })).toThrow(ValidationError);
    expect(() => mem.remember({ subject: "   ", fact: "f" })).toThrow(ValidationError);
    expect(() => mem.remember({ subject: "u", fact: "" })).toThrow(ValidationError);
  });

  it("normalizes non-canonical ISO validFrom to canonical Z-millis form", () => {
    const { mem } = openTestDb();
    const a = mem.remember({ subject: "u", fact: "a", validFrom: "2026-06-01" }).id;
    const b = mem.remember({
      subject: "u",
      fact: "b",
      validFrom: "2026-06-01T12:00:00+00:00",
    }).id;
    expect(mem.why(a).fact.validFrom).toBe("2026-06-01T00:00:00.000Z");
    expect(mem.why(b).fact.validFrom).toBe("2026-06-01T12:00:00.000Z");
  });

  it("rejects garbage validFrom", () => {
    const { mem } = openTestDb();
    expect(() => mem.remember({ subject: "u", fact: "f", validFrom: "yesterday" })).toThrow(
      ValidationError,
    );
  });

  it("issues strictly increasing txAt even when ops share a millisecond", () => {
    const { mem } = openTestDb("2026-01-01T00:00:00.000Z", 0); // frozen clock
    const a = mem.remember({ subject: "u", fact: "a" }).txAt;
    const b = mem.remember({ subject: "u", fact: "b" }).txAt;
    const c = mem.remember({ subject: "u", fact: "c" }).txAt;
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
  });
});
