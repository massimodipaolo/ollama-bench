/**
 * The session API routes, called as Next calls them (route handler + request), against the fake Ollama and a
 * temporary database: starting a session, reading it back, live events, cancelling, re-judging, run history, the
 * CSV export and the prompt preview.
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chatReply, startFakeOllama } from '../helpers/fake-ollama';
import { fakeModel, routeParams, sessionFinished } from '../helpers/sessions';

const ollama = await startFakeOllama();
process.env.OLLAMA_HOST = ollama.url;
const sessions = await import('@/app/api/sessions/route');
const sessionDetail = await import('@/app/api/sessions/[id]/route');
const events = await import('@/app/api/sessions/[id]/events/route');
const cancel = await import('@/app/api/sessions/[id]/cancel/route');
const rejudge = await import('@/app/api/sessions/[id]/rejudge/route');
const prompt = await import('@/app/api/sessions/[id]/prompt/route');
const promptFile = await import('@/app/api/sessions/[id]/prompt/file/route');
const runs = await import('@/app/api/runs/route');
const exportCsv = await import('@/app/api/export/route');
const { createLive } = await import('@/lib/runner/events');

afterAll(() => ollama.close());

const req = (path: string, init?: { method?: string; body?: unknown }) =>
  new NextRequest(`http://localhost:3000${path}`, {
    method: init?.method ?? 'GET',
    ...(init?.body !== undefined
      ? { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body), headers: { 'content-type': 'application/json' } }
      : {}),
  });

beforeEach(() => {
  ollama.routes['/api/tags'] = () => ({
    models: [fakeModel('alpha:7b'), fakeModel('seer:7b', ['completion', 'vision']), fakeModel('weird/model:1b "x"')],
  });
});

/** Starts a session through the API and waits for it to finish. */
async function runSession(body: Record<string, unknown>) {
  const res = await sessions.POST(req('/api/sessions', { method: 'POST', body }));
  expect(res.status).toBe(200);
  const { id } = (await res.json()) as { id: string };
  await sessionFinished(id);
  return id;
}

let textSession: string;
beforeAll(async () => {
  ollama.routes['/api/tags'] = () => ({ models: [fakeModel('alpha:7b')] });
  // one answer looks like a spreadsheet formula: the export must not let it run in Excel
  ollama.replies.push(chatReply({ text: '=HYPERLINK("http://evil.example","click")' }));
  textSession = await runSession({ testId: 'text-generation', lang: 'en', models: ['alpha:7b'], config: { judges: [] } });
});

