import 'server-only';
import { embedMany } from 'ai';
import { ollama } from '@/lib/providers';
import { loadCorpus, type Chunk } from './corpus';

export type PrefixMode = 'recommended' | 'none';

interface Prefixes {
  query: (q: string) => string;
  doc: (c: Chunk) => string;
}

/**
 * Query/document prompts recommended by each embedding model family (model cards). Models not listed embed raw text.
 * `none` disables them for every model (raw text both sides).
 */
export function prefixesFor(model: string, mode: PrefixMode): Prefixes {
  const raw: Prefixes = { query: (q) => q, doc: (c) => c.text };
  if (mode === 'none') return raw;
  const m = model.toLowerCase();
  if (m.includes('embeddinggemma'))
    return { query: (q) => `task: search result | query: ${q}`, doc: (c) => `title: ${c.headingPath} | text: ${c.body}` };
  if (m.includes('qwen3-embedding'))
    return {
      query: (q) => `Instruct: Given a question, retrieve passages of tax documentation that answer it\nQuery: ${q}`,
      doc: (c) => c.text,
    };
  if (m.includes('nomic-embed')) return { query: (q) => `search_query: ${q}`, doc: (c) => `search_document: ${c.text}` };
  if (m.includes('mxbai-embed'))
    return { query: (q) => `Represent this sentence for searching relevant passages: ${q}`, doc: (c) => c.text };
  return raw; // bge-m3 and others: no prompt
}

export function embeddingModel(name: string, numCtx: number) {
  return ollama.embedding(name, { options: { num_ctx: numCtx } });
}

export async function embedTexts(model: string, numCtx: number, values: string[], signal?: AbortSignal): Promise<number[][]> {
  const { embeddings } = await embedMany({ model: embeddingModel(model, numCtx), values, maxParallelCalls: 1, abortSignal: signal });
  return embeddings;
}

export interface VectorIndex {
  entries: { chunk: Chunk; vec: number[] }[];
  buildMs: number;
  dimensions: number;
}

const g = globalThis as unknown as { __benchIndex?: Map<string, VectorIndex> };
const cache = (g.__benchIndex ??= new Map());

/**
 * Embed every corpus chunk with `model`. With `useCache`, an index for the same (model digest, corpus, prefixes) is
 * reused across runs (RAG); the embeddings test always rebuilds it because the build time is one of its metrics.
 */
export async function buildIndex(opts: {
  model: string;
  digest?: string;
  numCtx: number;
  prefixes: PrefixMode;
  useCache: boolean;
  signal?: AbortSignal;
}): Promise<VectorIndex> {
  const { chunks, hash } = loadCorpus();
  const key = `${opts.model}|${opts.digest ?? ''}|${hash}|${opts.prefixes}|${opts.numCtx}`;
  if (opts.useCache && cache.has(key)) return cache.get(key)!;
  const p = prefixesFor(opts.model, opts.prefixes);
  const t0 = performance.now();
  const vecs = await embedTexts(
    opts.model,
    opts.numCtx,
    chunks.map((c) => p.doc(c)),
    opts.signal,
  );
  const index: VectorIndex = {
    entries: chunks.map((chunk, i) => ({ chunk, vec: vecs[i] })),
    buildMs: performance.now() - t0,
    dimensions: vecs[0]?.length ?? 0,
  };
  cache.set(key, index);
  return index;
}
