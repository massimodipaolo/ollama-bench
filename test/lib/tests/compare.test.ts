// The field comparison behind structured output and tool-call arguments: arrays, keys, types, and what counts.
import { describe, expect, it } from 'vitest';
import { compareObjects, normStr, stringsMatch } from '@/lib/tests/compare';

describe('compareObjects', () => {
  const rows = [
    { giin: 'A1', name: 'Alpha Bank', country: 'Italy' },
    { giin: 'B2', name: 'Beta Trust', country: 'France' },
  ];

  it('arrays of objects: aligned by a key when given (order does not matter), by position otherwise', () => {
    const reordered = [rows[1], rows[0]];
    expect(compareObjects({ items: rows }, { items: reordered }, { arrayKeys: { items: 'giin' } })).toMatchObject({ matched: 6, total: 6 });
    expect(compareObjects({ items: rows }, { items: reordered }).matched).toBe(0); // positional: every field differs
  });

  it('a missing row costs all its fields; an extra row costs one', () => {
    const missing = compareObjects({ items: rows }, { items: [rows[0]] }, { arrayKeys: { items: 'giin' } });
    expect(missing).toMatchObject({ matched: 3, total: 6 });
    const extra = compareObjects({ items: rows }, { items: [...rows, { giin: 'C3' }] }, { arrayKeys: { items: 'giin' } });
    expect(extra).toMatchObject({ matched: 6, total: 7 });
    expect(extra.mismatches).toEqual([{ path: 'items[]', expected: undefined, actual: { giin: 'C3' } }]);
  });

  it('primitive arrays: a set; extra items count as errors', () => {
    expect(compareObjects({ tags: ['a', 'b'] }, { tags: ['b', 'a', 'c'] })).toMatchObject({ matched: 2, total: 3 });
    expect(compareObjects({ tags: ['a'] }, { tags: 'a' })).toMatchObject({ matched: 0, total: 1 }); // not an array
  });

  it('an object replaced by a scalar costs all its fields; a non-object root is reported as (root)', () => {
    expect(compareObjects({ filingPeriod: { start: '2026-01-01', end: '2026-12-31' } }, { filingPeriod: '2026' })).toMatchObject({
      matched: 0,
      total: 2,
    });
    expect(compareObjects({ a: 1, b: 2 }, null).mismatches).toEqual([{ path: '(root)', expected: { a: 1, b: 2 }, actual: null }]);
  });

  it('booleans accept "true"/"false" strings; null accepts null, missing or empty', () => {
    expect(compareObjects({ ok: true }, { ok: 'TRUE' }).matched).toBe(1);
    expect(compareObjects({ ok: false }, { ok: 0 }).matched).toBe(0);
    expect(compareObjects({ a: null, b: null, c: null }, { a: null, c: '' }).matched).toBe(3);
    expect(compareObjects({ a: null }, { a: 'x' }).matched).toBe(0);
  });

  it('a number given as a string, with a decimal comma', () => {
    expect(compareObjects({ rate: 97.5 }, { rate: '97,5' }).matched).toBe(1);
    expect(compareObjects({ rate: 97.5 }, { rate: 'about 97' }).matched).toBe(0);
  });
});

describe('stringsMatch', () => {
  it('normalises case, accents, quotes and trailing punctuation', () => {
    expect(normStr('  L’Équipe Fédérale.  ')).toBe("l'equipe federale");
  });

  it('long values: most tokens in common, or every expected token in a slightly longer answer', () => {
    expect(stringsMatch('Statistics of Income Division', 'the Statistics of Income (SOI) Division')).toBe(true);
    // every expected token, in an answer up to 4× longer (distinct tokens): a verbatim copy with qualifiers
    expect(stringsMatch('Health Insurance Marketplaces', 'Health Insurance Marketplaces and state-based exchanges run by states')).toBe(
      true,
    );
    // beyond that it's no longer the same value
    expect(
      stringsMatch(
        'Health Insurance Marketplaces',
        'Health Insurance Marketplaces, federal and state exchanges, brokers, agents, navigators, insurers, employers, regulators, auditors and partners',
      ),
    ).toBe(false);
    expect(stringsMatch('premium tax credit', 'advance credit payments')).toBe(false);
    expect(stringsMatch('anything', '')).toBe(false);
  });

  it('short codes (GIINs, postal codes) must match exactly', () => {
    expect(stringsMatch('98Q96B.00000.LE.250', '98Q96B.00000.LE.250')).toBe(true);
    expect(stringsMatch('NY', 'NJ')).toBe(false);
  });
});
