/**
 * Judging: what a judge is asked, how its verdict is validated, retried, clamped, cached and stored, the flat-verdict
 * fallback without attachments, and re-judging a stored session. The judges are the AI SDK's MockLanguageModelV4
 * (scripted verdicts, prompts recorded) in place of the configured providers: no API keys, no cost.
 */
import type { FilePart } from 'ai';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLanguage } from '@/config/languages';
import { getDb, schema } from '@/db';
import type { Judge } from '@/lib/providers';
import type { JudgeMaterial, Rubric } from '@/lib/tests/types';
import { fakeJudge, verdictFor } from '../../helpers/judges';
import { currentSuite, seedModel, seedRun } from '../../helpers/seed';

/** The judges judges() returns in this file, set per test. */
const configured = vi.hoisted(() => ({ judges: [] as Judge[] }));
vi.mock('@/lib/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/providers')>()),
  judges: () => configured.judges,
}));

const { judgeCaseResult } = await import('@/lib/judges');
const { rejudgeSession } = await import('@/lib/runner');

const en = getLanguage('en');
const rubric: Rubric = {
  version: 'r-1',
  instructions: 'Judge the answer against the reference.',
  criteria: [
    { name: 'Accuracy', description: 'facts are right' },
    { name: 'Clarity', description: 'easy to follow' },
    { name: 'Language', description: 'in English' },
  ],
};
const material: JudgeMaterial = {
  task: 'Summarise the form',
  input: 'Form 1095-A text…',
  reference: 'It reports Marketplace coverage.',
  response: 'It reports coverage.',
};

const verdict = (score: number, each: number | number[] = score, rationale?: string, r: Rubric = rubric) =>
  verdictFor(r, score, each, rationale ?? 'The answer is correct and states the purpose of the form clearly.');

let caseIds: number[];
beforeAll(async () => {
  const run = seedRun({
    modelId: seedModel('m:7b'),
    testId: 'text-generation',
    suiteVersion: await currentSuite('text-generation'),
    at: Date.now(),
    cases: Array<number>(30).fill(1),
  });
  caseIds = run.caseIds;
});
let next = 0;
const freshCase = () => caseIds[next++];
const stored = (caseResultId: number) =>
  getDb().select().from(schema.judgments).where(eq(schema.judgments.caseResultId, caseResultId)).all();
const judgeOne = (caseResultId: number, m: JudgeMaterial = material, enabled = ['openai']) =>
  judgeCaseResult({ caseResultId, rubric, material: m, lang: en, enabled });

beforeEach(() => {
  configured.judges = [];
});

