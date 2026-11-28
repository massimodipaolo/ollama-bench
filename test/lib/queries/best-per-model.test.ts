// Which result represents a model on the dashboard (one row per model name).
import { describe, expect, it } from 'vitest';
import { bestPerModel, type LeaderboardRow } from '@/lib/queries';

let id = 0;
function row(model: string, p: Partial<LeaderboardRow> = {}): LeaderboardRow {
  id++;
  return {
    modelId: id,
    sessionId: `s${id}`,
    runId: id,
    suiteVersion: 'v2',
    capabilities: ['completion'],
    lang: 'en',
    variant: '',
    model,
    provider: 'ollama',
    digest: 'abc',
    quantization: 'Q4_K_M',
    parameterSize: '8B',
    runs: 1,
    lastRunAt: id,
    judgeScores: {},
    judgeAvg: null,
    autoScore: null,
    avgTokPerSec: null,
    avgLatencyMs: null,
    execMs: null,
    subset: 'quick',
    numCtx: null,
    ...p,
  };
}

const pick = (rows: LeaderboardRow[]) => bestPerModel(rows, 'v2');

describe('bestPerModel', () => {
  it('keeps one row per model name and counts the folded ones', () => {
    const out = pick([row('a', { judgeAvg: 7 }), row('a', { judgeAvg: 8, lang: 'it' }), row('b', { judgeAvg: 6 })]);
    expect(out.map((r) => [r.model, r.judgeAvg, r.others])).toEqual([
      ['a', 8, 1],
      ['b', 6, 0],
    ]);
  });

  it('the current suite version beats a higher score on an older one', () => {
    const [best] = pick([row('a', { judgeAvg: 9.5, suiteVersion: 'v1' }), row('a', { judgeAvg: 6 })]);
    expect(best.judgeAvg).toBe(6);
  });

  it('a judged result beats an unjudged one, whatever the automatic score', () => {
    const [best] = pick([row('a', { autoScore: 10 }), row('a', { judgeAvg: 5, autoScore: 4 })]);
    expect(best.judgeAvg).toBe(5);
  });

  it('on equal score the most recent wins', () => {
    const older = row('a', { judgeAvg: 7, lastRunAt: 1 });
    const newer = row('a', { judgeAvg: 7, lastRunAt: 2 });
    expect(pick([older, newer])[0].sessionId).toBe(newer.sessionId);
  });

  it('sorts best first, remote baselines last whatever their score', () => {
    const out = pick([row('cohere', { provider: 'cohere', judgeAvg: 10 }), row('low', { judgeAvg: 3 }), row('high', { autoScore: 9 })]);
    expect(out.map((r) => r.model)).toEqual(['high', 'low', 'cohere']);
  });
});
