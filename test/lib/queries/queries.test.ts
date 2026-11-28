/**
 * The queries behind the pages (dashboard leaderboards, capability views, model list, comparison, active sessions,
 * batches), on a small hand-made history written straight into the test database (test/helpers/seed.ts).
 */
import { inArray } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb, schema } from '@/db';
import {
  activeSessions,
  capabilityBoard,
  capabilityOverview,
  compareModels,
  getBatchDetail,
  getSessionDetail,
  leaderboard,
  modelIndex,
  runRows,
} from '@/lib/queries';
import { getTest } from '@/lib/tests/registry';
import { currentSuite, seedBatch, seedModel, seedRun } from '../../helpers/seed';

const T = 1_800_000_000_000; // a fixed "now"
const min = 60_000;

let X: number, X2: number, Y: number, Z: number;
let xJudged: { sessionId: string; runId: number; caseIds: number[] };

beforeAll(async () => {
  const tg = await currentSuite('text-generation');
  const so = await currentSuite('structured-output');
  X = seedModel('xmodel:8b', { lastSeen: T });
  X2 = seedModel('xmodel:8b', { digest: 'sha256:repulled', lastSeen: T + 1 }); // re-pulled: a second digest
  Y = seedModel('ymodel:8b');
  Z = seedModel('zmodel:70b', { parameterSize: '70B' });
  seedModel('embed:1b', { capabilities: ['embedding'], parameterSize: '0.6B' });

  // X: judged 8 on text generation, then a later unjudged run with a higher automatic score
  xJudged = seedRun({
    modelId: X,
    testId: 'text-generation',
    suiteVersion: tg,
    at: T,
    judgeAvg: 8,
    autoScore: 7,
    avgTokPerSec: 40,
    execMs: 60_000,
    cases: [10_000, 20_000],
  });
  seedRun({ modelId: X, testId: 'text-generation', suiteVersion: tg, at: T + 10 * min, autoScore: 9.5, avgTokPerSec: 42 });
  seedRun({
    modelId: X2,
    testId: 'structured-output',
    suiteVersion: so,
    at: T + 20 * min,
    judgeAvg: 7,
    autoScore: 8,
    avgTokPerSec: 30,
    execMs: 9_000,
    cases: [5_000],
  });
  seedRun({ modelId: X, testId: 'text-generation', suiteVersion: tg, lang: 'it', at: T + 30 * min, judgeAvg: 6 });
  // Y: best on text generation, timed before cases were (no exec_ms): start → end − load, over 2 cases
  seedRun({
    modelId: Y,
    testId: 'text-generation',
    suiteVersion: tg,
    at: T + 40 * min,
    judgeAvg: 9,
    avgTokPerSec: 50,
    startedAt: T,
    finishedAt: T + 61_000,
    loadMs: 1_000,
    cases: [null, null],
  });
  seedRun({ modelId: Y, testId: 'structured-output', suiteVersion: so, at: T + 50 * min, status: 'error', sessionStatus: 'error' });
  // Z: a non-default context, and a result from an older suite version
  seedRun({ modelId: Z, testId: 'text-generation', suiteVersion: tg, at: T + 60 * min, judgeAvg: 5, config: { numCtx: 32768 } });
  seedRun({ modelId: Z, testId: 'structured-output', suiteVersion: 'old-suite', at: T + 70 * min, judgeAvg: 9.5 });
  // a test that no longer exists (e.g. the removed Polyglot test): kept in the DB, never shown
  seedRun({ modelId: X, testId: 'polyglot', suiteVersion: 'x', at: T + 80 * min, judgeAvg: 10 });
});

describe('leaderboard (per test)', () => {
  it('one row per model, language and variant: the latest judged run, the others counted', () => {
    const rows = leaderboard('text-generation');
    expect(rows.map((r) => [r.lang, r.model, r.variant, r.judgeAvg ?? r.autoScore, r.runs])).toEqual([
      ['en', 'ymodel:8b', '', 9, 1],
      ['en', 'xmodel:8b', '', 8, 2], // judged 8 beats the later unjudged 9.5
      ['en', 'zmodel:70b', 'num_ctx=32768', 5, 1],
      ['it', 'xmodel:8b', '', 6, 1],
    ]);
    const x = rows.find((r) => r.model === 'xmodel:8b' && r.lang === 'en')!;
    expect(x).toMatchObject({ execMs: 60_000, subset: 'quick', numCtx: null, runId: xJudged.runId });
    expect(rows.find((r) => r.model === 'zmodel:70b')!.numCtx).toBe(32768);
  });

  it('filters by language, and leaves out failed runs', () => {
    expect(leaderboard('text-generation', 'it').map((r) => r.model)).toEqual(['xmodel:8b']);
    expect(
      leaderboard('structured-output')
        .map((r) => r.model)
        .sort(),
    ).toEqual(['xmodel:8b', 'zmodel:70b']); // Y errored
  });
});

