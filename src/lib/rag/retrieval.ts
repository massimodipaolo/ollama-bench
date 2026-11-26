import { cosineSimilarity } from 'ai';
import type { Chunk } from './corpus';

const tokenize = (s: string) =>
  (
    s
      .toLowerCase()
      .normalize('NFKC')
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).filter((t) => t.length > 1);

/** Okapi BM25 over the chunk texts (k1 = 1.2, b = 0.75). Deterministic first stage for the reranking test. */
export class Bm25 {
  private docs: Map<string, number>[];
  private lens: number[];
  private avg: number;
  private df = new Map<string, number>();
  constructor(private chunks: Chunk[]) {
    this.docs = chunks.map((c) => {
      const tf = new Map<string, number>();
      for (const t of tokenize(c.text)) tf.set(t, (tf.get(t) ?? 0) + 1);
      return tf;
    });
    this.lens = this.docs.map((d) => [...d.values()].reduce((a, b) => a + b, 0));
    this.avg = this.lens.reduce((a, b) => a + b, 0) / Math.max(1, this.lens.length);
    for (const d of this.docs) for (const t of d.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
  }
  search(query: string, k: number): { chunk: Chunk; score: number }[] {
    const N = this.docs.length;
    const q = [...new Set(tokenize(query))];
    return this.docs
      .map((d, i) => {
        let s = 0;
        for (const t of q) {
          const f = d.get(t);
          if (!f) continue;
          const df = this.df.get(t)!;
          const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
          s += (idf * f * 2.2) / (f + 1.2 * (1 - 0.75 + (0.75 * this.lens[i]) / this.avg));
        }
        return { chunk: this.chunks[i], score: s };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}

/** Dense top-k by cosine similarity. */
export function vectorSearch(queryVec: number[], index: { chunk: Chunk; vec: number[] }[], k: number) {
  return index
    .map((e) => ({ chunk: e.chunk, score: cosineSimilarity(queryVec, e.vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export interface RankMetrics {
  /** 1-based rank of the first relevant result, or null */
  firstRank: number | null;
  hitAt1: number;
  hitAt5: number;
  mrr: number;
  ndcg: number;
}

/** Binary-relevance ranking metrics over the first k results. */
export function rankMetrics(rankedIds: string[], relevant: Set<string>, k = 10): RankMetrics {
  const top = rankedIds.slice(0, k);
  const idx = top.findIndex((id) => relevant.has(id));
  const firstRank = idx >= 0 ? idx + 1 : null;
  const dcg = top.reduce((s, id, i) => s + (relevant.has(id) ? 1 / Math.log2(i + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(relevant.size, k) }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
  return {
    firstRank,
    hitAt1: firstRank === 1 ? 1 : 0,
    hitAt5: firstRank !== null && firstRank <= 5 ? 1 : 0,
    mrr: firstRank ? 1 / firstRank : 0,
    ndcg: ideal ? dcg / ideal : 0,
  };
}
