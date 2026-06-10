import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/errors.js";
import { isCanonicalIso, normalizeIso } from "../src/time.js";

describe("normalizeIso", () => {
  it("passes canonical form through unchanged", () => {
    expect(normalizeIso("2026-06-09T12:34:56.789Z")).toBe("2026-06-09T12:34:56.789Z");
  });

  it("expands date-only input to midnight UTC", () => {
    expect(normalizeIso("2026-06-09")).toBe("2026-06-09T00:00:00.000Z");
  });

  it("normalizes +00:00 offsets and missing milliseconds", () => {
    expect(normalizeIso("2026-06-09T12:00:00+00:00")).toBe("2026-06-09T12:00:00.000Z");
    expect(normalizeIso("2026-06-09T12:00:00Z")).toBe("2026-06-09T12:00:00.000Z");
  });

  it("converts non-UTC offsets to UTC", () => {
    expect(normalizeIso("2026-06-09T21:00:00+09:00")).toBe("2026-06-09T12:00:00.000Z");
  });

  it("normalizes python-style microsecond precision", () => {
    expect(normalizeIso("2026-06-09T12:00:00.123456+00:00")).toBe("2026-06-09T12:00:00.123Z");
  });

  it("rejects garbage with ValidationError", () => {
    for (const bad of ["yesterday", "", "   ", "2026-13-45", "12:00:00", "06/09/2026"]) {
      expect(() => normalizeIso(bad), bad).toThrow(ValidationError);
    }
  });

  it("guarantees lexicographic order == chronological order after normalization", () => {
    const inputs = [
      "2026-06-09T12:00:00+09:00", // 03:00 UTC
      "2026-06-09",
      "2026-06-09T12:00:00.500Z",
      "2026-06-09T12:00:00+00:00",
    ];
    const normalized = inputs.map((i) => normalizeIso(i));
    const byString = [...normalized].sort();
    const byTime = [...normalized].sort((a, b) => Date.parse(a) - Date.parse(b));
    expect(byString).toEqual(byTime);
  });
});

describe("isCanonicalIso", () => {
  it("accepts only the canonical fixed-width form", () => {
    expect(isCanonicalIso("2026-06-09T12:34:56.789Z")).toBe(true);
    expect(isCanonicalIso("2026-06-09T12:34:56Z")).toBe(false);
    expect(isCanonicalIso("2026-06-09")).toBe(false);
    expect(isCanonicalIso("2026-06-09T12:34:56.789+00:00")).toBe(false);
  });
});