describe('runRows (history, CSV, the CLI)', () => {
  it('completed runs of known tests only, unless asked for unfinished ones', () => {
    expect(runRows()).toHaveLength(7); // 9 seeded: one failed, one of a removed test
    expect(runRows({ includeUnfinished: true })).toHaveLength(8);
    expect(runRows({ model: 'ymodel:8b' }).map((r) => r.testId)).toEqual(['text-generation']);
    expect(runRows({ testId: 'polyglot' })).toHaveLength(1); // still reachable by its id
  });

  it('carries the variant, the run execution time (or its start → end fallback) and oldest-first order', () => {
    const rows = runRows({ testId: 'text-generation' });
    expect(rows.map((r) => r.date)).toEqual([...rows.map((r) => r.date)].sort((a, b) => a - b));
    expect(rows.find((r) => r.model === 'zmodel:70b')!.variant).toBe('num_ctx=32768');
    expect(rows.find((r) => r.runId === xJudged.runId)!.execMs).toBe(60_000);
    expect(rows.find((r) => r.model === 'ymodel:8b')!.execMs).toBe(61_000);
  });
});

describe('modelIndex (the models page)', () => {
  it('groups digests by name, counts runs and tests, most recently run first', () => {
    const idx = modelIndex();
    expect(idx.map((m) => [m.name, m.digests, m.runs, m.tests])).toEqual([
      ['zmodel:70b', 1, 2, 2],
      ['ymodel:8b', 1, 1, 1],
      ['xmodel:8b', 2, 4, 2], // the removed test is not counted
      ['embed:1b', 1, 0, 0],
    ]);
    expect(idx.find((m) => m.name === 'embed:1b')!.lastRunAt).toBeNull();
  });
});

describe('capability board and overview', () => {
  it('scores a model by the mean of its current results; ranks only models with every test they can take', async () => {
    const board = (await capabilityBoard('text', 'en'))!;
    expect(board.tests.filter((t) => t.hasResults).map((t) => t.id)).toEqual(['text-generation', 'structured-output']);
    const row = (m: string) => board.rows.find((r) => r.model === m)!;
    expect(board.rows.map((r) => r.model)).toEqual(['xmodel:8b', 'ymodel:8b', 'zmodel:70b']); // ranked first
    expect(row('xmodel:8b')).toMatchObject({ score: 7.5, covered: 2, required: 2, ranked: true, avgTokPerSec: 35 });
    expect(row('ymodel:8b')).toMatchObject({ score: 9, covered: 1, required: 2, ranked: false });
    // Z: the older-suite result is shown as stale and not counted
    expect(row('zmodel:70b')).toMatchObject({ score: 5, covered: 1, ranked: false });
    expect(row('zmodel:70b').cells['structured-output']).toMatchObject({ stale: true, score: 9.5 });
    expect(row('zmodel:70b').cells['text-generation']).toMatchObject({ variant: 'num_ctx=32768', numCtx: 32768 });
  });

  it('size tiers filter the rows', async () => {
    expect((await capabilityBoard('text', 'en', 'small'))!.rows.map((r) => r.model)).toEqual(['xmodel:8b', 'ymodel:8b']);
    expect((await capabilityBoard('text', 'en', 'large'))!.rows.map((r) => r.model)).toEqual(['zmodel:70b']);
    expect(await capabilityBoard('nope', 'en')).toBeNull();
  });

  it('overview: the overall score is the mean of the ranked capabilities only', async () => {
    const ov = await capabilityOverview('en');
    expect(ov.map((r) => [r.model, r.overall, r.overallOf])).toEqual([
      ['xmodel:8b', 7.5, ['Text']],
      ['ymodel:8b', null, []],
      ['zmodel:70b', null, []],
    ]);
    expect(ov[0].avgTokPerSec).toBe(35);
    expect(ov[0].scores.text).toEqual({ score: 7.5, ranked: true, covered: 2, required: 2 });
  });
});

