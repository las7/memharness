/**
 * Two embedders. The synthetic one is a deterministic hashed bag-of-words, so
 * the harness runs fully offline and in CI — but cosine then reflects only
 * LEXICAL overlap, so paraphrase probes (no shared words) won't benefit from the
 * vector leg. Use the real model (--real) to actually measure semantic recall.
 */
export interface Embedder {
  readonly dim: number;
  documents(texts: string[]): Promise<Float32Array[]>;
  query(text: string): Promise<Float32Array>;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** Deterministic hashed term-frequency vector, L2-normalized. Offline. */
export function syntheticEmbedder(dim = 256): Embedder {
  const vec = (text: string): Float32Array => {
    const v = new Float32Array(dim);
    for (const tok of tokenize(text)) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++) {
        h = Math.imul(h ^ tok.charCodeAt(i), 16777619);
      }
      const idx = (h >>> 0) % dim;
      v[idx] = (v[idx] ?? 0) + 1;
    }
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) v[i]! /= norm;
    return v;
  };
  return {
    dim,
    documents: (texts) => Promise.resolve(texts.map(vec)),
    query: (text) => Promise.resolve(vec(text)),
  };
}

/** The real local model from @memharness/embed (downloads once, then offline). */
export async function realEmbedder(): Promise<Embedder> {
  const embed = await import("@memharness/embed");
  return {
    dim: embed.EMBED_DIM,
    documents: (texts) => embed.embedDocuments(texts),
    query: (text) => embed.embedQuery(text),
  };
}
