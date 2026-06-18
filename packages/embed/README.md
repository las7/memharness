# @memharness/embed

Optional local embedding model for [memharness](https://github.com/las7/memharness)
hybrid (semantic) recall. Wraps BGE-small (`Xenova/bge-small-en-v1.5`, 384-dim,
~130MB) via [transformers.js](https://github.com/huggingface/transformers.js).
The model is downloaded once from the HuggingFace hub, then runs fully offline:
no API key, no per-query network.

This is a **separate, optional package** so that
[`@memharness/core`](https://www.npmjs.com/package/@memharness/core) stays
model-free and the default server install stays small. The
[`@memharness/mcp`](https://www.npmjs.com/package/@memharness/mcp) server uses it
only when `MEMHARNESS_HYBRID=1` and this package is installed.

## Use

```ts
import { embedDocuments, embedQuery, EMBED_MODEL, EMBED_DIM } from "@memharness/embed";

const [doc] = await embedDocuments(["user: drinks oolong tea"]); // store with setEmbedding
const q = await embedQuery("favorite beverage");                 // pass to recall({ queryVector })
```

`embedQuery` prepends the BGE retrieval instruction; `embedDocuments` does not.
Pass `setEmbedProgress(fn)` before first use to surface model-download progress.

## License

Apache-2.0
