/**
 * Server infrastructure: recovery after a crash (sessions and containers of servers that stopped, never those of a
 * live one), the startup hook, the GPU lock, the live event stream, and the provider helpers.
 */
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDb, schema } from '@/db';
import { currentSuite, seedModel, seedRun } from '../../helpers/seed';
import { routeParams } from '../../helpers/sessions';

const dockerCalls = vi.hoisted(() => ({ calls: [] as string[][], ps: new Map<string, string>() }));
vi.mock('@/lib/docker', () => ({
  docker: async (args: string[]) => {
    dockerCalls.calls.push(args);
    if (args[0] === 'ps') return { code: 0, out: dockerCalls.ps.get(args.at(-1)!.split('=').at(-1)!) ?? '', timedOut: false };
    return { code: 0, out: '', timedOut: false };
  },
}));

const { recoverAbandoned } = await import('@/lib/runner/recover');
const { serverInstance, STALE_MS } = await import('@/lib/runner/instance');
const { createLive, emit, withOllamaLock } = await import('@/lib/runner/events');
const events = await import('@/app/api/sessions/[id]/events/route');
const { ollamaBaseURL, judges, cohereSlot, cohereReranker } = await import('@/lib/providers');

const db = getDb();
const sessionOf = (id: string) => db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get()!;

describe('recoverAbandoned (server start)', () => {
  it('interrupts the sessions of stopped servers and removes their containers; leaves live servers alone', async () => {
    const tg = await currentSuite('text-generation');
    const self = serverInstance();
    const now = Date.now();
    db.insert(schema.serverInstances)
      .values([
        { id: 'dead', pid: 1, startedAt: now - 10 * STALE_MS, heartbeatAt: now - 2 * STALE_MS },
        { id: 'alive', pid: 2, startedAt: now - 10 * STALE_MS, heartbeatAt: now },
      ])
      .run();
    const model = seedModel('rec:7b');
    const mk = (status: 'running' | 'queued' | 'done') =>
      seedRun({ modelId: model, testId: 'text-generation', suiteVersion: tg, at: now, status });
    const deadRunning = mk('running');
    const deadQueued = mk('queued');
    const deadDone = mk('done');
    const aliveRunning = mk('running');
    const legacy = mk('running'); // recorded before sessions had an owner
    const own = mk('running');
    const owner = (s: { sessionId: string }, id: string | null) =>
      db.update(schema.sessions).set({ instanceId: id }).where(eq(schema.sessions.id, s.sessionId)).run();
    for (const s of [deadRunning, deadQueued, deadDone]) owner(s, 'dead');
    owner(aliveRunning, 'alive');
    owner(legacy, null);
    owner(own, self);
    dockerCalls.ps.set('dead', 'c1\nc2\n');

    expect(await recoverAbandoned()).toEqual({ sessions: 3, containers: 2 });

    for (const s of [deadRunning, deadQueued, legacy])
      expect(sessionOf(s.sessionId)).toMatchObject({ status: 'error', error: 'interrupted: the server stopped before this finished' });
    expect(sessionOf(deadDone.sessionId).status).toBe('done'); // finished sessions are untouched
    expect(sessionOf(aliveRunning.sessionId).status).toBe('running'); // another live server's session
    expect(sessionOf(own.sessionId).status).toBe('running'); // this server's own
    const run = db.select().from(schema.runs).where(eq(schema.runs.id, deadRunning.runId)).get()!;
    expect(run).toMatchObject({ status: 'error', error: 'interrupted: the server stopped before this finished' });
    // only the dead server's labelled containers are removed, and it is forgotten
    expect(dockerCalls.calls).toContainEqual(['ps', '-aq', '--filter', 'label=ollama-bench.instance=dead']);
    expect(dockerCalls.calls).toContainEqual(['rm', '-f', 'c1', 'c2']);
    expect(dockerCalls.calls.some((a) => a.includes('label=ollama-bench.instance=alive'))).toBe(false);
    expect(
      db
        .select()
        .from(schema.serverInstances)
        .all()
        .map((s) => s.id)
        .sort(),
    ).toEqual(['alive', self].sort());
  });

  it('the startup hook runs recovery only in the Node.js runtime, and never throws', async () => {
    const { register } = await import('@/instrumentation');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    await register();
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    await expect(register()).resolves.toBeUndefined();
    vi.unstubAllEnvs();
    log.mockRestore();
  });
});

describe('the GPU lock', () => {
  it('runs sessions one at a time, in arrival order, and survives a failure', async () => {
    const order: string[] = [];
    const job = (name: string, ms: number, fail = false) =>
      withOllamaLock(async () => {
        order.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`${name}:end`);
        if (fail) throw new Error(name);
      });
    const results = await Promise.allSettled([job('a', 30), job('b', 5, true), job('c', 1)]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });
});

describe('live events stream (SSE) while a session runs', () => {
  it('replays what happened so far, streams new events, and closes at the end', async () => {
    createLive('live-1');
    emit('live-1', { type: 'session', status: 'running' });
    const res = await events.GET(new NextRequest('http://localhost:3000/api/sessions/live-1/events'), routeParams({ id: 'live-1' }));
    const reader = res.body!.getReader();
    const read = async () => new TextDecoder().decode((await reader.read()).value);
    expect(await read()).toBe('data: {"type":"session","status":"running"}\n\n');
    emit('live-1', { type: 'delta', runId: 1, caseId: 'c', text: 'hi' });
    expect(await read()).toContain('"text":"hi"');
    emit('live-1', { type: 'session-end', status: 'done' });
    expect(await read()).toContain('"session-end"');
    expect((await reader.read()).done).toBe(true);
  });

  it('a client that disconnects stops receiving', async () => {
    createLive('live-2');
    const abort = new AbortController();
    const res = await events.GET(
      new NextRequest('http://localhost:3000/api/sessions/live-2/events', { signal: abort.signal }),
      routeParams({ id: 'live-2' }),
    );
    const reader = res.body!.getReader();
    abort.abort();
    emit('live-2', { type: 'session', status: 'judging' });
    expect((await reader.read()).done).toBe(true);
  });
});

describe('providers', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ['gpu-box', 'http://gpu-box:11434'],
    ['gpu-box:8080', 'http://gpu-box:8080'],
    ['https://ollama.example/', 'https://ollama.example'],
    ['http://10.0.0.5', 'http://10.0.0.5:11434'],
    ['  http://h:1/  ', 'http://h:1'],
  ])('OLLAMA_HOST %j → %s', (host, url) => {
    vi.stubEnv('OLLAMA_HOST', host);
    expect(ollamaBaseURL()).toBe(url);
  });

  it('a judge needs both its key and its model', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    expect(judges()).toEqual([]);
    vi.stubEnv('OPENAI_MODEL', 'gpt-test');
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-test'); // no key
    expect(judges().map((j) => [j.id, j.modelId])).toEqual([['openai', 'gpt-test']]);
    expect(cohereReranker()).toBeNull();
  });

  it('cohereSlot spaces calls to the configured rate', async () => {
    vi.stubEnv('COHERE_RPM', '600'); // one call every 100 ms (+100 ms margin)
    const t0 = Date.now();
    await Promise.all([cohereSlot(), cohereSlot(), cohereSlot()]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2 * 200 - 20);
  });
});
