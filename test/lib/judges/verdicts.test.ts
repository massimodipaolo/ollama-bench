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

  // pins the two patterns: thinking aloud counts only as the opening words, talk about the JSON output anywhere
  it.each([
    '  Hmm, the second step is wrong, so accuracy suffers a lot.',
    'Okay, so the answer misses the deadline the question asks for.',
    'The answer is correct. Output only the JSON was the instruction, followed.',
    'Accurate and clear; no text outside the JSON as required by the format.',
  ])('rejects a scratchpad at the start or JSON talk anywhere: %s', (r) => {
    expect(invalidVerdict({ rationale: r, criteria }, rubric)).toBe('judge scratchpad leaked into the rationale');
  });

  it.each([
    'The answer explains the wait times clearly and gets the total right.',
    'Correct total; let me note that the steps are well ordered and clear.',
    'Clear answer, and hmm-style hesitation is absent; the numbers add up.',
  ])('accepts thinking-aloud words that are not the opening: %s', (r) => {
    expect(invalidVerdict({ rationale: r, criteria }, rubric)).toBeNull();
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
