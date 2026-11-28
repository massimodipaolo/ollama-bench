/**
 * Retrieval: corpus chunking, fixture integrity, ranking metrics, BM25, embedding prefixes, and the embeddings test end
 * to end against a fake Ollama serving an "oracle" embedder (perfect ranking by construction) and a broken one.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getLanguage } from '@/config/languages';
import { chunkMarkdown, loadCorpus, relevantIds } from '@/lib/rag/corpus';
import { Bm25, rankMetrics } from '@/lib/rag/retrieval';
import { startFakeOllama } from '../../helpers/fake-ollama';
import { runContext, testConfig } from '../../helpers/context';

const ollama = await startFakeOllama();
process.env.OLLAMA_HOST = ollama.url;
const { prefixesFor } = await import('@/lib/rag/embed');
const { embeddings } = await import('@/lib/tests/embeddings');
const { loadQueries } = await import('@/lib/tests/retrieval-common');

afterAll(() => ollama.close());
beforeEach(() => ollama.reset());

const { chunks } = loadCorpus();

describe('chunkMarkdown', () => {
  it('breadcrumbs each chunk with its heading path, and prefixes the text with it', () => {
    const md = '# Guide\n\nIntro.\n\n## Filing\n\n### Deadlines\n\nFile by April 15.\n\n## Refunds\n\nWithin 21 days.';
    const cs = chunkMarkdown('guide', md);
    expect(cs.map((c) => [c.id, c.headingPath, c.body])).toEqual([
      ['guide#0', 'Guide', 'Intro.'],
      ['guide#1', 'Guide › Filing › Deadlines', 'File by April 15.'],
      ['guide#2', 'Guide › Refunds', 'Within 21 days.'],
    ]);
    expect(cs[1].text).toBe('Guide › Filing › Deadlines\n\nFile by April 15.');
  });

  it('splits long tables into groups of rows, repeating the header in each', () => {
    const rows = Array.from({ length: 30 }, (_, i) => `| r${i} | ${i} |`);
    const cs = chunkMarkdown('t', ['# T', '', '| name | n |', '|---|---|', ...rows].join('\n'));
    expect(cs.length).toBeGreaterThan(1);
    for (const c of cs) expect(c.body.startsWith('| name | n |')).toBe(true);
    expect(cs.flatMap((c) => c.body.split('\n').filter((l) => /^\| r\d+/.test(l)))).toHaveLength(30); // no row lost or doubled
  });
});

describe('corpus and query fixtures', () => {
  it('chunk ids are unique', () => {
    expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);
  });

  it.each(['en', 'it'])('every answerable %s query points at chunks that exist (labels survive chunker changes)', (lang) => {
    for (const q of loadQueries(lang).filter((x) => !x.unanswerable)) {
      expect(relevantIds(q, chunks).size, `query ${q.id}`).toBeGreaterThan(0);
    }
  });
});

describe('rankMetrics', () => {
  const rel = new Set(['b', 'd']);
  it('hit@1, hit@5, MRR and nDCG over the first k', () => {
    expect(rankMetrics(['b', 'd', 'x'], rel)).toEqual({ firstRank: 1, hitAt1: 1, hitAt5: 1, mrr: 1, ndcg: 1 });
    const m = rankMetrics(['x', 'y', 'b'], rel);
    expect(m).toMatchObject({ firstRank: 3, hitAt1: 0, hitAt5: 1 });
    expect(m.mrr).toBeCloseTo(1 / 3);
    expect(m.ndcg).toBeCloseTo(0.5 / (1 + 1 / Math.log2(3)));
    expect(rankMetrics(['x', 'y'], rel)).toMatchObject({ firstRank: null, mrr: 0, ndcg: 0 });
    expect(rankMetrics(['x', 'b'], rel, 1).firstRank).toBeNull(); // beyond k
  });
});

describe('BM25 and prefixes', () => {
  it('BM25 ranks the chunk that holds the rare query terms first', () => {
    const target = chunks[Math.floor(chunks.length / 2)];
    const rare = target.body
      .match(/[A-Za-z]{9,}/g)!
      .slice(0, 3)
      .join(' ');
    expect(new Bm25(chunks).search(rare, 5).map((r) => r.chunk.id)).toContain(target.id);
  });

  it('applies each model family recommended query/document prompts, raw text otherwise', () => {
    const c = chunks[0];
    expect(prefixesFor('nomic-embed-text:latest', 'recommended').query('q')).toBe('search_query: q');
    expect(prefixesFor('nomic-embed-text:latest', 'recommended').doc(c)).toBe(`search_document: ${c.text}`);
    expect(prefixesFor('embeddinggemma:300m', 'recommended').doc(c)).toBe(`title: ${c.headingPath} | text: ${c.body}`);
    expect(prefixesFor('nomic-embed-text', 'none').query('q')).toBe('q');
    expect(prefixesFor('bge-m3:latest', 'recommended').doc(c)).toBe(c.text);
  });
});

describe('the embeddings test, end to end', () => {
  const queries = embeddings.loadCases('en');
  const index = new Map(chunks.map((c, i) => [c.text, i]));
  const unit = (dims: number, hot: number[]) => Array.from({ length: dims }, (_, i) => (hot.includes(i) ? 1 : 0));
  /** perfect retrieval by construction: each chunk its own axis, each query the sum of its relevant chunks' axes */
  const oracle = (body: Record<string, unknown> | undefined) => {
    const inputs = ([] as string[]).concat(body?.input as string[]);
    return {
      model: 'oracle',
      embeddings: inputs.map((t) => {
        if (index.has(t)) return unit(chunks.length + 1, [index.get(t)!]);
        const q = queries.find((x) => x.query === t);
        if (!q) return unit(chunks.length + 1, [chunks.length]); // unknown text: its own axis
        return unit(
          chunks.length + 1,
          [...relevantIds(q, chunks)].map((id) => chunks.findIndex((c) => c.id === id)),
        );
      }),
    };
  };

  it('a perfect embedder: the index covers every chunk, and every check passes', async () => {
    ollama.routes['/api/embed'] = oracle;
    const { ctx } = runContext({ modelName: 'bge-m3:latest', config: { ...testConfig, extra: { prefixes: 'recommended' } } });
    const prep = await embeddings.prepare!({ ...ctx, onDelta: () => {} });
    expect(prep.stats).toMatchObject({ chunks: chunks.length, dimensions: chunks.length + 1 });
    for (const q of queries.filter((x) => x.quick)) {
      const out = await embeddings.run({ ...ctx, shared: prep.shared }, q);
      expect(
        embeddings.check(q, out, getLanguage('en')).filter((c) => !c.pass),
        `query ${q.id}`,
      ).toEqual([]);
    }
  });

  it('a broken embedder (the same vector for everything) fails the ranking checks', async () => {
    ollama.routes['/api/embed'] = (body) => ({
      model: 'flat',
      embeddings: ([] as string[]).concat(body?.input as string[]).map(() => [1, 0, 0]),
    });
    const { ctx } = runContext({ modelName: 'flat:1b' });
    const prep = await embeddings.prepare!({ ...ctx, onDelta: () => {} });
    const q = queries.find((x) => x.quick)!;
    const checks = embeddings.check(q, await embeddings.run({ ...ctx, shared: prep.shared }, q), getLanguage('en'));
    expect(checks.some((c) => !c.pass)).toBe(true);
  });

  it('sends the model-family prefixes to Ollama with the session num_ctx', async () => {
    ollama.routes['/api/embed'] = (body) => ({
      model: 'x',
      embeddings: ([] as string[]).concat(body?.input as string[]).map(() => [1, 0]),
    });
    const { ctx } = runContext({ modelName: 'nomic-embed-text:latest', config: { ...testConfig, numCtx: 2048 } });
    const prep = await embeddings.prepare!({ ...ctx, onDelta: () => {} });
    const q = queries[0];
    await embeddings.run({ ...ctx, shared: prep.shared }, q);
    const calls = ollama.calls('/api/embed');
    // one text per request (the provider embeds values one at a time): input may be a string or a list
    const first = (c: (typeof calls)[number]) => ([] as string[]).concat(c.body?.input as string[])[0];
    expect(first(calls[0])).toMatch(/^search_document: /);
    expect(first(calls.at(-1)!)).toBe(`search_query: ${q.query}`);
    expect(calls.at(-1)?.body).toMatchObject({ model: 'nomic-embed-text:latest', options: { num_ctx: 2048 } });
  });
});
