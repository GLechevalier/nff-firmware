// Client-side query embedding for hybrid brain search — runs entirely in the
// browser (WASM via @huggingface/transformers), no server round trip and no
// new server-side ML dependency. Mirrors nff-brain's core/embed.ts exactly
// (same model, same q8 dtype, same mean+normalize pooling, same BGE retrieval
// prefix) so query vectors land in the same space as the node embeddings the
// admin worker writes with that file (see 0071_brain_semantic.sql).
//
// FAIL-SOFT: any failure (offline, WASM blocked, model load error) resolves to
// null. Callers treat null exactly like "no semantic tier" — same contract
// core/embed.ts already established for the CLI/VS Code path.

const MODEL = 'Xenova/bge-small-en-v1.5';
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

type Extractor = (texts: string[], opts: Record<string, unknown>) => Promise<{ tolist(): number[][] }>;

let extractorPromise: Promise<Extractor | null> | null = null;

async function loadExtractor(): Promise<Extractor | null> {
  try {
    const { pipeline } = await import('@huggingface/transformers');
    return (await pipeline('feature-extraction', MODEL, { dtype: 'q8' })) as unknown as Extractor;
  } catch {
    return null;
  }
}

// Lazy singleton — the ~30MB q8 model only downloads once a search is
// actually typed, and only once per browser (transformers.js caches the
// weights via the Cache API).
function extractor(): Promise<Extractor | null> {
  if (!extractorPromise) extractorPromise = loadExtractor();
  return extractorPromise;
}

/** Embed a search query in-browser. Null on any failure. */
export async function embedQueryInBrowser(query: string): Promise<number[] | null> {
  const q = query.trim();
  if (!q) return null;
  const run = await extractor();
  if (!run) return null;
  try {
    const out = await run([QUERY_PREFIX + q], { pooling: 'mean', normalize: true });
    return out.tolist()[0] ?? null;
  } catch {
    return null;
  }
}
