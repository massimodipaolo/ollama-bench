import 'server-only';
import { rerank } from 'ai';
import type { TestDefinition, TestOption } from '../types';
import type { CheckResult } from '@/db/schema';
import { cohereReranker, cohereSlot } from '@/lib/providers';
import { listOllamaModels } from '@/lib/ollama';
import { buildIndex, embedTexts, prefixesFor, type VectorIndex } from '@/lib/rag/embed';
import { vectorSearch } from '@/lib/rag/retrieval';
import { CHUNKER_VERSION, loadCorpus, type Chunk } from '@/lib/rag/corpus';
import { runStream, toCaseOutput } from '../generate';
import { runCheck, type CheckSpec } from '../checks';
import { loadQueries, relevantFor, type QueryCase } from '../retrieval-common';

const FIRST_STAGE = 20;
const CONTEXT_K = 5;
const EMBED_CTX = 2048;

interface RagData {
  embedder: string;
  reranker: string;
  retrievalMs: number;
  passages: { n: number; id: string; doc: string; headingPath: string; relevant: boolean }[];
  contextHasRelevant: boolean;
  cited: number[];
}

const system = (langName: string) =>
  `You answer questions about tax documentation using ONLY the numbered passages provided.
- Cite the passages you use with their numbers in square brackets, e.g. [2].
- If the passages do not contain the answer, say clearly that the information is not in the provided documents; do not guess or use outside knowledge.
- Be concise and exact (keep numbers, dates and codes as written). Answer in ${langName}.`;

function buildPrompt(question: string, passages: Chunk[]) {
  return `Passages:\n\n${passages.map((c, i) => `[${i + 1}] ${c.text}`).join('\n\n')}\n\nQuestion: ${question}`;
}

async function ragOptions(): Promise<TestOption[]> {
  const embedders = (await listOllamaModels().catch(() => [])).filter((m) => m.capabilities.includes('embedding')).map((m) => m.name);
  const preferred = embedders.find((n) => n.startsWith('bge-m3')) ?? embedders[0] ?? 'bge-m3:latest';
  const cohere = cohereReranker();
  return [
    {
      id: 'embedder',
      label: 'Embedder (retrieval)',
      description: 'Same retrieval for every generator, so only the answers are compared.',
      choices: embedders.map((n) => ({ value: n, label: n })),
      default: preferred,
    },
    {
      id: 'reranker',
      label: 'Reranker',
      description: `First stage: top ${FIRST_STAGE} by embedding; the generator gets the top ${CONTEXT_K}.`,
      choices: [{ value: 'none', label: 'None' }, ...(cohere ? [{ value: 'cohere', label: `Cohere ${cohere.modelId}` }] : [])],
      default: cohere ? 'cohere' : 'none',
    },
  ];
}

