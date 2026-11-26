import 'server-only';
import crypto from 'node:crypto';
import { cosineSimilarity, Output, rerank } from 'ai';
import { z } from 'zod';
import type { TestDefinition } from '../types';
import { cohereReranker, cohereSlot, ollama } from '@/lib/providers';
import { embedTexts, prefixesFor } from '@/lib/rag/embed';
import { Bm25 } from '@/lib/rag/retrieval';
import { CHUNKER_VERSION, loadCorpus, type Chunk } from '@/lib/rag/corpus';
import { runStream, toCaseOutput } from '../generate';
import { yesNoRelevance } from '@/lib/rag/yesno';
import { extractJson } from '../structured-output';
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

const POOL = 20;

/**
 * Fixed candidate pool per query, identical for every reranker: BM25 top-20, with the relevant chunks guaranteed to be
 * in it, presented in a deterministic shuffled order (so no reranker inherits BM25's ranking).
 */
export function candidatePool(q: QueryCase): Chunk[] {
  const { chunks } = loadCorpus();
  const rel = relevantFor(q);
  const pool = new Bm25(chunks).search(q.query, POOL).map((r) => r.chunk);
  for (const id of rel) {
    if (pool.some((c) => c.id === id)) continue;
    pool.pop();
    pool.unshift(chunks.find((c) => c.id === id)!);
  }
  const key = (c: Chunk) => crypto.createHash('sha1').update(`${q.id}|${c.id}`).digest('hex');
  return pool.sort((a, b) => key(a).localeCompare(key(b)));
}

const LISTWISE_SYSTEM =
  'You are a search reranker. Given a question and numbered passages, order the passages from most to least useful for answering the question. The question may be in a different language from the passages. Return only JSON.';

const listwiseSchema = z.object({
  ranking: z.array(z.number().int()).describe('passage numbers, most relevant first; include at least the 10 most relevant'),
});

