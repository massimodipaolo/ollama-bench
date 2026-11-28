/**
 * The runner end to end, against a fake Ollama (test/helpers/fake-ollama.ts) and a temporary database: a session is
 * started as the API does, runs every quick case, and what it stores (runs, case results, timings, scores) is checked
 * along with what it asked Ollama to do (warm-up, generation settings, unloading).
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionEvent } from '@/lib/runner/events';
import { chatReply, startFakeOllama } from '../helpers/fake-ollama';
import { fakeModel as model, sessionFinished as finished } from '../helpers/sessions';

const ollama = await startFakeOllama();
process.env.OLLAMA_HOST = ollama.url;
const { startSession, cancelSession } = await import('@/lib/runner');
const { getLive } = await import('@/lib/runner/events');
const { getDb, schema } = await import('@/db');
const { getTest } = await import('@/lib/tests/registry');

afterAll(() => ollama.close());

beforeEach(() => {
  ollama.reset();
  ollama.routes['/api/tags'] = () => ({ models: [model('alpha:7b'), model('beta:7b'), model('embedder:1b', ['embedding'])] });
});

const runsOf = (sessionId: string) =>
  getDb().select().from(schema.runs).where(eq(schema.runs.sessionId, sessionId)).orderBy(schema.runs.id).all();
const casesOf = (runId: number) => getDb().select().from(schema.caseResults).where(eq(schema.caseResults.runId, runId)).all();
const quickCases = getTest('text-generation')
  .loadCases('en')
  .filter((c) => c.quick).length;

describe('a single-model session', () => {
  it('runs every quick case and stores results, timings and scores', async () => {
    const id = await startSession({ testId: 'text-generation', lang: 'en', models: ['alpha:7b'], config: { judges: [] } });
    const session = await finished(id);

    expect(session.status).toBe('done');
    expect(session.config).toMatchObject({
      numCtx: 8192,
      seed: 42,
      temperature: 0,
      subset: 'quick',
      judges: [],
      ollamaVersion: '0.40.0-fake',
    });
    expect(session.config.sdk?.ai).toBeTruthy(); // the SDK versions are recorded with every session

    const [run] = runsOf(id);
    expect(run).toMatchObject({ status: 'done', role: 'candidate', blindLabel: 'A', error: null });
    expect(run.loadMs).toBeGreaterThanOrEqual(0);
    expect(run.avgTokPerSec).toBeCloseTo(40); // the fake's 20 tokens in 0.5 s of eval_duration
    expect(run.execMs).toBeGreaterThan(0);
    expect(run.execMs!).toBeLessThanOrEqual(run.finishedAt! - run.startedAt! + 1); // model work only, within the run

    const cases = casesOf(run.id);
    expect(cases).toHaveLength(quickCases);
    // the run's execution time is warm-up + every case's run: at least the sum of the cases
    expect(run.execMs!).toBeGreaterThanOrEqual(cases.reduce((s, c) => s + c.execMs!, 0));
    for (const c of cases) {
      expect(c).toMatchObject({ output: 'ok', tokensIn: 12, tokensOut: 20, error: null });
      expect(c.execMs).toBeGreaterThan(0);
      expect(c.latencyMs).toBeGreaterThan(0);
      expect(c.checks?.length).toBeGreaterThan(0);
      expect(c.autoScore).not.toBeNull();
    }
  });

  it('asks Ollama to warm the model up with the session context, generate each case, then free the model', async () => {
    const id = await startSession({ testId: 'text-generation', lang: 'en', models: ['alpha:7b'], config: { judges: [], numCtx: 4096 } });
    await finished(id);

    const chats = ollama.calls('/api/chat');
    const warmUp = chats.find((r) => r.body?.stream === false);
    expect(warmUp?.body).toMatchObject({ model: 'alpha:7b', keep_alive: '15m', options: { num_ctx: 4096, num_predict: 1 } });
    const generations = chats.filter((r) => r.body?.stream !== false);
    expect(generations).toHaveLength(quickCases);
    for (const g of generations) expect(g.body).toMatchObject({ model: 'alpha:7b', options: expect.objectContaining({ num_ctx: 4096 }) });
    // nothing queued needs it: unloaded at the end (keep_alive 0)
    expect(ollama.calls('/api/generate').map((r) => r.body)).toContainEqual({ model: 'alpha:7b', keep_alive: 0 });
  });

  it('caps num_ctx at the model maximum and records what was asked', async () => {
    ollama.routes['/api/tags'] = () => ({ models: [model('small:1b', ['completion'], 2048)] });
    const id = await startSession({ testId: 'text-generation', lang: 'en', models: ['small:1b'], config: { judges: [], numCtx: 16384 } });
    const session = await finished(id);
    expect(session.config).toMatchObject({ numCtx: 2048, numCtxRequested: 16384 });
  });
});

describe('two models', () => {
  it('runs them one after the other, unloading each after its run', async () => {
    const id = await startSession({ testId: 'text-generation', lang: 'en', models: ['alpha:7b', 'beta:7b'], config: { judges: [] } });
    await finished(id);
    const [a, b] = runsOf(id);
    expect([a.blindLabel, b.blindLabel]).toEqual(['A', 'B']);
    expect(a.status).toBe('done');
    expect(b.status).toBe('done');
    expect(b.startedAt!).toBeGreaterThanOrEqual(a.finishedAt!); // never both on the GPU
    const unloads = ollama.calls('/api/generate').map((r) => r.body?.model);
    expect(unloads).toEqual(expect.arrayContaining(['alpha:7b', 'beta:7b']));
  });
});

describe('failures', () => {
  it('refuses a model the host does not have, or one without the capabilities the test needs', async () => {
    await expect(startSession({ testId: 'text-generation', lang: 'en', models: ['missing:1b'], config: {} })).rejects.toThrow(
      'Model not found on Ollama host: missing:1b',
    );
    await expect(startSession({ testId: 'text-generation', lang: 'en', models: ['embedder:1b'], config: {} })).rejects.toThrow(
      /lacks the capabilities/,
    );
    await expect(startSession({ testId: 'text-generation', lang: 'en', models: [], config: {} })).rejects.toThrow(
      'Select one or two models',
    );
  });

  it('a failed warm-up fails that run only: no cases, an error, the session still ends', async () => {
    ollama.routes['/api/chat'] = () => {
      throw new Error('model requires more system memory');
    };
    const id = await startSession({ testId: 'text-generation', lang: 'en', models: ['alpha:7b'], config: { judges: [] } });
    const session = await finished(id);
    expect(session.status).toBe('done');
    const [run] = runsOf(id);
    expect(run.status).toBe('error');
    expect(run.error).toMatch(/^Warm-up failed: .*system memory/);
    expect(casesOf(run.id)).toHaveLength(0);
  });

  it('a generation error is stored on its case, with the partial output, and the run goes on', async () => {
    ollama.replies.push(chatReply({ text: 'half an answer', pieces: 2, errorAfterText: 'repeat limit reached' }));
    const id = await startSession({ testId: 'text-generation', lang: 'en', models: ['alpha:7b'], config: { judges: [] } });
    await finished(id);
    const [run] = runsOf(id);
    const cases = casesOf(run.id);
    expect(run.status).toBe('done');
    expect(cases).toHaveLength(quickCases);
    const failed = cases.filter((c) => c.error);
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toMatch(/repeat limit/);
    expect('half an answer'.startsWith(failed[0].output ?? '')).toBe(true);
    expect(failed[0].execMs).toBeGreaterThan(0); // the time until the failure
  });

  it('cancelling stops after the current case: the session is cancelled, the run marked cancelled', async () => {
    const id = await startSession({ testId: 'text-generation', lang: 'en', models: ['alpha:7b'], config: { judges: [] } });
    // cancel as soon as the first case ends
    getLive(id)!.listeners.add((e: SessionEvent) => {
      if (e.type === 'case-end') cancelSession(id);
    });
    const session = await finished(id);
    expect(session.status).toBe('cancelled');
    const [run] = runsOf(id);
    expect(run).toMatchObject({ status: 'error', error: 'cancelled' });
    expect(casesOf(run.id).length).toBeLessThan(quickCases);
  });
});