describe('compareModels', () => {
  it('per test and capability: scores, tokens/s and the average case time (measured, or estimated for older runs)', async () => {
    const cmp = (await compareModels('xmodel:8b', 'ymodel:8b', 'en'))!;
    const tg = cmp.tests.find((t) => t.id === 'text-generation')!;
    expect(tg.a?.score).toBe(8);
    expect(tg.b?.score).toBe(9);
    expect(tg.speed.a).toEqual({ tokPerSec: 40, caseMs: 15_000, approx: false }); // mean of the measured cases
    expect(tg.speed.b).toEqual({ tokPerSec: 50, caseMs: 30_000, approx: true }); // (61 s − 1 s load) / 2 cases
    const text = cmp.capabilities.find((c) => c.id === 'text')!;
    expect(text.speed.a).toEqual({ tokPerSec: 35, caseMs: 10_000, approx: false }); // mean over its tests
    expect(text.a).toMatchObject({ score: 7.5, ranked: true });
  });

  it('history: every run of either model per test, language and variant, shared tests first', async () => {
    const cmp = (await compareModels('xmodel:8b', 'ymodel:8b', 'en'))!;
    expect(cmp.history[0]).toMatchObject({ key: 'text-generation|en|' });
    expect(cmp.history[0].a.map((p) => p.score)).toEqual([8, 9.5]);
    expect(cmp.history[0].b.map((p) => p.score)).toEqual([9]);
    expect(cmp.history.map((h) => h.key)).toContain('text-generation|it|');
    expect(cmp.commonCapabilities).toEqual(['completion']);
  });

  it('null for a model never benchmarked', async () => {
    expect(await compareModels('xmodel:8b', 'ghost:1b', 'en')).toBeNull();
  });
});

describe('active sessions, batches, session detail', () => {
  it('activeSessions: queued and running, oldest first, with case progress', async () => {
    const tg = await currentSuite('text-generation');
    const quick = getTest('text-generation')
      .loadCases('en')
      .filter((c) => c.quick).length;
    const running = seedRun({
      modelId: X,
      testId: 'text-generation',
      suiteVersion: tg,
      at: T + 100 * min,
      status: 'running',
      cases: [1_000],
    });
    const queued = seedRun({ modelId: Y, testId: 'text-generation', suiteVersion: tg, at: T + 101 * min, status: 'queued' });
    const active = activeSessions();
    expect(active.map((s) => [s.id, s.status, s.done, s.total])).toEqual([
      [running.sessionId, 'running', 1, quick],
      [queued.sessionId, 'queued', 0, quick],
    ]);
    // don't leak into the other tests (deleting a session cascades to its runs and case results)
    getDb()
      .delete(schema.sessions)
      .where(inArray(schema.sessions.id, [running.sessionId, queued.sessionId]))
      .run();
  });

  it.each([
    [['done', 'running'], 'running'],
    [['queued', 'queued'], 'queued'],
    [['done', 'queued'], 'running'], // started, more to come
    [['done', 'error'], 'error'],
    [['done', 'cancelled'], 'cancelled'],
    [['done', 'done'], 'done'],
  ] as const)('batch status from its sessions %j → %s', async (statuses, expected) => {
    const id = `b-${statuses.join('-')}`;
    seedBatch(id);
    const tg = await currentSuite('text-generation');
    for (const [i, s] of statuses.entries())
      seedRun({
        modelId: X,
        testId: 'text-generation',
        suiteVersion: tg,
        at: T + i,
        status: s === 'cancelled' ? 'error' : s === 'queued' || s === 'running' ? s : 'done',
        sessionStatus: s,
        batchId: id,
        judgeAvg: 7,
      });
    const b = getBatchDetail(id)!;
    expect(b.status).toBe(expected);
    expect(b.sessions).toHaveLength(statuses.length);
    expect(b.cells['xmodel:8b']['text-generation']).toBeDefined();
  });

  it('getSessionDetail: runs with their model and cases with their judgments', () => {
    getDb()
      .insert(schema.judgments)
      .values({ caseResultId: xJudged.caseIds[0], judge: 'openai', judgeModel: 'gpt', rubricVersion: 'r', cacheKey: 'k', score: 8 })
      .run();
    const d = getSessionDetail(xJudged.sessionId)!;
    expect(d.runs[0].model.name).toBe('xmodel:8b');
    expect(d.runs[0].cases).toHaveLength(2);
    expect(d.runs[0].cases[0].judgments).toEqual([expect.objectContaining({ judge: 'openai', score: 8 })]);
    expect(getSessionDetail('nope')).toBeNull();
  });
});
