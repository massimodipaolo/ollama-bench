/**
 * The structured-output test: the field comparison it scores with, JSON extraction for prompt mode, and runs in both
 * modes against the fake Ollama.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getLanguage } from '@/config/languages';
import { compareObjects, getPath, normDate, stringsMatch } from '@/lib/tests/compare';
import { chatReply, startFakeOllama } from '../../helpers/fake-ollama';
import { caseOf, runContext, testConfig } from '../../helpers/context';

const ollama = await startFakeOllama();
process.env.OLLAMA_HOST = ollama.url;
const { structuredOutput, extractJson } = await import('@/lib/tests/structured-output');

afterAll(() => ollama.close());
beforeEach(() => ollama.reset());

const en = getLanguage('en');

describe('field comparison (compare.ts)', () => {
  it('strings: normalised, alternatives with ||, dates in any common shape, short codes exact', () => {
    expect(stringsMatch('Health Insurance Marketplace Statement', 'health insurance marketplace statement.')).toBe(true);
    expect(stringsMatch('Internal Revenue Service || IRS', 'IRS')).toBe(true);
    expect(stringsMatch('2027-01-31', '1/31/2027')).toBe(true);
    expect(stringsMatch('1095-A', '1095-B')).toBe(false);
    expect(stringsMatch('Città di Roma', 'citta di roma')).toBe(true); // accents
    expect(normDate('2027-1-5')).toBe('2027-01-05');
    expect(normDate('January 31')).toBeNull();
  });

  it('objects: leaf by leaf, decimals with tolerance, arrays of primitives as sets, ignored paths', () => {
    const expected = { a: 'x', rate: 97.5, list: ['one', 'two'], nested: { d: '2026-01-01' }, free: 'anything' };
    const r = compareObjects(
      expected,
      { a: 'X', rate: 97.6, list: ['two', 'one'], nested: { d: '01/01/2026' }, free: 'other' },
      { ignore: ['free'] },
    );
    expect(r).toEqual({ matched: 5, total: 5, mismatches: [] });
    const wrong = compareObjects({ a: 'x', n: 100 }, { a: 'y' });
    expect(wrong.matched).toBe(0);
    expect(wrong.mismatches.map((m) => m.path)).toEqual(['a', 'n']);
    expect(getPath({ a: { b: 1 } }, 'a.b')).toBe(1);
  });

  it('integers (years, counts, whole amounts) match exactly; a numeric string is read as a number', () => {
    expect(compareObjects({ year: 2026 }, { year: 2025 }).matched).toBe(0); // 0.5% of a year would be ±10
    expect(compareObjects({ count: 100 }, { count: 100.2 }).matched).toBe(0);
    expect(compareObjects({ year: 2026, amount: 3500 }, { year: '2026', amount: 3500 }).matched).toBe(2);
    expect(compareObjects({ rate: 97.5 }, { rate: 99 }).matched).toBe(0); // beyond the decimal tolerance
  });
});

describe('extractJson (prompt mode: no constrained decoding)', () => {
  it('finds the object in a fenced block or in prose', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here you go: {"a": {"b": 2}} Hope it helps')).toEqual({ a: { b: 2 } });
    expect(() => extractJson('no json here')).toThrow('no JSON object found');
  });
});

describe('a run, scored', () => {
  const c = caseOf(structuredOutput.loadCases('en'), 'form-basics');
  const perfect = {
    formNumber: '1095-A',
    formTitle: 'Health Insurance Marketplace Statement',
    taxYear: 2026,
    furnishDeadline: '2027-01-31',
    filer: 'Health Insurance Marketplaces',
    excludedPlans: ['catastrophic health plan', 'stand-alone dental plan'],
    summary: 'The form reports enrollments in qualified health plans so that individuals can take the premium tax credit.',
  };

  it('native mode: the schema goes to Ollama, a correct extraction passes every check', async () => {
    ollama.replies.push(chatReply({ text: JSON.stringify(perfect) }));
    const out = await structuredOutput.run(runContext().ctx, c);
    expect(ollama.calls('/api/chat')[0].body?.format).toMatchObject({ type: 'object', required: expect.arrayContaining(['formNumber']) });
    const checks = structuredOutput.check(c, out, en);
    expect(checks.filter((x) => !x.pass)).toEqual([]);
    // 5 scalars + the 2 excluded plans (an array of primitives counts each item)
    expect(checks.map((x) => x.name)).toEqual(['matches schema', 'field accuracy 7/7', 'summary in English']);
  });

  it('wrong values lower field accuracy, with the mismatches named', async () => {
    ollama.replies.push(chatReply({ text: JSON.stringify({ ...perfect, furnishDeadline: '2026-01-31', filer: 'The IRS' }) }));
    const checks = structuredOutput.check(c, await structuredOutput.run(runContext().ctx, c), en);
    const acc = checks.find((x) => x.name.startsWith('field accuracy'))!;
    expect(acc).toMatchObject({ name: 'field accuracy 5/7', pass: false });
    expect(acc.value).toBeCloseTo(5 / 7);
    expect(acc.detail).toContain('furnishDeadline: expected "2027-01-31" got "2026-01-31"');
  });

  // regression: integers used to get the 0.5% tolerance meant for decimals, so 2025 was accepted for a 2026 tax year
  it('a wrong tax year is a mismatch', async () => {
    ollama.replies.push(chatReply({ text: JSON.stringify({ ...perfect, taxYear: 2025 }) }));
    const checks = structuredOutput.check(c, await structuredOutput.run(runContext().ctx, c), en);
    expect(checks.find((x) => x.name.startsWith('field accuracy'))?.name).toBe('field accuracy 6/7');
  });

  it('prompt mode: no schema sent; JSON wrapped in prose is still extracted', async () => {
    ollama.replies.push(chatReply({ text: `Sure! Here is the JSON:\n\`\`\`json\n${JSON.stringify(perfect)}\n\`\`\`` }));
    const { ctx } = runContext({ config: { ...testConfig, extra: { mode: 'prompt' } } });
    const out = await structuredOutput.run(ctx, c);
    expect(ollama.calls('/api/chat')[0].body?.format).toBeUndefined();
    const checks = structuredOutput.check(c, out, en);
    expect(checks[0]).toEqual({ name: 'valid JSON', pass: true });
    expect(checks.filter((x) => !x.pass)).toEqual([]);
  });

  it('prompt mode: no JSON at all scores 0 on fields', async () => {
    ollama.replies.push(chatReply({ text: 'The form is 1095-A.' }));
    const { ctx } = runContext({ config: { ...testConfig, extra: { mode: 'prompt' } } });
    const checks = structuredOutput.check(c, await structuredOutput.run(ctx, c), en);
    expect(checks).toEqual([
      { name: 'valid JSON', pass: false },
      expect.objectContaining({ name: 'matches schema', pass: false }),
      { name: 'field accuracy', pass: false, value: 0, detail: 'no JSON' },
    ]);
  });

  it('a summary in the wrong language fails its language check', async () => {
    ollama.replies.push(
      chatReply({
        text: JSON.stringify({ ...perfect, summary: 'Il modulo serve a dichiarare le iscrizioni ai piani sanitari della persona.' }),
      }),
    );
    const checks = structuredOutput.check(c, await structuredOutput.run(runContext().ctx, c), en);
    expect(checks.find((x) => x.name === 'summary in English')).toMatchObject({ pass: false, detail: 'detected it' });
  });
});