export const reranking: TestDefinition<QueryCase> = {
  id: 'reranking',
  name: 'Reranking',
  description:
    'Rerank a fixed, shuffled pool of 20 candidates per question. Embedding models score by cosine; chat models rerank listwise (structured output) or pointwise by yes/no log-probability; LLM rerankers (Qwen3-Reranker) by yes/no log-probability. The Cohere reranker joins every session as a blind baseline.',
  version: `3-${CHUNKER_VERSION}`,
  requires: [],
  requiresAny: ['embedding', 'completion', 'rerank-llm'],
  casesFrom: 'corpus',
  numCtx: 12288,
  options: [
    {
      id: 'embeddingImpl',
      label: 'Embedding reranker',
      description:
        "Embedding models only. sdk = ai-sdk-ollama's ollama.embeddingReranking() through rerank() (raw text); prefixes = this app's cosine reranking with each model's recommended query/document prompts.",
      choices: [
        { value: 'sdk', label: 'SDK embeddingReranking' },
        { value: 'prefixes', label: 'Cosine + prefixes' },
      ],
      default: 'sdk',
    },
    {
      id: 'llmMethod',
      label: 'Chat-model reranker',
      description:
        'Chat models only. listwise = one call returns the ordered passage numbers (structured output); yesno = one call per passage, score = P("yes") / (P("yes") + P("no")) of the first token (Ollama logprobs). LLM rerankers always use yesno.',
      choices: [
        { value: 'listwise', label: 'Listwise (structured)' },
        { value: 'yesno', label: 'Yes/no logprob' },
      ],
      default: 'listwise',
    },
  ],
  rubric: RETRIEVAL_RUBRIC,
  baselines: () => {
    const c = cohereReranker();
    return c ? [{ provider: 'cohere', name: c.modelId, capabilities: ['rerank'] }] : [];
  },
  loadCases: (lang) => loadQueries(lang).filter((q) => !q.unanswerable),

  async run(ctx, q) {
    const pool = candidatePool(q);
    const rel = relevantFor(q);
    if (ctx.provider === 'cohere') await cohereSlot(); // rate limit wait, not measured
    const t0 = performance.now();
    let order: { chunk: Chunk; score?: number }[];
    let method: string;
    let invalid = 0;
    let metrics = {};
    let raw: string | undefined;
    let degenerate = false;
    let missingYesNo = 0;

    if (ctx.provider === 'cohere') {
      method = 'cohere';
      const c = cohereReranker();
      if (!c) throw new Error('COHERE_API_KEY / COHERE_MODEL not configured');
      const { ranking } = await rerank({
        model: c.model,
        query: q.query,
        documents: pool.map((x) => x.text),
        topN: pool.length,
        abortSignal: ctx.signal,
      });
      order = ranking.map((r) => ({ chunk: pool[r.originalIndex], score: r.score }));
    } else if (ctx.capabilities.includes('embedding') && (ctx.config.extra?.embeddingImpl ?? 'sdk') === 'sdk') {
      method = 'sdk-embeddingReranking';
      const { ranking } = await rerank({
        model: ollama.embeddingReranking(ctx.modelName),
        query: q.query,
        documents: pool.map((x) => x.text),
        topN: pool.length,
        abortSignal: ctx.signal,
      });
      order = ranking.map((r) => ({ chunk: pool[r.originalIndex], score: r.score }));
    } else if (ctx.capabilities.includes('embedding')) {
      method = 'embedding+prefixes';
      const p = prefixesFor(ctx.modelName, 'recommended');
      const [qv, ...dv] = await embedTexts(
        ctx.modelName,
        Math.min(ctx.config.numCtx, 2048),
        [p.query(q.query), ...pool.map((c) => p.doc(c))],
        ctx.signal,
      );
      order = pool.map((chunk, i) => ({ chunk, score: cosineSimilarity(qv, dv[i]) })).sort((a, b) => b.score! - a.score!);
    } else if (ctx.capabilities.includes('rerank-llm') || ctx.config.extra?.llmMethod === 'yesno') {
      // pointwise: one 1-token call per passage, sequential (GPU lock); Qwen3-Reranker builds use their own format
      const rerankerFormat = ctx.capabilities.includes('rerank-llm');
      method = rerankerFormat ? 'reranker-yesno' : 'llm-yesno';
      const scored: { chunk: Chunk; score: number }[] = [];
      for (const chunk of pool) {
        const s = await yesNoRelevance({
          model: ctx.modelName,
          query: q.query,
          document: chunk.text,
          rerankerFormat,
          numCtx: Math.min(ctx.config.numCtx, 4096),
          canThink: ctx.capabilities.includes('thinking'),
          signal: ctx.signal,
        });
        if (s.missing) missingYesNo++;
        scored.push({ chunk, score: s.score });
      }
      // stable sort: ties keep the (shuffled) pool order
      order = scored.map((x, i) => ({ ...x, i })).sort((a, b) => b.score - a.score || a.i - b.i);
      const scores = scored.map((x) => x.score);
      degenerate = Math.max(...scores) - Math.min(...scores) < 1e-6;
    } else {
      method = 'llm-listwise';
      const prompt = `Question: ${q.query}\n\nPassages:\n\n${pool.map((c, i) => `[${i + 1}] ${c.text}`).join('\n\n')}\n\nReturn the passage numbers ordered from most to least relevant.`;
      const r = await runStream(ctx, {
        system: LISTWISE_SYSTEM,
        prompt,
        output: Output.object({ schema: listwiseSchema }),
        maxOutputTokens: 1024,
      });
      metrics = toCaseOutput(r);
      raw = r.output.slice(0, 2000);
      // native structured output first; lenient JSON extraction as fallback (extra prose around the JSON)
      let obj = r.object as z.infer<typeof listwiseSchema> | undefined;
      if (!obj) {
        try {
          const parsed = listwiseSchema.safeParse(extractJson(r.output));
          if (parsed.success) obj = parsed.data;
        } catch {}
      }
      const seen = new Set<number>();
      const ids = obj?.ranking ?? [];
      for (const n of ids) {
        if (!Number.isInteger(n) || n < 1 || n > pool.length || seen.has(n)) invalid++;
        else seen.add(n);
      }
      if (!obj) invalid = pool.length;
      // passages the model did not rank keep their (shuffled) pool order at the end
      order = [...seen, ...pool.map((_, i) => i + 1).filter((n) => !seen.has(n))].map((n) => ({ chunk: pool[n - 1] }));
    }

    const data: RankingData = { ranked: toRanked(order, rel), relevantIds: [...rel], method, invalid, raw, degenerate, missingYesNo };
    return { ...metrics, output: formatRanked(data.ranked, 10), latencyMs: performance.now() - t0, data };
  },

  check: (_q, out) => rankingChecks(out.data as RankingData),
  judgeMaterial: (q, out) => retrievalJudgeMaterial(q, out, 'Reranking of a candidate pool'),
};