describe('POST /api/sessions', () => {
  it.each([
    ['not JSON', 'nope'],
    ['missing fields', {}],
    ['three models', { testId: 'text-generation', lang: 'en', models: ['a', 'b', 'c'] }],
    ['num_ctx too small', { testId: 'text-generation', lang: 'en', models: ['alpha:7b'], config: { numCtx: 100 } }],
    ['unknown subset', { testId: 'text-generation', lang: 'en', models: ['alpha:7b'], config: { subset: 'all' } }],
  ])('400 on an invalid body: %s', async (_, body) => {
    const res = await sessions.POST(req('/api/sessions', { method: 'POST', body }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
  });

  it('400 with the reason when the runner refuses (a model the host does not have)', async () => {
    const res = await sessions.POST(
      req('/api/sessions', { method: 'POST', body: { testId: 'text-generation', lang: 'en', models: ['ghost:1b'] } }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Model not found on Ollama host: ghost:1b' });
  });

  it('returns the new session id', async () => {
    expect(textSession).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('reading sessions back', () => {
  it('GET /api/sessions/[id]: the session, its runs and cases, the test name and case titles', async () => {
    const res = await sessionDetail.GET(req(`/api/sessions/${textSession}`), routeParams({ id: textSession }));
    const d = await res.json();
    expect(d).toMatchObject({ id: textSession, status: 'done', testName: 'Text generation', live: false, judges: [] });
    expect(d.cases.length).toBeGreaterThan(0);
    expect(d.runs[0].model.name).toBe('alpha:7b');
    expect(d.runs[0].cases[0]).toHaveProperty('execMs');
  });

  it('404 for an unknown session', async () => {
    const res = await sessionDetail.GET(req('/api/sessions/nope'), routeParams({ id: 'nope' }));
    expect(res.status).toBe(404);
  });

  it('GET /api/sessions: recent sessions, with execution time, filterable by test', async () => {
    const all = await (await sessions.GET(req('/api/sessions'))).json();
    expect(all.find((s: { id: string }) => s.id === textSession)).toMatchObject({ testId: 'text-generation', status: 'done' });
    expect(all.find((s: { id: string }) => s.id === textSession).execMs).toBeGreaterThan(0);
    expect(await (await sessions.GET(req('/api/sessions?testId=embeddings'))).json()).toEqual([]);
  });

  it('GET /api/runs: run history for the CLI, filterable by test and model', async () => {
    const rows = await (await runs.GET(req('/api/runs?testId=text-generation&model=alpha:7b'))).json();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ testId: 'text-generation', model: 'alpha:7b', status: 'done' });
    expect(await (await runs.GET(req('/api/runs?model=nobody'))).json()).toEqual([]);
  });
});

describe('live events (Server-Sent Events)', () => {
  const read = async (res: Response) =>
    (await res.text())
      .split('\n\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l.replace(/^data: /, '')));

  it('a finished session replays its buffered events and closes', async () => {
    const res = await events.GET(req(`/api/sessions/${textSession}/events`), routeParams({ id: textSession }));
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const list = await read(res);
    expect(list[0]).toEqual({ type: 'session', status: 'running' });
    expect(list.some((e) => e.type === 'case-end')).toBe(true);
    expect(list.at(-1)).toEqual({ type: 'session-end', status: 'done' });
  });

  it('a session this server is not running answers not-live', async () => {
    const res = await events.GET(req('/api/sessions/old/events'), routeParams({ id: 'old' }));
    expect(await read(res)).toEqual([{ type: 'not-live' }]);
  });
});

describe('cancel and re-judge', () => {
  it('cancel is a no-op for a session that is not running', async () => {
    const res = await cancel.POST(req('/api/sessions/nope/cancel', { method: 'POST' }), routeParams({ id: 'nope' }));
    expect(await res.json()).toEqual({ ok: true });
  });

  it('re-judging a session that is still running is refused (409)', async () => {
    createLive('busy'); // live and not done, as while the runner works on it
    const res = await rejudge.POST(req('/api/sessions/busy/rejudge', { method: 'POST', body: {} }), routeParams({ id: 'busy' }));
    expect(res.status).toBe(409);
  });

  it('re-judging a finished session starts in the background', async () => {
    const res = await rejudge.POST(
      req(`/api/sessions/${textSession}/rejudge`, { method: 'POST', body: { judges: [], caseResultIds: [1, 'x'] } }),
      routeParams({ id: textSession }),
    );
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('GET /api/export (CSV)', () => {
  const csv = async (q: string) => {
    const res = await exportCsv.GET(req(`/api/export${q}`));
    const bytes = new Uint8Array(await res.arrayBuffer());
    // text() would drop the BOM while decoding: keep the raw bytes to check it
    return { res, bytes, text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) };
  };

  it('run level: one row per run, with the execution time, as UTF-8 with a BOM for Excel', async () => {
    const { res, bytes, text } = await csv('?testId=text-generation');
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="ollama-bench-text-generation-run.csv"');
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const [head, ...rows] = text.slice(1).trim().split('\r\n');
    expect(head.split(',')).toEqual(expect.arrayContaining(['model', 'avg_tok_s', 'exec_ms']));
    expect(rows.length).toBeGreaterThan(0);
  });

  it('case level: model output that looks like a formula is neutralised (CSV injection)', async () => {
    const { text } = await csv('?testId=text-generation&level=case');
    expect(text).not.toMatch(/(^|,)"?=HYPERLINK/m);
    expect(text).toContain(`"'=HYPERLINK(""http://evil.example"",""click"")"`);
  });

  it('a model name cannot break out of the download file name', async () => {
    const { res } = await csv('?model=weird%2Fmodel%3A1b%20%22x%22');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="ollama-bench-weird_model_1b_x_-run.csv"');
  });
});

describe('prompt preview', () => {
  let imageSession: string;
  let caseId: string;
  beforeAll(async () => {
    ollama.routes['/api/tags'] = () => ({ models: [fakeModel('seer:7b', ['completion', 'vision'])] });
    imageSession = await runSession({ testId: 'image-recognition', lang: 'en', models: ['seer:7b'], config: { judges: [] } });
    caseId = 'infographic-ocr';
  });

  it('GET …/prompt: what the case gave the model, with links to its files', async () => {
    const res = await prompt.GET(req(`/api/sessions/${imageSession}/prompt?case=${caseId}`), routeParams({ id: imageSession }));
    const p = await res.json();
    expect(p.task).toBeTruthy();
    expect(p.attachments[0]).toMatchObject({ name: 'wmr_fb_final.jpg', mediaType: 'image/jpeg' });
    expect(p.attachments[0].url).toBe(`/api/sessions/${imageSession}/prompt/file?case=${caseId}&i=0`);
  });

  it('400 without a case, 404 for an unknown case or session', async () => {
    expect((await prompt.GET(req(`/api/sessions/${imageSession}/prompt`), routeParams({ id: imageSession }))).status).toBe(400);
    expect((await prompt.GET(req(`/api/sessions/${imageSession}/prompt?case=nope`), routeParams({ id: imageSession }))).status).toBe(404);
    expect((await prompt.GET(req('/api/sessions/nope/prompt?case=x'), routeParams({ id: 'nope' }))).status).toBe(404);
  });

  it('GET …/prompt/file: an image opens inline, never sniffed as another type', async () => {
    const res = await promptFile.GET(
      req(`/api/sessions/${imageSession}/prompt/file?case=${caseId}&i=0`),
      routeParams({ id: imageSession }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('content-disposition')).toBe('inline; filename="wmr_fb_final.jpg"');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  });

  it('file index validation', async () => {
    const get = (q: string) => promptFile.GET(req(`/api/sessions/${imageSession}/prompt/file?${q}`), routeParams({ id: imageSession }));
    expect((await get(`case=${caseId}&i=-1`)).status).toBe(400);
    expect((await get(`case=${caseId}&i=1.5`)).status).toBe(400);
    expect((await get(`case=${caseId}&i=9`)).status).toBe(404);
  });
});
