import { describe, expect, it } from "vitest";
import { EMBED_DIM, EMBED_MODEL, embedDocuments } from "../src/index.js";

// Offline only: importing the module must not download or load the model (the
// model loads lazily on first embed call). The real model is exercised by the
// memharness-reembed CLI and the eval harness, not in CI.
describe("embed package", () => {
  it("exposes the model id and dimension without loading anything", () => {
    expect(EMBED_MODEL).toBe("Xenova/bge-small-en-v1.5");
    expect(EMBED_DIM).toBe(384);
  });

  it("returns an empty array for no inputs without touching the model", async () => {
    await expect(embedDocuments([])).resolves.toEqual([]);
  });
});
