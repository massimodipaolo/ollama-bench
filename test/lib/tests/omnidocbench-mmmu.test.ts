/**
 * The two dataset benchmarks that score deterministically: OmniDocBench's metrics (text NED, table cell F1, formula
 * similarity) and MMMU-Pro's answer extraction, plus an MMMU-Pro run against the fake Ollama. Cases are inline: the
 * real ones come from downloaded datasets, which a test must not depend on.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getLanguage } from '@/config/languages';
import { levenshtein, ned, odbChecks } from '@/lib/tests/omnidocbench/metrics';
import { chatReply, startFakeOllama } from '../../helpers/fake-ollama';
import { runContext, testConfig } from '../../helpers/context';

const ollama = await startFakeOllama();
process.env.OLLAMA_HOST = ollama.url;
const { mmmuPro, extractLetter } = await import('@/lib/tests/mmmu-pro');

afterAll(() => ollama.close());
beforeEach(() => ollama.reset());

const en = getLanguage('en');

describe('OmniDocBench metrics', () => {
  it('edit distance and its normalised form', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(ned('abcd', 'abcd')).toBe(0);
    expect(ned('abcd', 'abxd')).toBe(0.25);
    expect(ned('', '')).toBe(0);
  });

  const ref = {
    text: ['Annual Report', 'Revenue grew in every region.'],
    tables: ['<table><tr><th>Region</th><th>Sales</th></tr><tr><td>EU</td><td>120</td></tr></table>'],
    equations: ['$$E = mc^2$$'],
  };

  it('a faithful page passes text, table and formula checks; Markdown tables count like HTML ones', () => {
    const out = '# Annual Report\n\nRevenue grew in every region.\n\n| Region | Sales |\n|---|---|\n| EU | 120 |\n\n$$E = mc^2$$';
    const checks = odbChecks(out, ref);
    expect(checks.map((c) => c.name)).toEqual([
      'clean output (no fences/preamble)',
      'text similarity 100%',
      'table cells F1 100%',
      expect.stringMatching(/^formula similarity/),
    ]);
    expect(checks.filter((c) => !c.pass)).toEqual([]);
  });

  it('missing text, a wrong cell and a missing formula lower their scores', () => {
    const checks = odbChecks('Revenue grew.\n\n<table><tr><td>Region</td><td>Sales</td></tr><tr><td>EU</td><td>99</td></tr></table>', ref);
    const by = (p: string) => checks.find((c) => c.name.startsWith(p))!;
    expect(by('text similarity').pass).toBe(false);
    expect(by('table cells F1').value).toBeCloseTo(0.75);
    expect(by('formula similarity')).toMatchObject({ pass: false, value: 0 });
  });

  it('formulas: spacing is ignored, LaTeX spelling variants are not (1 − NED, a stand-in for CDM)', () => {
    const sim = (eq: string) => odbChecks(eq, { text: [], tables: [], equations: ['$$E = mc^2$$'] }).at(-1)!.value!;
    expect(sim('$$E=mc^2$$')).toBe(1);
    expect(sim('$$E = mc^{2}$$')).toBeCloseTo(0.75); // same formula, different spelling: below the 0.8 pass mark
  });

  it('a fenced or prefaced answer is not clean', () => {
    expect(odbChecks('```markdown\nx\n```', ref)[0].pass).toBe(false);
    expect(odbChecks("Here's the page: x", ref)[0].pass).toBe(false);
  });
});

describe('MMMU-Pro', () => {
  it.each([
    ['Reasoning…\nAnswer: C', 'C'],
    ['Answer: B\n…on second thought\nAnswer: D', 'D'], // the last one wins
    ['answer: **(E)**', 'E'],
    ['Answer：A', 'A'], // full-width colon
    ['B. Because the curve…', 'B'], // direct prompt: a leading letter
    ['(J)', 'J'],
    ['(B) Newton', 'B'],
    ['C', 'C'],
    ['Answer: K', null], // beyond 10 options
    // no "Answer:" line and no real leading letter: wrong, not a guess. Regression: "I"/"A" + space were read as
    // options I/A (letters A–J include the pronoun and the article)
    ['I think the answer is C', null],
    ['A good approach is to compare the slopes.', null],
  ])('extractLetter(%j) = %s', (text, letter) => {
    expect(extractLetter(text, 10)).toBe(letter);
  });

  it('respects the number of options', () => {
    expect(extractLetter('Answer: E', 4)).toBeNull();
  });

  const item = {
    id: 'phys_1',
    title: 'Physics · phys_1',
    subject: 'Physics',
    question: 'Which law relates force and mass?',
    options: ['Ohm', 'Newton', 'Hooke', 'Boyle'],
    answer: 'B',
    images: [],
    visionImage: 'none.png',
  };

  it('standard config: the 10-option prompt with lettered options and the CoT instruction; scored on the letter', async () => {
    ollama.replies.push(chatReply({ text: 'Force equals mass times acceleration.\nAnswer: B' }));
    const out = await mmmuPro.run(runContext().ctx, item);
    const prompt = (ollama.calls('/api/chat')[0].body?.messages as { content: string }[]).at(-1)!.content;
    expect(prompt).toContain('Options:\nA. Ohm\nB. Newton\nC. Hooke\nD. Boyle');
    expect(prompt).toContain("'Answer: $LETTER'");
    expect(mmmuPro.check(item, out, en)).toEqual([{ name: 'correct option (B)', pass: true, detail: 'answered B' }]);
  });

  it('direct prompt: short budget, letter only; an answer without a letter is wrong', async () => {
    ollama.replies.push(chatReply({ text: 'Newton, probably.' }));
    const out = await mmmuPro.run(runContext({ config: { ...testConfig, extra: { config: 'standard-10', prompt: 'direct' } } }).ctx, item);
    expect(ollama.calls('/api/chat')[0].body?.options).toMatchObject({ num_predict: 256 });
    expect(mmmuPro.check(item, out, en)[0]).toMatchObject({ pass: false, detail: 'no answer letter found' });
  });
});