describe('judgeCaseResult', () => {
  it('asks with the rubric, task, input, reference and response; stores the clamped verdict', async () => {
    const j = fakeJudge('openai', [verdict(9.94, [10.6, 8, -1])]);
    configured.judges = [j.judge];
    const id = freshCase();
    const [out] = await judgeOne(id);

    expect(out).toMatchObject({ judge: 'openai', judgeModel: 'openai-model', score: 9.9, cached: false });
    expect(out.criteria!.map((c) => c.score)).toEqual([10, 8, 0]); // clamped to 0–10
    const prompt = JSON.stringify(j.prompts[0]);
    for (const part of [
      'impartial expert evaluator',
      '- Accuracy: facts are right',
      'Summarise the form',
      'Form 1095-A text',
      'It reports Marketplace coverage.',
      'It reports coverage.',
      'Expected response language: English',
    ])
      expect(prompt).toContain(part);
    expect(stored(id)).toEqual([
      expect.objectContaining({ judge: 'openai', score: 9.9, rubricVersion: 'r-1', cached: false, error: null, withoutAttachments: false }),
    ]);
  });

  it('only the enabled judges run, in parallel', async () => {
    const a = fakeJudge('openai', [verdict(8)]);
    const b = fakeJudge('anthropic', [verdict(6)]);
    configured.judges = [a.judge, b.judge, fakeJudge('google', []).judge];
    const out = await judgeOne(freshCase(), { ...material, response: 'enabled-test' }, ['openai', 'anthropic']);
    expect(out.map((o) => [o.judge, o.score])).toEqual([
      ['openai', 8],
      ['anthropic', 6],
    ]);
  });

  it('an identical case is served from the cache: no call, a copy stored as cached', async () => {
    const m = { ...material, response: 'cache-test' };
    const first = fakeJudge('openai', [verdict(7)]);
    configured.judges = [first.judge];
    await judgeOne(freshCase(), m);
    const again = fakeJudge('openai', []);
    configured.judges = [again.judge];
    const id = freshCase();
    const [out] = await judgeOne(id, m);
    expect(again.prompts).toHaveLength(0);
    expect(out).toMatchObject({ score: 7, cached: true });
    expect(stored(id)[0]).toMatchObject({ cached: true, score: 7 });
  });

  it('a different response, rubric version or judge model is not a cache hit', async () => {
    const m = { ...material, response: 'miss-test' };
    configured.judges = [fakeJudge('openai', [verdict(7)]).judge];
    await judgeOne(freshCase(), m);
    for (const variant of [
      () =>
        judgeCaseResult({ caseResultId: freshCase(), rubric, material: { ...m, response: 'miss-test 2' }, lang: en, enabled: ['openai'] }),
      () =>
        judgeCaseResult({ caseResultId: freshCase(), rubric: { ...rubric, version: 'r-2' }, material: m, lang: en, enabled: ['openai'] }),
    ]) {
      const j = fakeJudge('openai', [verdict(5)]);
      configured.judges = [j.judge];
      expect((await variant())[0]).toMatchObject({ score: 5, cached: false });
    }
    const other = fakeJudge('openai', [verdict(4)], 'newer-model');
    configured.judges = [other.judge];
    expect((await judgeOne(freshCase(), m))[0]).toMatchObject({ score: 4, cached: false, judgeModel: 'newer-model' });
  });
});

describe('broken verdicts', () => {
  it('a degenerate verdict is retried, and the retry counts', async () => {
    const j = fakeJudge('openai', [verdict(0, 0, 'Wait—no extra text outside JSON! Fine.'), verdict(8)]);
    configured.judges = [j.judge];
    const [out] = await judgeOne(freshCase(), { ...material, response: 'retry-test' });
    expect(j.prompts).toHaveLength(2);
    expect(out.score).toBe(8);
    expect(out.error).toBeUndefined();
  });

  it('three broken attempts: a judge error, stored with no score (excluded from averages, never a 0)', async () => {
    const missing = JSON.stringify({
      rationale: 'Looks fine overall, nothing to add here.',
      criteria: [{ name: 'Accuracy', comment: '', score: 9 }],
      score: 9,
    });
    configured.judges = [fakeJudge('openai', [missing, missing, missing]).judge];
    const id = freshCase();
    const [out] = await judgeOne(id, { ...material, response: 'broken-test' });
    expect(out.score).toBeNull();
    expect(out.error).toBeTruthy();
    expect(stored(id)[0]).toMatchObject({ score: null, error: expect.any(String) });
  });

  it('API errors are retried too; an answer that is not the verdict JSON fails the same way', async () => {
    configured.judges = [fakeJudge('openai', [new Error('overloaded'), verdict(6)]).judge];
    expect((await judgeOne(freshCase(), { ...material, response: 'api-retry' }))[0].score).toBe(6);
    configured.judges = [fakeJudge('openai', ['not json', 'not json', 'still not json']).judge];
    expect((await judgeOne(freshCase(), { ...material, response: 'api-fail' }))[0]).toMatchObject({ score: null });
  });

  it('a degenerate verdict in the cache is not reused', async () => {
    const m = { ...material, response: 'stale-cache' };
    const id = freshCase();
    configured.judges = [fakeJudge('openai', [verdict(9)]).judge];
    await judgeOne(id, m);
    // corrupt the stored verdict, as one recorded before validation existed
    getDb().update(schema.judgments).set({ criteria: [] }).where(eq(schema.judgments.caseResultId, id)).run();
    const j = fakeJudge('openai', [verdict(7)]);
    configured.judges = [j.judge];
    expect((await judgeOne(freshCase(), m))[0]).toMatchObject({ score: 7, cached: false });
    expect(j.prompts).toHaveLength(1);
  });
});

