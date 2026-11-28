/**
 * The session page's state (src/app/sessions/[id]/session-state.ts): how a stored session becomes what the page
 * shows, how each live event updates it, and the execution times and judge disagreement it displays.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '@/lib/runner/events';
import {
  apply,
  avgOf,
  DISAGREEMENT,
  fromDetail,
  judgeSpread,
  runTime,
  sessionTotal,
  visibleCaseIds,
  type CaseCell,
  type ViewState,
} from '@/app/sessions/[id]/session-state';

const T = 1_800_000_000_000;
afterEach(() => vi.useRealTimers());

/** The /api/sessions/[id] answer for a queued session with one model and two cases in its fixtures. */
const detail = (over: Record<string, unknown> = {}) => ({
  testName: 'Text generation',
  lang: 'en',
  status: 'queued',
  error: null,
  createdAt: T,
  finishedAt: null,
  config: { subset: 'quick', think: false, temperature: 0, seed: 42, numCtx: 8192, judges: ['openai', 'anthropic'] },
  suiteVersion: 'v1',
  cases: [
    { id: 'c1', title: 'Case one' },
    { id: 'c2', title: 'Case two' },
  ],
  judges: [],
  runs: [
    {
      id: 1,
      blindLabel: 'A',
      role: 'candidate',
      stats: null,
      model: { name: 'alpha:7b', parameterSize: '7B', quantization: 'Q4', digest: 'abc' },
      status: 'queued',
      error: null,
      loadMs: null,
      autoScore: null,
      judgeScores: null,
      judgeAvg: null,
      avgTokPerSec: null,
      avgLatencyMs: null,
      startedAt: null,
      finishedAt: null,
      execMs: null,
      cases: [],
    },
  ],
  ...over,
});

describe('fromDetail', () => {
  it('maps the stored session, its runs and cases with judgments', () => {
    const s = fromDetail(
      detail({
        status: 'done',
        finishedAt: T + 60_000,
        runs: [
          {
            ...detail().runs[0],
            status: 'done',
            execMs: 50_000,
            judgeScores: { openai: 8 },
            cases: [
              {
                id: 7,
                caseId: 'c1',
                output: 'hi',
                checks: [],
                autoScore: 10,
                latencyMs: 900,
                execMs: 1_000,
                judgments: [{ judge: 'openai', score: 8, rationale: 'ok', cached: false, withoutAttachments: false }],
              },
            ],
          },
        ],
      }),
    );
    expect(s).toMatchObject({ status: 'done', finishedAt: T + 60_000, testName: 'Text generation' });
    expect(s.runs[0]).toMatchObject({ id: 1, label: 'A', status: 'done', execMs: 50_000, judgeScores: { openai: 8 } });
    expect(s.runs[0].cases.c1).toMatchObject({
      status: 'done',
      caseResultId: 7,
      output: 'hi',
      judgments: { openai: { score: 8, rationale: 'ok' } },
    });
    expect(s.runs[0].cases.c1.metrics.execMs).toBe(1_000);
  });

  it('defaults missing fields (an older session)', () => {
    const s = fromDetail(detail({ finishedAt: undefined }));
    expect(s.finishedAt).toBeNull();
    expect(s.runs[0].judgeScores).toEqual({});
  });
});

