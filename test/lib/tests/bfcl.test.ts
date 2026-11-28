/**
 * The BFCL test end to end against the fake Ollama: functions offered as tools (never executed), one step, the call
 * scored by the ported AST checker. Cases are written inline: the real ones come from the downloaded dataset.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getLanguage } from '@/config/languages';
import { chatReply, startFakeOllama } from '../../helpers/fake-ollama';
import { runContext } from '../../helpers/context';

const ollama = await startFakeOllama();
process.env.OLLAMA_HOST = ollama.url;
const { bfcl } = await import('@/lib/tests/bfcl');

afterAll(() => ollama.close());
beforeEach(() => ollama.reset());

const en = getLanguage('en');
const factorial = {
  name: 'math.factorial',
  description: 'Factorial of n',
  parameters: { type: 'dict', properties: { number: { type: 'integer' } }, required: ['number'] },
};
const bfclCase = (category: string, groundTruth: Record<string, Record<string, unknown[]>>[]) => ({
  id: `${category}_1`,
  title: `${category} · ${category}_1`,
  category,
  question: [[{ role: 'user', content: 'What is the factorial of 5?' }]],
  functions: [factorial],
  groundTruth,
});

describe('bfcl', () => {
  it('offers the functions as tools with valid names and JSON schemas, for one step only', async () => {
    ollama.replies.push(chatReply({ toolCalls: [{ name: 'math_factorial', arguments: { number: 5 } }] }));
    const c = bfclCase('simple', [{ 'math.factorial': { number: [5] } }]);
    const out = await bfcl.run(runContext().ctx, c);

    const chats = ollama.calls('/api/chat');
    expect(chats).toHaveLength(1); // the tools have no execute: nothing runs, no second step
    expect(chats[0].body?.tools).toEqual([
      expect.objectContaining({
        function: expect.objectContaining({
          name: 'math_factorial',
          parameters: expect.objectContaining({ type: 'object', required: ['number'] }),
        }),
      }),
    ]);
    expect(out.output).toBe('math_factorial({"number":5})');
    expect(bfcl.check(c, out, en)).toEqual([{ name: 'BFCL simple', pass: true, detail: 'match' }]);
  });

  it('a wrong argument fails with the checker reason', async () => {
    ollama.replies.push(chatReply({ toolCalls: [{ name: 'math_factorial', arguments: { number: 6 } }] }));
    const c = bfclCase('simple', [{ 'math.factorial': { number: [5] } }]);
    const [check] = bfcl.check(c, await bfcl.run(runContext().ctx, c), en);
    expect(check).toMatchObject({ pass: false, detail: '"number" = 6 not in [5]' });
  });

  it('irrelevance: answering in words passes, calling a function fails', async () => {
    const c = bfclCase('irrelevance', []);
    ollama.replies.push(chatReply({ text: 'I cannot help with that using these functions.' }));
    const words = await bfcl.run(runContext().ctx, c);
    expect(bfcl.check(c, words, en)[0]).toMatchObject({ pass: true });
    expect(words.output).toBe('I cannot help with that using these functions.');

    ollama.replies.push(chatReply({ toolCalls: [{ name: 'math_factorial', arguments: { number: 5 } }] }));
    expect(bfcl.check(c, await bfcl.run(runContext().ctx, c), en)[0]).toMatchObject({ pass: false, detail: 'called math_factorial' });
  });

  it('is scored by accuracy only: no judges', () => {
    expect(bfcl.judged).toBe(false);
    expect(bfcl.rubric.criteria).toEqual([]);
  });
});