describe('the flat-verdict fallback (attachments)', () => {
  const image: FilePart = { type: 'file', data: new Uint8Array([0xff, 0xd8, 0xff, 1]), mediaType: 'image/jpeg', filename: 'page.jpg' };
  const withImage = (response: string): JudgeMaterial => ({ ...material, response, attachments: [image] });
  const hasFile = (prompt: unknown) => JSON.stringify(prompt).includes('"type":"file"');

  it('with an attachment, a flat mid-scale verdict is re-asked without the file and marked', async () => {
    const j = fakeJudge('google', [verdict(7, 7), verdict(9.5, [10, 9, 9])]);
    configured.judges = [j.judge];
    const id = freshCase();
    const [out] = await judgeCaseResult({ caseResultId: id, rubric, material: withImage('flat-test'), lang: en, enabled: ['google'] });
    expect(hasFile(j.prompts[0])).toBe(true);
    expect(hasFile(j.prompts[1])).toBe(false);
    expect(out).toMatchObject({ score: 9.5, withoutAttachments: true });
    expect(stored(id)[0].withoutAttachments).toBe(true);
  });

  it('without attachments, the same flat verdict is kept', async () => {
    const j = fakeJudge('google', [verdict(7, 7)]);
    configured.judges = [j.judge];
    const [out] = await judgeCaseResult({
      caseResultId: freshCase(),
      rubric,
      material: { ...material, response: 'flat-no-file' },
      lang: en,
      enabled: ['google'],
    });
    expect(j.prompts).toHaveLength(1);
    expect(out).toMatchObject({ score: 7, withoutAttachments: false });
  });
});

describe('rejudgeSession', () => {
  it('replaces only the chosen judge on the chosen cases, re-aggregates the run, keeps the session judge list', async () => {
    const tg = await currentSuite('text-generation');
    const test = (await import('@/lib/tests/registry')).getTest('text-generation');
    const fixtureIds = test
      .loadCases('en')
      .slice(0, 2)
      .map((c) => c.id);
    const {
      sessionId,
      runId,
      caseIds: crs,
    } = seedRun({
      modelId: seedModel('r:7b'),
      testId: 'text-generation',
      suiteVersion: tg,
      at: Date.now(),
      cases: [1, 1],
      caseIds: fixtureIds,
      config: { judges: ['openai', 'anthropic'] },
    });
    const db = getDb();
    for (const cr of crs)
      for (const [judge, score] of [
        ['openai', 2],
        ['anthropic', 6],
      ] as const)
        db.insert(schema.judgments)
          .values({ caseResultId: cr, judge, judgeModel: 'old', rubricVersion: 'x', cacheKey: `k-${cr}-${judge}`, score })
          .run();

    // re-judging uses the test's own rubric: the verdict must name its criteria
    const fresh = fakeJudge('openai', [verdict(8, 8, undefined, test.rubric)]);
    configured.judges = [fresh.judge, fakeJudge('anthropic', []).judge];
    await rejudgeSession(sessionId, ['openai'], [crs[0]]);

    const byCase = (cr: number) => Object.fromEntries(stored(cr).map((j) => [j.judge, j.score]));
    expect(byCase(crs[0])).toEqual({ openai: 8, anthropic: 6 }); // only openai on the first case was replaced
    expect(byCase(crs[1])).toEqual({ openai: 2, anthropic: 6 });
    const run = db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get()!;
    expect(run.judgeScores).toEqual({ openai: 5, anthropic: 6 }); // (8 + 2) / 2
    expect(run.judgeAvg).toBe(5.5);
    expect(db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get()!.config.judges).toEqual([
      'openai',
      'anthropic',
    ]);
  });

  it('refuses an unknown session', async () => {
    await expect(rejudgeSession('nope')).rejects.toThrow('Session not found');
  });
});
