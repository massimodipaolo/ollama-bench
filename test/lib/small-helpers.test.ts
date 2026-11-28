// Small pure helpers used across the UI and the leaderboards.
import { describe, expect, it } from 'vitest';
import { inTier, paramsB, parseTier, tierOf } from '@/lib/tiers';
import { normalizeMath } from '@/lib/markdown-math';
import { runExecMs, sessionExecMs } from '@/lib/timing';
import { fmtDuration, fmtMs } from '@/components/score';

describe('tiers', () => {
  it.each([
    ['566.70M', 0.5667],
    ['8.8B', 8.8],
    ['123.6B', 123.6],
    ['1.2T', 1200],
    ['7', 7],
  ])('paramsB(%s)', (size, b) => {
    expect(paramsB(size)).toBeCloseTo(b);
  });

  it('size tiers, with unknown sizes (remote baselines) visible in every tier', () => {
    expect(tierOf('8.8B')).toBe('small');
    expect(tierOf('10B')).toBe('medium');
    expect(tierOf('50B')).toBe('medium');
    expect(tierOf('70B')).toBe('large');
    expect(tierOf(null)).toBeNull();
    expect(inTier(null, 'large')).toBe(true);
    expect(inTier('70B', 'small')).toBe(false);
    expect(parseTier('bogus')).toBe('all');
  });
});

describe('normalizeMath', () => {
  it('turns \\( \\) and \\[ \\] into remark-math delimiters', () => {
    expect(normalizeMath('area \\(\\pi r^2\\)')).toBe('area $\\pi r^2$');
    expect(normalizeMath('\\[x = 1\\]')).toBe('\n$$\nx = 1\n$$\n');
  });

  it('escapes dollar amounts, keeps math', () => {
    expect(normalizeMath('costs $5 and $1,200.50.')).toBe('costs \\$5 and \\$1,200.50.');
    expect(normalizeMath('$2^n$ grows')).toBe('$2^n$ grows');
  });

  it('leaves code untouched', () => {
    const md = '`$5` and\n```\n\\(x\\) $5\n```';
    expect(normalizeMath(md)).toBe(md);
  });
});

describe('execution times', () => {
  const done = { status: 'done', startedAt: 1_000, finishedAt: 61_000 };

  it('a run: the measured time, else start → end; only for completed runs', () => {
    expect(runExecMs({ ...done, execMs: 42_000 })).toBe(42_000);
    expect(runExecMs(done)).toBe(60_000);
    expect(runExecMs({ ...done, status: 'error' })).toBeNull();
    expect(runExecMs({ status: 'done', startedAt: null, finishedAt: null })).toBeNull();
  });

  it('a session: the sum of its completed runs (judging and queueing excluded)', () => {
    const runs = [
      { ...done, execMs: 10_000 },
      { ...done, execMs: 5_000 },
      { status: 'error', startedAt: 1, finishedAt: 2, execMs: 99 },
    ];
    expect(sessionExecMs({ status: 'done' }, runs)).toBe(15_000);
    expect(sessionExecMs({ status: 'cancelled' }, runs)).toBe(15_000);
    expect(sessionExecMs({ status: 'running' }, runs)).toBeNull();
    expect(sessionExecMs({ status: 'done' }, [])).toBeNull();
  });

  it('formats durations from milliseconds to hours', () => {
    expect(fmtMs(850)).toBe('850 ms');
    expect(fmtDuration(null)).toBe('–');
    expect(fmtDuration(12_345)).toBe('12.3 s');
    expect(fmtDuration(245_000)).toBe('4m 05s');
    expect(fmtDuration(7_380_000)).toBe('2h 03m');
  });
});
