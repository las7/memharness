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

/** Subset of the transformers.js progress event we surface to callers. */
export interface EmbedProgress {
  status: string;
  file?: string;
  progress?: number;
}

let extractorPromise: Promise<FeatureExtractionPipeline> | undefined;
let onProgress: ((p: EmbedProgress) => void) | undefined;

/**
 * Register a callback for model-load progress (download/initiate/done), so a
 * host can show feedback during the one-time ~130MB BGE download instead of a
 * silent ~20s stall. Must be set before the first embed call; ignored after the
 * model is loaded. The library itself prints nothing.
 */
export function setEmbedProgress(fn: ((p: EmbedProgress) => void) | undefined): void {
  onProgress = fn;
}

function getExtractor(): Promise<FeatureExtractionPipeline> {
  extractorPromise ??= pipeline("feature-extraction", EMBED_MODEL, {
    progress_callback: onProgress
      ? (p: EmbedProgress) => {
          onProgress?.(p);
        }
      : undefined,
  }).then((extractor) => {
    // transformers.js has no single "loaded" event; synthesize one so a host can
    // tell when the one-time download/init finished.
    onProgress?.({ status: "ready" });
    return extractor;
  });
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
