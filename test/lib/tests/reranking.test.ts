/**
 * The reranking test: the candidate pool every reranker gets, and each scoring method end to end against the fake
 * Ollama (listwise structured output, yes/no log-probabilities in chat and Qwen3-Reranker formats, embeddings).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getLanguage } from '@/config/languages';
import { loadCorpus } from '@/lib/rag/corpus';
import type { RankingData } from '@/lib/tests/retrieval-common';
import { chatReply, startFakeOllama } from '../../helpers/fake-ollama';
import { runContext, testConfig } from '../../helpers/context';

const ollama = await startFakeOllama();
process.env.OLLAMA_HOST = ollama.url;
const { reranking, candidatePool } = await import('@/lib/tests/reranking');
const { relevantFor } = await import('@/lib/tests/retrieval-common');

afterAll(() => ollama.close());
beforeEach(() => ollama.reset());

const en = getLanguage('en');
const queries = reranking.loadCases('en');
const q = queries.find((x) => x.quick)!;
const pool = candidatePool(q);
const rel = relevantFor(q);
const failed = (out: { data?: unknown }) => reranking.check(q, out as never, en).filter((c) => !c.pass);
const chatCtx = (extra: Record<string, unknown> = {}, capabilities = ['completion']) =>
  runContext({ capabilities, config: { ...testConfig, extra: { llmMethod: 'listwise', embeddingImpl: 'sdk', ...extra } } }).ctx;

describe('candidate pool', () => {
  it.each(['en', 'it'])('%s: 20 candidates per query, every relevant chunk included, same order on every call', (lang) => {
    for (const query of reranking.loadCases(lang)) {
      const p = candidatePool(query);
      expect(p.length, query.id).toBe(Math.min(20, loadCorpus().chunks.length));
      const ids = new Set(p.map((c) => c.id));
      for (const id of relevantFor(query)) expect(ids.has(id), `${query.id}: relevant ${id} in the pool`).toBe(true);
      expect(candidatePool(query).map((c) => c.id)).toEqual(p.map((c) => c.id));
    }
  });
});

describe('listwise (chat model, structured output)', () => {
  const perfect = [
    ...pool.map((c, i) => ({ c, n: i + 1 })).filter((x) => rel.has(x.c.id)),
    ...pool.map((c, i) => ({ c, n: i + 1 })).filter((x) => !rel.has(x.c.id)),
  ].map((x) => x.n);

  it('a correct ranking passes every check; the passages are numbered in the prompt', async () => {
    ollama.replies.push(chatReply({ text: JSON.stringify({ ranking: perfect }) }));
    const out = await reranking.run(chatCtx(), q);
    expect((out.data as RankingData).method).toBe('llm-listwise');
    expect(failed(out)).toEqual([]);
    const prompt = (ollama.calls('/api/chat')[0].body?.messages as { content: string }[]).at(-1)!.content;
    expect(prompt).toContain(`[1] ${pool[0].text}`);
    expect(prompt).toContain(`[20] ${pool[19].text}`);
  });

  it('invalid and duplicate passage numbers are counted', async () => {
    ollama.replies.push(chatReply({ text: JSON.stringify({ ranking: [perfect[0], perfect[0], 0, 99, ...perfect.slice(1)] }) }));
    const out = await reranking.run(chatCtx(), q);
    expect((out.data as RankingData).invalid).toBe(3);
    expect(failed(out)).toEqual([expect.objectContaining({ name: 'valid ranking ids', detail: '3 invalid/duplicate ids' })]);
  });

  it('no usable JSON: every passage counts as invalid', async () => {
    ollama.replies.push(chatReply({ text: 'I think passage 3 is best.' }));
    const out = await reranking.run(chatCtx(), q);
    expect((out.data as RankingData).invalid).toBe(20);
  });
});

describe('yes/no log-probabilities', () => {
  /** /api/chat (non-streamed): "yes" likely for relevant passages, unlikely otherwise */
  const logprobs = (yes: number) => ({
    message: { role: 'assistant', content: 'yes' },
    done: true,
    logprobs: [
      {
        token: 'yes',
        logprob: Math.log(yes),
        top_logprobs: [
          { token: 'yes', logprob: Math.log(yes) },
          { token: 'No', logprob: Math.log(1 - yes) },
        ],
      },
    ],
  });
  const isRelevant = (text: string) => pool.some((c) => rel.has(c.id) && text.includes(c.text));

  it('chat format: scores P(yes) / (P(yes) + P(no)) per passage and ranks by it', async () => {
    // match on the raw message text (JSON.stringify would escape the passages' newlines)
    ollama.routes['/api/chat'] = (body) =>
      logprobs(isRelevant((body?.messages as { content: string }[]).map((m) => m.content).join('\n')) ? 0.9 : 0.1);
    const out = await reranking.run(chatCtx({ llmMethod: 'yesno' }, ['completion', 'thinking']), q);
    expect((out.data as RankingData).method).toBe('llm-yesno');
    expect(failed(out)).toEqual([]);
    const calls = ollama.calls('/api/chat');
    expect(calls).toHaveLength(20); // one 1-token call per passage
    expect(calls[0].body).toMatchObject({
      stream: false,
      think: false,
      logprobs: true,
      top_logprobs: 20,
      options: { num_predict: 1, temperature: 0 },
    });
  });

  it('the same score for every passage is flagged as degenerate', async () => {
    ollama.routes['/api/chat'] = () => logprobs(0.5);
    expect(failed(await reranking.run(chatCtx({ llmMethod: 'yesno' }), q))).toContainEqual(
      expect.objectContaining({ name: 'scores vary across passages' }),
    );
  });

  it('no "yes"/"no" among the top tokens is reported', async () => {
    ollama.routes['/api/chat'] = () => ({
      done: true,
      logprobs: [{ token: 'Maybe', logprob: -0.1, top_logprobs: [{ token: 'Maybe', logprob: -0.1 }] }],
    });
    const out = await reranking.run(chatCtx({ llmMethod: 'yesno' }), q);
    expect((out.data as RankingData).missingYesNo).toBe(20);
  });

  it('Qwen3-Reranker builds: raw /api/generate with the model card prompt', async () => {
    ollama.routes['/api/generate'] = (body) => logprobs(isRelevant(String(body?.prompt)) ? 0.95 : 0.05);
    const out = await reranking.run(chatCtx({}, ['rerank-llm']), q);
    expect((out.data as RankingData).method).toBe('reranker-yesno');
    expect(failed(out)).toEqual([]);
    const body = ollama.calls('/api/generate')[0].body!;
    expect(body).toMatchObject({ raw: true, logprobs: true });
    expect(String(body.prompt)).toMatch(/^<\|im_start\|>system\n[\s\S]*<Query>: [\s\S]*<Document>: [\s\S]*<think>\n\n<\/think>\n\n$/);
  });
});

describe('embedding models', () => {
  /** perfect by construction: relevant passages share the query's direction */
  const oracle = (body: Record<string, unknown> | undefined) => ({
    model: 'oracle',
    embeddings: ([] as string[]).concat(body?.input as string[]).map((t) => {
      if (t.includes(q.query)) return [1, 0];
      return pool.some((c) => rel.has(c.id) && t.includes(c.text)) ? [1, 0] : [0, 1];
    }),
  });

  it.each([
    ['sdk', 'sdk-embeddingReranking'],
    ['prefixes', 'embedding+prefixes'],
  ])('%s implementation: a perfect embedder passes every check', async (impl, method) => {
    ollama.routes['/api/embed'] = oracle;
    const ctx = runContext({
      modelName: 'bge-m3:latest',
      capabilities: ['embedding'],
      config: { ...testConfig, extra: { embeddingImpl: impl } },
    }).ctx;
    const out = await reranking.run(ctx, q);
    expect((out.data as RankingData).method).toBe(method);
    expect(failed(out)).toEqual([]);
  });
});
