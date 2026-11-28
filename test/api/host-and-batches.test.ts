/**
 * API routes around the Ollama host (model list, sync, loaded models, unload, host default context), the test list,
 * active sessions and capability batches, against the fake Ollama and a temporary database.
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeOllama } from '../helpers/fake-ollama';
import { fakeModel, routeParams, sessionFinished } from '../helpers/sessions';

const ollama = await startFakeOllama();
process.env.OLLAMA_HOST = ollama.url;
const models = await import('@/app/api/models/route');
const sync = await import('@/app/api/models/sync/route');
const hostContext = await import('@/app/api/models/host-context/route');
const loaded = await import('@/app/api/ollama/loaded/route');
const unload = await import('@/app/api/ollama/unload/route');
const tests = await import('@/app/api/tests/route');
const active = await import('@/app/api/active/route');
const batches = await import('@/app/api/batches/route');
const batch = await import('@/app/api/batches/[id]/route');
const batchCancel = await import('@/app/api/batches/[id]/cancel/route');
const { registerSession, forgetSession } = await import('@/lib/runner/residency');

afterAll(() => ollama.close());

const post = (path: string, body?: unknown) =>
  new NextRequest(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

beforeEach(() => {
  ollama.reset();
  ollama.routes['/api/tags'] = () => ({
    models: [
      fakeModel('alpha:7b'),
      { ...fakeModel('tiny:1b', ['completion'], 262_144), size: 1_000_000_000 },
      fakeModel('embedder:1b', ['embedding']),
    ],
  });
});

describe('model list and sync', () => {
  it('GET /api/models: the host, its version and its models with capabilities and context', async () => {
    const d = await (await models.GET()).json();
    expect(d).toMatchObject({ host: ollama.url, version: '0.40.0-fake' });
    expect(d.models.map((m: { name: string }) => m.name)).toEqual(['alpha:7b', 'embedder:1b', 'tiny:1b']);
    expect(d.models[0]).toMatchObject({
      parameterSize: '7.6B',
      quantization: 'Q4_K_M',
      contextLength: 32768,
      capabilities: ['completion', 'tools'],
    });
  });

  it('GET /api/models: 502 with the reason when Ollama fails', async () => {
    ollama.routes['/api/tags'] = () => {
      throw new Error('internal error');
    };
    const res = await models.GET();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ host: ollama.url, models: [], error: expect.stringContaining('500') });
  });

  it('POST /api/models/sync: stores new models, then reports a re-pulled one as updated', async () => {
    const first = await (await sync.POST()).json();
    expect(first).toMatchObject({ total: 3, added: ['alpha:7b', 'embedder:1b', 'tiny:1b'], updated: [] }); // sorted by name
    ollama.routes['/api/tags'] = () => ({ models: [{ ...fakeModel('alpha:7b'), digest: 'sha256:new' }] });
    expect(await (await sync.POST()).json()).toMatchObject({ total: 1, added: [], updated: ['alpha:7b'] });
  });
});

describe('models in memory', () => {
  it('GET /api/ollama/loaded: what Ollama holds, flagged when a session of this server needs it', async () => {
    ollama.routes['/api/ps'] = () => ({
      models: [
        { name: 'alpha:7b', size_vram: 5e9, context_length: 8192, expires_at: '2026-11-28T12:00:00Z' },
        { name: 'tiny:1b', size_vram: 1e9, expires_at: '2026-11-28T12:00:00Z' },
      ],
    });
    registerSession('s1', ['alpha:7b'], [], false);
    try {
      const list = await (await loaded.GET()).json();
      expect(list).toEqual([
        { name: 'alpha:7b', sizeVram: 5e9, contextLength: 8192, expiresAt: '2026-11-28T12:00:00Z', inUse: true },
        { name: 'tiny:1b', sizeVram: 1e9, contextLength: null, expiresAt: '2026-11-28T12:00:00Z', inUse: false },
      ]);
    } finally {
      forgetSession('s1');
    }
  });

  it('POST /api/ollama/unload: frees a model (keep_alive 0), embedding models through /api/embed', async () => {
    expect(await (await unload.POST(post('/api/ollama/unload', { model: 'alpha:7b' }))).json()).toEqual({ ok: true });
    expect(ollama.calls('/api/generate').at(-1)?.body).toEqual({ model: 'alpha:7b', keep_alive: 0 });
    await unload.POST(post('/api/ollama/unload', { model: 'embedder:1b' }));
    expect(ollama.calls('/api/embed').at(-1)?.body).toEqual({ model: 'embedder:1b', input: '', keep_alive: 0 });
  });

  it('POST /api/ollama/unload: refused while a queued or running session needs the model (409)', async () => {
    registerSession('s2', ['alpha:7b'], [], false);
    try {
      const res = await unload.POST(post('/api/ollama/unload', { model: 'alpha:7b' }));
      expect(res.status).toBe(409);
      expect(ollama.calls('/api/generate')).toHaveLength(0);
    } finally {
      forgetSession('s2');
    }
  });

  it('POST /api/ollama/unload: 400 without a model name', async () => {
    expect((await unload.POST(post('/api/ollama/unload', { model: '' }))).status).toBe(400);
    expect((await unload.POST(post('/api/ollama/unload', 'nope'))).status).toBe(400);
  });
});

describe('host default context', () => {
  it('POST probes with the smallest model whose maximum cannot hide the default, then unloads it; GET returns it', async () => {
    expect(await (await hostContext.GET()).json()).toBeNull();
    ollama.routes['/api/ps'] = () => ({ models: [{ name: 'tiny:1b', size_vram: 1e9, context_length: 4096, expires_at: '' }] });
    const d = await (await hostContext.POST()).json();
    expect(d).toMatchObject({ defaultContext: 4096, model: 'tiny:1b', cappedByModel: false });
    // loaded without num_ctx, so Ollama picks its default
    expect(ollama.calls('/api/generate')[0].body).toEqual({ model: 'tiny:1b', prompt: '', keep_alive: '30s' });
    expect(ollama.calls('/api/generate').at(-1)?.body).toEqual({ model: 'tiny:1b', keep_alive: 0 });
    expect(await (await hostContext.GET()).json()).toMatchObject({ defaultContext: 4096 });
  });

  it('502 when the host has no completion model to probe with', async () => {
    ollama.routes['/api/tags'] = () => ({ models: [fakeModel('embedder:1b', ['embedding'])] });
    const res = await hostContext.POST();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'No completion model on the host to probe with' });
  });
});

describe('GET /api/tests', () => {
  it('lists tests, capabilities, languages, judges and SDK versions for the run form and pnpm bench', async () => {
    const d = await (await tests.GET()).json();
    expect(d.tests.map((t: { id: string }) => t.id)).toEqual(
      expect.arrayContaining(['text-generation', 'tool-use', 'bfcl', 'rag', 'terminal-bench']),
    );
    expect(d.capabilities.find((c: { id: string }) => c.id === 'tools').tests).toContain('mcp');
    expect(d.languages.map((l: { code: string }) => l.code)).toEqual(['en', 'it']);
    expect(d.judges).toEqual([]); // no keys in tests
    expect(d.sdk.ai).toBeTruthy();
  });
});

describe('capability batches', () => {
  it.each([
    ['not JSON', 'nope'],
    ['no tests', { capability: 'text', testIds: [], lang: 'en', models: ['alpha:7b'] }],
    ['three models', { capability: 'text', testIds: ['text-generation'], lang: 'en', models: ['a', 'b', 'c'] }],
  ])('POST /api/batches: 400 on an invalid body (%s)', async (_, body) => {
    expect((await batches.POST(post('/api/batches', body))).status).toBe(400);
  });

  it('POST /api/batches: 400 for an unknown capability or a test outside it', async () => {
    const unknown = await batches.POST(
      post('/api/batches', { capability: 'nope', testIds: ['text-generation'], lang: 'en', models: ['alpha:7b'] }),
    );
    expect(await unknown.json()).toEqual({ error: 'Unknown capability: nope' });
    const outside = await batches.POST(post('/api/batches', { capability: 'text', testIds: ['bfcl'], lang: 'en', models: ['alpha:7b'] }));
    expect((await outside.json()).error).toMatch(/^Not part of Text: bfcl/);
  });

  it('runs one session per test, then GET /api/batches/[id] shows them; GET /api/active empties when done', async () => {
    const res = await batches.POST(
      post('/api/batches', { capability: 'text', testIds: ['text-generation'], lang: 'en', models: ['alpha:7b'], config: { judges: [] } }),
    );
    const { id, sessions } = (await res.json()) as { id: string; sessions: string[] };
    expect(sessions).toHaveLength(1);
    await sessionFinished(sessions[0]);

    const detail = await (await batch.GET(new NextRequest(`http://localhost:3000/api/batches/${id}`), routeParams({ id }))).json();
    expect(detail).toMatchObject({ status: 'done' });
    expect(detail.sessions.map((s: { id: string }) => s.id)).toEqual(sessions);
    expect(await (await active.GET()).json()).toEqual([]);
    expect(await (await batchCancel.POST(post(`/api/batches/${id}/cancel`), routeParams({ id }))).json()).toEqual({ ok: true });
  });

  it('GET /api/batches/[id]: 404 for an unknown batch', async () => {
    const res = await batch.GET(new NextRequest('http://localhost:3000/api/batches/nope'), routeParams({ id: 'nope' }));
    expect(res.status).toBe(404);
  });
});
