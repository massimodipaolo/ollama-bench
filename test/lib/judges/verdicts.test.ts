// Degenerate judge verdicts: retried, then stored as judge errors (never counted as a 0).
import { describe, expect, it } from 'vitest';
import { flatVerdict, invalidVerdict } from '@/lib/judges';
import type { Rubric } from '@/lib/tests/types';

const rubric = {
  instructions: 'Judge the answer.',
  criteria: [
    { name: 'accuracy', description: 'facts are right' },
    { name: 'clarity', description: 'easy to follow' },
  ],
} as Rubric;

const rationale = 'The answer states the correct total and explains each step clearly.';
const criteria = [
  { name: 'accuracy', comment: 'right', score: 9 },
  { name: 'clarity', comment: 'clear', score: 8 },
];

describe('invalidVerdict', () => {
  it('accepts a complete verdict', () => {
    expect(invalidVerdict({ rationale, criteria }, rubric)).toBeNull();
  });

  it('rejects missing criteria, by name', () => {
    expect(invalidVerdict({ rationale, criteria: criteria.slice(0, 1) }, rubric)).toBe('missing criteria: clarity');
    expect(invalidVerdict({ rationale, criteria: [] }, rubric)).toBe('missing criteria: accuracy, clarity');
  });

  it('rejects an empty or token rationale', () => {
    expect(invalidVerdict({ rationale: '  ok  ', criteria }, rubric)).toBe('rationale missing or too short');
  });

  it.each([
    'Wait—no extra text outside JSON! The answer is fine overall.',
    'Let me check the numbers again before scoring this answer.',
    'Here is the JSON with the evaluation you asked for, complete.',
  ])('rejects a leaked judge scratchpad: %s', (r) => {
    expect(invalidVerdict({ rationale: r, criteria }, rubric)).toBe('judge scratchpad leaked into the rationale');
  });
});

describe('flatVerdict', () => {
  const flat = (score: number, n = 3) => ({ criteria: Array.from({ length: n }, (_, i) => ({ name: `c${i}`, comment: '', score })) });

  it('every criterion the same mid-scale score (the Gemini "flat 7")', () => {
    expect(flatVerdict(flat(7))).toBe(true);
  });

  it('not flat: extremes, too few criteria, or differing scores', () => {
    expect(flatVerdict(flat(10))).toBe(false);
    expect(flatVerdict(flat(2))).toBe(false);
    expect(flatVerdict(flat(7, 2))).toBe(false);
    expect(flatVerdict({ criteria: [...flat(7).criteria, { name: 'x', comment: '', score: 8 }] })).toBe(false);
  });
});
