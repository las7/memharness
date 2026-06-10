import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/tokens.js";

describe("estimateTokens", () => {
  it("estimates ceil(chars / 4)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});
