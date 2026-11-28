// @vitest-environment jsdom
/**
 * The session page rendered in a simulated browser (jsdom + React Testing Library): loading the stored session,
 * following a live one through its event stream, re-judging, cancelling. fetch and EventSource are stand-ins.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '@/lib/runner/events';
import { SessionView } from '@/app/sessions/[id]/session-view';

/** EventSource stand-in: the test pushes events into the page. */
class FakeEventSource {
  static last: FakeEventSource | undefined;
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  push(e: SessionEvent | { type: 'not-live' }) {
    act(() => this.onmessage?.({ data: JSON.stringify(e) }));
  }
  close() {
    this.closed = true;
  }
}

const T = 1_800_000_000_000;
const judgedCase = (id: number, caseId: string, scores: Record<string, number>) => ({
  id,
  caseId,
  output: `Output of ${caseId}`,
  checks: [{ name: 'non-empty', pass: true }],
  autoScore: 10,
  latencyMs: 800,
  ttftMs: 120,
  tokensOut: 40,
  tokPerSec: 50,
  execMs: 900,
  judgments: Object.entries(scores).map(([judge, score]) => ({
    judge,
    score,
    rationale: `${judge} says`,
    cached: false,
    withoutAttachments: false,
  })),
});
const detail = (o: Record<string, unknown> = {}) => ({
  testName: 'Text generation',
  lang: 'en',
  status: 'done',
  error: null,
  createdAt: T,
  finishedAt: T + 60_000,
  config: { subset: 'quick', think: false, temperature: 0, seed: 42, numCtx: 8192, judges: ['openai', 'anthropic'] },
  suiteVersion: 'v1',
  cases: [
    { id: 'c1', title: 'Summary' },
    { id: 'c2', title: 'Translation' },
  ],
  judges: [],
  live: false,
  runs: [
    {
      id: 1,
      blindLabel: 'A',
      role: 'candidate',
      stats: null,
      model: { name: 'alpha:7b', parameterSize: '7.6B', quantization: 'Q4_K_M', digest: 'abcdef1234567890' },
      status: 'done',
      error: null,
      loadMs: 1200,
      autoScore: 9,
      judgeScores: { openai: 9, anthropic: 4 },
      judgeAvg: 6.5,
      avgTokPerSec: 50,
      avgLatencyMs: 800,
      startedAt: T,
      finishedAt: T + 50_000,
      execMs: 45_000,
      cases: [judgedCase(11, 'c1', { openai: 9, anthropic: 4 }), judgedCase(12, 'c2', { openai: 8, anthropic: 8 })],
    },
  ],
  ...o,
});

let api: { detail: ReturnType<typeof detail> | null; calls: { url: string; init?: RequestInit }[] };
beforeEach(() => {
  api = { detail: detail(), calls: [] };
  FakeEventSource.last = undefined;
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      api.calls.push({ url, init });
      if (url.endsWith('/rejudge') || url.endsWith('/cancel')) return Response.json({ ok: true });
      return api.detail ? Response.json(api.detail) : Response.json({ error: 'not found' }, { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('a finished session', () => {
  it('shows the test, the model with its scores and timings, every case with its judgments', async () => {
    render(<SessionView id="s1" />);
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(await screen.findByText('alpha:7b')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Text generation · en');
    expect(screen.getByText('exec time 45.0 s')).toBeTruthy(); // the header total
    expect(screen.getByText('Summary')).toBeTruthy();
    expect(screen.getByText('Output of c1')).toBeTruthy();
    expect(screen.getAllByText('exec 900 ms')).toHaveLength(2);
    // 9 vs 4 on the first case: flagged; 8 vs 8 on the second: not
    expect(screen.getAllByText(/judges disagree/)).toHaveLength(1);
    expect(api.calls[0].url).toBe('/api/sessions/s1');
    expect(FakeEventSource.last).toBeUndefined(); // not live: no event stream
  });

  it('Re-judge posts to the API and reloads the session', async () => {
    render(<SessionView id="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Re-judge' }));
    await waitFor(() => expect(api.calls.filter((c) => c.url === '/api/sessions/s1').length).toBe(2));
    expect(api.calls.find((c) => c.url.endsWith('/rejudge'))!.init).toMatchObject({ method: 'POST', body: '{}' });
  });

  it('an unknown session says so', async () => {
    api.detail = null;
    render(<SessionView id="nope" />);
    expect(await screen.findByText('Session not found.')).toBeTruthy();
  });
});

describe('a live session', () => {
  const live = () =>
    detail({
      status: 'running',
      finishedAt: null,
      live: true,
      runs: [
        {
          ...detail().runs[0],
          status: 'queued',
          startedAt: null,
          finishedAt: null,
          execMs: null,
          judgeScores: null,
          judgeAvg: null,
          cases: [],
        },
      ],
    });

  it('follows the event stream: streamed text, the case result, then the end (reload, stream closed)', async () => {
    api.detail = live();
    render(<SessionView id="s2" />);
    await screen.findByText('running…');
    const es = FakeEventSource.last!;
    expect(es.url).toBe('/api/sessions/s2/events');

    es.push({ type: 'run-status', runId: 1, status: 'running', loadMs: 900 });
    es.push({ type: 'case-start', runId: 1, caseId: 'c1', title: 'Summary' });
    es.push({ type: 'delta', runId: 1, caseId: 'c1', text: 'Streaming ' });
    es.push({ type: 'delta', runId: 1, caseId: 'c1', text: 'text' });
    expect(screen.getByText(/Streaming text/)).toBeTruthy();

    es.push({
      type: 'case-end',
      runId: 1,
      caseId: 'c1',
      caseResultId: 5,
      output: 'Final text',
      metrics: { latencyMs: 700, execMs: 750 },
      checks: [],
      autoScore: 10,
    });
    expect(screen.getByText('Final text')).toBeTruthy();
    expect(screen.getByText('exec 750 ms')).toBeTruthy();

    es.push({ type: 'session', status: 'judging' });
    expect(screen.getByText('judging…')).toBeTruthy();
    api.detail = detail();
    es.push({ type: 'session-end', status: 'done' });
    expect(es.closed).toBe(true);
    await waitFor(() => expect(screen.getByText('Re-judge')).toBeTruthy()); // reloaded: finished
  });

  it('Cancel posts to the API while it runs', async () => {
    api.detail = live();
    render(<SessionView id="s3" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(api.calls.some((c) => c.url === '/api/sessions/s3/cancel' && c.init?.method === 'POST')).toBe(true));
  });
});
