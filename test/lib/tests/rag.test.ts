/**
 * The RAG test end to end against the fake Ollama: retrieval with an "oracle" embedder (the relevant chunks come first
 * by construction), the numbered passages given to the generator, and how its citations are scored.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getLanguage } from '@/config/languages';
import { loadCorpus } from '@/lib/rag/corpus';
import { chatReply, startFakeOllama } from '../../helpers/fake-ollama';
import { runContext, testConfig } from '../../helpers/context';

const ollama = await startFakeOllama();
process.env.OLLAMA_HOST = ollama.url;
const { rag } = await import('@/lib/tests/rag');
const { relevantFor } = await import('@/lib/tests/retrieval-common');

afterAll(() => ollama.close());

const en = getLanguage('en');
const cases = rag.loadCases('en');
const q = cases.find((x) => x.quick && !x.unanswerable)!;
const rel = relevantFor(q);
const relevantTexts = loadCorpus()
  .chunks.filter((c) => rel.has(c.id))
  .map((c) => c.text);

// embeds the query and its relevant chunks in one direction, everything else in another
const oracle = (body: Record<string, unknown> | undefined) => ({
  model: 'oracle',
  embeddings: ([] as string[])
    .concat(body?.input as string[])
    .map((t) => (t.endsWith(q.query) || relevantTexts.some((r) => t.endsWith(r)) ? [1, 0] : [0, 1])),
});

const ctx = runContext({ config: { ...testConfig, extra: { embedder: 'bge-m3:latest', reranker: 'none' } } }).ctx;
let shared: unknown;

beforeEach(() => {
  ollama.reset();
  ollama.routes['/api/embed'] = oracle;
});

async function run(answer: string, query = q) {
  shared ??= (await rag.prepare!({ ...ctx, onDelta: () => {} })).shared;
  ollama.routes['/api/embed'] = oracle;
  ollama.replies.push(chatReply({ text: answer }));
  const out = await rag.run({ ...ctx, shared }, query);
  return { out, failed: rag.check(query, out, en).filter((c) => !c.pass) };
}

describe('rag', () => {
  it('the generator gets the top 5 passages, numbered, with the question; the relevant one first here', async () => {
    const { out } = await run('See [1].');
    const prompt = (ollama.calls('/api/chat')[0].body?.messages as { content: string }[]).at(-1)!.content;
    expect(prompt).toMatch(/^Passages:\n\n\[1\] [\s\S]*\[5\] [\s\S]*\n\nQuestion: /);
    expect(prompt).not.toContain('[6] ');
    expect(prompt.endsWith(`Question: ${q.query}`)).toBe(true);
    const d = out.data as { passages: { relevant: boolean }[]; contextHasRelevant: boolean; embedder: string };
    expect(d).toMatchObject({ contextHasRelevant: true, embedder: 'bge-m3:latest' });
    expect(d.passages).toHaveLength(5);
    expect(d.passages[0].relevant).toBe(true);
    // retrieval uses the RAG embedder, never the model under test
    const embeds = ollama.calls('/api/embed');
    expect(embeds.length).toBeGreaterThan(0);
    expect(embeds.every((c) => c.body?.model === 'bge-m3:latest')).toBe(true);
  });

  it('citing the relevant passage passes the citation checks', async () => {
    const { out, failed } = await run(`${q.answer} [1]`);
    expect((out.data as { cited: number[] }).cited).toEqual([1]);
    expect(failed.filter((c) => c.name.startsWith('cites'))).toEqual([]);
  });

  it('citing only an irrelevant passage, or nothing, fails', async () => {
    const wrong = await run(`${q.answer} [5]`);
    expect(wrong.failed.map((c) => c.name)).toContain('cites a relevant passage');
    const none = await run(q.answer);
    expect(none.failed.map((c) => c.name)).toContain('cites passages');
  });

  it('citation numbers outside the passages are ignored', async () => {
    const { out } = await run('See [0], [9] and [2].');
    expect((out.data as { cited: number[] }).cited).toEqual([2]);
  });

  it('an unanswerable question is not graded on citations, only on its answer checks', async () => {
    const unanswerable = cases.find((x) => x.unanswerable);
    if (!unanswerable) return;
    const { out } = await run('The provided documents do not contain this information.', unanswerable);
    const names = rag.check(unanswerable, out, en).map((c) => c.name);
    expect(names.some((n) => n.startsWith('cites'))).toBe(false);
  });

  it('declares its embedder as a helper model (loaded and released with the session)', () => {
    expect(rag.helperModels!({ ...testConfig, extra: { embedder: 'nomic-embed-text' } })).toEqual([
      { name: 'nomic-embed-text', embedding: true },
    ]);
  });
});
