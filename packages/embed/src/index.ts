import { type FeatureExtractionPipeline, pipeline } from "@huggingface/transformers";

/**
 * Local embedding model for hybrid recall. BGE-small: 384-dim, ~130MB, downloaded
 * once from the HF hub then fully offline (cached under ~/.cache/huggingface).
 * Deliberately a separate package: @memharness/core must stay model-free so its
 * write path never touches a model or the network (invariant I5).
 */
export const EMBED_MODEL = "Xenova/bge-small-en-v1.5";
export const EMBED_DIM = 384;

/** BGE wants this instruction prepended to *queries* (not to stored documents). */
const QUERY_INSTRUCTION = "Represent this sentence for searching relevant passages: ";

let extractorPromise: Promise<FeatureExtractionPipeline> | undefined;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  extractorPromise ??= pipeline("feature-extraction", EMBED_MODEL);
  return extractorPromise;
}

async function run(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const extractor = await getExtractor();
  const out = await extractor(texts, { pooling: "mean", normalize: true });
  const dim = out.dims[1] ?? EMBED_DIM;
  const data = out.data as Float32Array;
  return texts.map((_, i) => Float32Array.from(data.slice(i * dim, (i + 1) * dim)));
}

/** Embed stored facts (documents). Returns one unit vector per input. */
export function embedDocuments(texts: string[]): Promise<Float32Array[]> {
  return run(texts);
}

/** Embed a recall query, with the BGE query instruction prepended. */
export async function embedQuery(text: string): Promise<Float32Array> {
  const [vec] = await run([QUERY_INSTRUCTION + text]);
  if (vec === undefined) throw new Error("embedQuery produced no vector");
  return vec;
}