describe('apply: a live session, event by event', () => {
  it('builds the page from the stream: run start, streamed text, the case result, judgments, scores, the end', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    const events: SessionEvent[] = [
      { type: 'session', status: 'running' },
      { type: 'run-status', runId: 1, status: 'loading' },
      { type: 'run-status', runId: 1, status: 'running', loadMs: 1_200 },
      { type: 'case-start', runId: 1, caseId: 'c1', title: 'Case one' },
      { type: 'delta', runId: 1, caseId: 'c1', text: 'Hel' },
      { type: 'delta', runId: 1, caseId: 'c1', text: 'lo' },
    ];
    let s = events.reduce(apply, fromDetail(detail()));
    expect(s).toMatchObject({ status: 'running', phase: 'running' });
    expect(s.runs[0]).toMatchObject({ status: 'running', loadMs: 1_200, startedAt: T, finishedAt: null });
    expect(s.runs[0].cases.c1).toMatchObject({ status: 'running', output: 'Hello' });

    s = apply(s, {
      type: 'case-end',
      runId: 1,
      caseId: 'c1',
      caseResultId: 9,
      output: 'Hello!',
      metrics: { latencyMs: 800, execMs: 900 },
      checks: [{ name: 'x', pass: true }],
      autoScore: 10,
    });
    expect(s.runs[0].cases.c1).toMatchObject({
      status: 'done',
      output: 'Hello!',
      caseResultId: 9,
      autoScore: 10,
      metrics: { execMs: 900 },
    });

    s = apply(s, {
      type: 'judgment',
      runId: 1,
      caseId: 'c1',
      caseResultId: 9,
      judge: 'openai',
      score: 9,
      rationale: 'good',
      cached: false,
    });
    s = apply(s, { type: 'judgment', runId: 1, caseId: 'c1', caseResultId: 9, judge: 'anthropic', score: 4, cached: true });
    expect(s.runs[0].cases.c1.judgments).toEqual({
      openai: { score: 9, rationale: 'good', cached: false, error: undefined, withoutAttachments: undefined },
      anthropic: { score: 4, rationale: undefined, cached: true, error: undefined, withoutAttachments: undefined },
    });

    vi.setSystemTime(T + 30_000);
    s = apply(s, { type: 'run-status', runId: 1, status: 'done' });
    expect(s.runs[0]).toMatchObject({ status: 'done', startedAt: T, finishedAt: T + 30_000 }); // the start is kept
    s = apply(s, { type: 'session', status: 'judging' });
    expect(s.phase).toBe('judging');
    s = apply(s, { type: 'run-scores', runId: 1, autoScore: 10, judgeScores: { openai: 9, anthropic: 4 }, judgeAvg: 6.5 });
    expect(s.runs[0]).toMatchObject({ judgeAvg: 6.5, judgeScores: { openai: 9, anthropic: 4 } });
    s = apply(s, { type: 'session-end', status: 'done' });
    expect(s).toMatchObject({ status: 'done', phase: undefined, finishedAt: T + 30_000 });
  });

  it('never mutates the previous state (React compares by reference)', () => {
    const before = fromDetail(detail());
    const snapshot = JSON.stringify(before);
    const after = apply(before, { type: 'case-start', runId: 1, caseId: 'c1', title: 'x' });
    expect(after).not.toBe(before);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('ignores events for runs or cases it does not know', () => {
    const s = fromDetail(detail());
    expect(apply(s, { type: 'delta', runId: 99, caseId: 'c1', text: 'x' }).runs[0].cases).toEqual({});
    expect(apply(s, { type: 'delta', runId: 1, caseId: 'never-started', text: 'x' }).runs[0].cases).toEqual({});
    expect(
      apply(s, { type: 'judgment', runId: 1, caseId: 'c9', caseResultId: 1, judge: 'openai', score: 5, cached: false }).runs[0].cases,
    ).toEqual({});
  });

  it('an error ending the session is shown', () => {
    const s = apply(fromDetail(detail()), { type: 'session-end', status: 'error', error: 'Ollama unreachable' });
    expect(s).toMatchObject({ status: 'error', error: 'Ollama unreachable' });
  });
});

describe('execution times', () => {
  const run = (over: Partial<ViewState['runs'][number]>) => ({ ...fromDetail(detail()).runs[0], ...over });
  const state = (over: Partial<ViewState>) => ({ ...fromDetail(detail()), ...over });

  it('runTime: stored when done, ticking while it runs, a dash otherwise', () => {
    expect(runTime(run({ status: 'done', execMs: 65_000 }), T)).toBe('1m 05s');
    expect(runTime(run({ status: 'running', startedAt: T, finishedAt: null }), T + 12_300)).toBe('12.3 s…');
    expect(runTime(run({ status: 'error', startedAt: T }), T + 1)).toBe('–');
  });

  it('sessionTotal: the sum of the runs, live while models work, stored once finished, none while queued', () => {
    const a = run({ id: 1, status: 'done', execMs: 20_000, startedAt: T, finishedAt: T + 25_000 });
    const b = run({ id: 2, status: 'running', startedAt: T + 25_000, finishedAt: null });
    expect(sessionTotal(state({ status: 'running', runs: [a, b] }), T + 35_000)).toEqual({ ms: 30_000, live: true });
    // models done, judges still working: the total stops ticking
    expect(sessionTotal(state({ status: 'running', runs: [a, { ...b, status: 'done', execMs: 10_000 }] }), T + 99_000)).toEqual({
      ms: 30_000,
      live: false,
    });
    expect(sessionTotal(state({ status: 'done', finishedAt: T + 40_000, runs: [a] }), T)).toEqual({ ms: 20_000, live: false });
    // a re-judge reopens a finished session: the stored total stays
    expect(sessionTotal(state({ status: 'running', finishedAt: T + 40_000, runs: [a] }), T + 1e9)).toEqual({ ms: 20_000, live: false });
    expect(sessionTotal(state({ status: 'queued' }), T)).toBeNull();
  });
});

describe('cases and judges', () => {
  const cell = (scores: Record<string, number | null>): CaseCell => ({
    status: 'done',
    output: '',
    checks: [],
    autoScore: null,
    metrics: { latencyMs: 100, tokPerSec: 20 },
    judgments: Object.fromEntries(Object.entries(scores).map(([j, score]) => [j, { score }])),
  });

  it('visibleCaseIds: fixture order, then cases the fixtures no longer have', () => {
    const s = fromDetail(detail());
    s.runs[0].cases = { gone: cell({}), c2: cell({}), c1: cell({}) };
    expect(visibleCaseIds(s)).toEqual(['c1', 'c2', 'gone']);
  });

  it('judgeSpread: the mean, and judges 4+ points apart flagged; missing scores left out', () => {
    expect(judgeSpread(cell({ openai: 9, anthropic: 4, google: null }), ['openai', 'anthropic', 'google'])).toEqual({
      avg: 6.5,
      spread: 5,
    });
    expect(judgeSpread(cell({ openai: 9, anthropic: 4 }), ['openai', 'anthropic']).spread).toBeGreaterThanOrEqual(DISAGREEMENT);
    expect(judgeSpread(cell({ openai: 9 }), ['openai'])).toEqual({ avg: 9, spread: 0 });
    expect(judgeSpread(cell({}), ['openai'])).toEqual({ avg: null, spread: 0 });
  });

  it('avgOf: per-run averages while live, from the cases that have the metric', () => {
    const s = fromDetail(detail());
    s.runs[0].cases = { c1: cell({}), c2: { ...cell({}), metrics: { latencyMs: 300 } } };
    expect(avgOf(s.runs[0], 'latencyMs')).toBe(200);
    expect(avgOf(s.runs[0], 'tokPerSec')).toBe(20);
  });
});
