import 'server-only';
import type { TestDefinition } from '../types';
import { buildIndex, embedTexts, prefixesFor, type PrefixMode, type VectorIndex } from '@/lib/rag/embed';
import { vectorSearch } from '@/lib/rag/retrieval';
import { CHUNKER_VERSION } from '@/lib/rag/corpus';
import {
  formatRanked,
  loadQueries,
  rankingChecks,
  relevantFor,
  retrievalJudgeMaterial,
  RETRIEVAL_RUBRIC,
  toRanked,
  type QueryCase,
  type RankingData,
} from '../retrieval-common';

const TOP_K = 10;

export const embeddings: TestDefinition<QueryCase> = {
  id: 'embeddings',
  name: 'Embeddings & retrieval',
  description:
    'Chunk and embed the Markdown corpus (timed), then dense retrieval for labeled questions (en, and it over an English corpus): hit@1, hit@5, MRR, nDCG@10.',
  version: `1-${CHUNKER_VERSION}`,
  requires: ['embedding'],
  casesFrom: 'corpus',
  numCtx: 2048,
  options: [
    {
      id: 'prefixes',
      label: 'Query/document prompts',
      description: 'recommended = each model\'s documented prefixes (e.g. embeddinggemma "task: search result | query:"); none = raw text.',
      choices: [
        { value: 'recommended', label: 'Recommended' },
        { value: 'none', label: 'None' },
      ],
      default: 'recommended',
    },
  ],
  rubric: RETRIEVAL_RUBRIC,
  loadCases: (lang) => loadQueries(lang).filter((q) => !q.unanswerable),

  async prepare(ctx) {
    const index = await buildIndex({
      model: ctx.modelName,
      numCtx: ctx.config.numCtx,
      prefixes: (ctx.config.extra?.prefixes as PrefixMode) ?? 'recommended',
      useCache: false,
      signal: ctx.signal,
    });
    return {
      shared: index,
      stats: {
        chunks: index.entries.length,
        dimensions: index.dimensions,
        indexMs: Math.round(index.buildMs),
        chunksPerSec: Math.round((index.entries.length / index.buildMs) * 1000 * 10) / 10,
      },
    };
  },

  async run(ctx, q) {
    const index = ctx.shared as VectorIndex;
    const p = prefixesFor(ctx.modelName, (ctx.config.extra?.prefixes as PrefixMode) ?? 'recommended');
    const t0 = performance.now();
    const [vec] = await embedTexts(ctx.modelName, ctx.config.numCtx, [p.query(q.query)], ctx.signal);
    const hits = vectorSearch(vec, index.entries, TOP_K);
    const latencyMs = performance.now() - t0;
    const rel = relevantFor(q);
    const data: RankingData = { ranked: toRanked(hits, rel), relevantIds: [...rel] };
    return { output: formatRanked(data.ranked, TOP_K), latencyMs, data };
  },

  check: (_q, out) => rankingChecks(out.data as RankingData),
  judgeMaterial: (q, out) => retrievalJudgeMaterial(q, out, 'Dense retrieval'),
};