export const rag: TestDefinition<QueryCase> = {
  id: 'rag',
  name: 'RAG',
  description:
    'Retrieval (Ollama embedder, optional Cohere rerank) + answer generation with citations by the model under test, including a question the corpus cannot answer.',
  version: `1-${CHUNKER_VERSION}`,
  requires: ['completion'],
  casesFrom: 'corpus',
  numCtx: 8192,
  options: ragOptions,
  rubric: {
    version: 'rag-1',
    instructions:
      'The candidate answered a question using only the numbered passages it was given. Judge the answer against the passages and the reference answer: correctness, faithfulness (every claim supported by a passage, nothing from outside knowledge), correct citations, and honesty (if the passages do not contain the answer, it must say so instead of guessing).',
    criteria: [
      { name: 'Correctness', description: 'The answer matches the reference answer and fully addresses the question.' },
      { name: 'Faithfulness', description: 'Every claim is supported by the provided passages; no invented facts.' },
      {
        name: 'Citations',
        description: 'Cites the passages that actually support the claims (N/A when the answer is not in the passages).',
      },
      { name: 'Clarity & language', description: 'Concise, exact, in the required language.' },
    ],
  },
  loadCases: (lang) => loadQueries(lang),

  helperModels: (config) => [{ name: String(config.extra?.embedder ?? 'bge-m3:latest'), embedding: true }],

  async prepare(ctx) {
    const embedder = String(ctx.config.extra?.embedder ?? 'bge-m3:latest');
    const index = await buildIndex({ model: embedder, numCtx: EMBED_CTX, prefixes: 'recommended', useCache: true, signal: ctx.signal });
    return { shared: index, stats: { embedder, reranker: String(ctx.config.extra?.reranker ?? 'none'), chunks: index.entries.length } };
  },

  async run(ctx, q) {
    const index = ctx.shared as VectorIndex;
    const embedder = String(ctx.config.extra?.embedder ?? 'bge-m3:latest');
    const reranker = String(ctx.config.extra?.reranker ?? 'none');
    const rel = relevantFor(q);

    // retrieval: identical for every generator
    if (reranker === 'cohere') await cohereSlot(); // rate limit wait, not measured
    const t0 = performance.now();
    const [qv] = await embedTexts(embedder, EMBED_CTX, [prefixesFor(embedder, 'recommended').query(q.query)], ctx.signal);
    let passages = vectorSearch(qv, index.entries, FIRST_STAGE).map((h) => h.chunk);
    if (reranker === 'cohere') {
      const c = cohereReranker();
      if (!c) throw new Error('Cohere reranker not configured');
      const { ranking } = await rerank({
        model: c.model,
        query: q.query,
        documents: passages.map((p) => p.text),
        topN: CONTEXT_K,
        abortSignal: ctx.signal,
      });
      passages = ranking.map((r) => passages[r.originalIndex]);
    }
    passages = passages.slice(0, CONTEXT_K);
    const retrievalMs = performance.now() - t0;

    const r = await runStream(ctx, { system: system(ctx.lang.englishName), prompt: buildPrompt(q.query, passages), maxOutputTokens: 1024 });
    const cited = [...new Set([...r.output.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))].filter((n) => n >= 1 && n <= passages.length);
    const data: RagData = {
      embedder,
      reranker,
      retrievalMs,
      passages: passages.map((p, i) => ({ n: i + 1, id: p.id, doc: p.doc, headingPath: p.headingPath, relevant: rel.has(p.id) })),
      contextHasRelevant: passages.some((p) => rel.has(p.id)),
      cited,
    };
    return { ...toCaseOutput(r), data };
  },

  check(q, out, lang) {
    const d = out.data as RagData;
    const checks: CheckResult[] = ((q.answerChecks ?? []) as CheckSpec[]).map((s) => runCheck(s, out.output, lang));
    if (!q.unanswerable) {
      checks.push({
        name: 'cites passages',
        pass: d.cited.length > 0,
        detail: d.cited.length ? `cites ${d.cited.map((n) => `[${n}]`).join(' ')}` : 'no [n] citations',
      });
      // only gradable when retrieval put a relevant passage in the context (otherwise it is not the generator's fault)
      if (d.contextHasRelevant) {
        const ok = d.cited.some((n) => d.passages[n - 1]?.relevant);
        checks.push({ name: 'cites a relevant passage', pass: ok });
      }
    }
    return checks;
  },

  judgeMaterial: (q, out) => {
    const d = out.data as RagData;
    return {
      task: 'Answer the question using only the numbered passages, with citations; say so if the passages do not contain the answer.',
      input: `Question: ${q.query}\n\nPassages given to the candidate (in order):\n${d.passages.map((p) => `[${p.n}] ${p.headingPath} (${p.id})`).join('\n')}\n\n(full passage text below)\n\n${passageTexts(d)}`,
      reference: q.unanswerable
        ? q.answer
        : `${q.answer}${d.contextHasRelevant ? '' : '\nNote: retrieval did not put the passage containing this answer in the context; the ideal response then says the information is not in the passages.'}`,
      response: out.output,
    };
  },
};

/** Passage texts re-read from the corpus (case data only stores chunk ids). */
function passageTexts(d: RagData): string {
  const byId = new Map(loadCorpus().chunks.map((c) => [c.id, c]));
  return d.passages.map((p) => `[${p.n}] ${byId.get(p.id)?.text ?? ''}`).join('\n\n');
}
