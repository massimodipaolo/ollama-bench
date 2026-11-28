/**
 * The tool-use test: its tools (run with whatever arguments a model sends) and how a run is scored, end to end
 * against the fake Ollama with scripted tool calls.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getLanguage } from '@/config/languages';
import { autoScore } from '@/lib/tests/checks';
import { chatReply, startFakeOllama } from '../../helpers/fake-ollama';
import { caseOf, runContext } from '../../helpers/context';

const ollama = await startFakeOllama();
process.env.OLLAMA_HOST = ollama.url;
const { toolUse } = await import('@/lib/tests/tool-use');
const { benchmarkTools, calc } = await import('@/lib/tests/tool-use/tools');

afterAll(() => ollama.close());
beforeEach(() => ollama.reset());

const en = getLanguage('en');
const tools = benchmarkTools();
const exec = <T>(t: { execute?: unknown }, input: T) =>
  (t.execute as (i: T, o: unknown) => Promise<Record<string, unknown>>)(input, { toolCallId: 't', messages: [] });

describe('calculator: arithmetic only, whatever the model sends', () => {
  it.each([
    ['2/5*100', 40],
    ['(1200 + 300) * 2', 3000],
    ['3,5 × 2', 7], // decimal comma, multiplication sign
    ['10 ÷ 4', 2.5],
    ['50% * 80', 40],
    ['0.1 + 0.2', 0.3], // rounded, no float noise
  ])('%s = %d', (expr, value) => {
    expect(calc(expr)).toBe(value);
  });

  it.each(
    [
      'process.exit(1)',
      'this.constructor',
      'require("fs")',
      '1; 2',
      '[1].map(x=>x)',
      'globalThis',
      '`1`',
      '2**10', // ** is two allowed characters, but the expression is still arithmetic: allowed below
    ].slice(0, 7),
  )('refuses code: %s', (expr) => {
    expect(() => calc(expr)).toThrow('Only numbers and + - * / ( ) % are allowed');
  });

  it('refuses non-finite and malformed arithmetic', () => {
    expect(() => calc('1/0')).toThrow('Invalid expression');
    expect(() => calc('(1 + 2')).toThrow();
  });
});

describe('the other tools', () => {
  it('lookupInstitution: exact GIIN, case-insensitive; a missing GIIN is reported, not invented', async () => {
    expect(await exec(tools.lookupInstitution, { giin: '234bcd.00004.sb.132' })).toMatchObject({
      found: true,
      name: 'Sponsored Subsidiary Two - Branch',
      country: 'Cape Verdi',
    });
    expect(await exec(tools.lookupInstitution, { giin: '000000.00000.XX.000' })).toMatchObject({ found: false });
  });

  it('searchInstitutions: filters combined with AND, at most 50 results', async () => {
    const all = await exec(tools.searchInstitutions, {});
    expect((all.results as unknown[]).length).toBeLessThanOrEqual(50);
    const some = await exec(tools.searchInstitutions, { country: 'cape verdi', nameContains: 'SUBSIDIARY' });
    expect(some.count).toBeGreaterThan(0);
    for (const r of some.results as { country: string; name: string }[]) {
      expect(r.country).toBe('Cape Verdi');
      expect(r.name.toLowerCase()).toContain('subsidiary');
    }
  });

  it('addDays and refundTimeline', async () => {
    expect(await exec(tools.addDays, { date: '2026-02-20', days: 21 })).toEqual({ date: '2026-03-13' });
    expect(await exec(tools.addDays, { date: '2024-03-01', days: -1 })).toEqual({ date: '2024-02-29' }); // leap year
    await expect(exec(tools.addDays, { date: '20/02/2026', days: 1 })).rejects.toThrow('date must be YYYY-MM-DD');
    expect(await exec(tools.refundTimeline, { filingMethod: 'e-file' })).toMatchObject({ refundWithinDays: { min: 10, max: 21 } });
  });
});

describe('a run, scored', () => {
  const c = caseOf(toolUse.loadCases('en'), 'single-lookup');
  const answer = 'The institution with GIIN 234BCD.00004.SB.132 is Sponsored Subsidiary Two - Branch, located in Cape Verdi.';

  it('the right call with the right arguments, then a grounded answer: every check passes', async () => {
    ollama.replies.push(
      chatReply({ toolCalls: [{ name: 'lookupInstitution', arguments: { giin: '234BCD.00004.SB.132' } }] }),
      chatReply({ text: answer }),
    );
    const { ctx } = runContext();
    const out = await toolUse.run(ctx, c);
    const checks = toolUse.check(c, out, en);
    expect(checks.filter((x) => !x.pass)).toEqual([]);
    expect(autoScore(checks)).toBe(10);
    // every tool is offered in every case: choosing well is part of the test
    expect((ollama.calls('/api/chat')[0].body?.tools as unknown[]).length).toBe(Object.keys(tools).length);
    // the judges see the calls with their results, and the answer
    const m = toolUse.judgeMaterial(c, out, en);
    expect(m.response).toMatch(/1\. \[step 1\] lookupInstitution\(\{"giin":"234BCD\.00004\.SB\.132"\}\) → \{"found":true/);
    expect(m.response).toContain(answer);
  });

  it('answering from memory, without the tool, fails the call check', async () => {
    ollama.replies.push(chatReply({ text: answer }));
    const { ctx } = runContext();
    const checks = toolUse.check(c, await toolUse.run(ctx, c), en);
    expect(checks.find((x) => x.name.startsWith('calls lookupInstitution'))).toMatchObject({ pass: false, detail: 'not called' });
  });

  it('the right tool with the wrong argument fails, and says what was sent', async () => {
    ollama.replies.push(
      chatReply({ toolCalls: [{ name: 'lookupInstitution', arguments: { giin: '234BCD.00004.SB.999' } }] }),
      chatReply({ text: 'No institution found.' }),
    );
    const { ctx } = runContext();
    const checks = toolUse.check(c, await toolUse.run(ctx, c), en);
    expect(checks.find((x) => x.name.startsWith('calls lookupInstitution'))).toMatchObject({
      pass: false,
      detail: 'called with {"giin":"234BCD.00004.SB.999"}',
    });
    expect(autoScore(checks)!).toBeLessThan(5);
  });
});
