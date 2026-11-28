/**
 * Fake judges: the AI SDK's MockLanguageModelV4 answering scripted verdicts and recording each prompt. Tests install
 * them in place of the configured providers with:
 *
 *   const configured = vi.hoisted(() => ({ judges: [] as Judge[] }));
 *   vi.mock('@/lib/providers', async (importOriginal) => ({ ...(await importOriginal()), judges: () => configured.judges }));
 */
import { MockLanguageModelV4 } from 'ai/test';
import type { Judge } from '@/lib/providers';
import type { Rubric } from '@/lib/tests/types';

/** A verdict as a judge returns it (JSON text): every criterion of `rubric` at `each` unless given per criterion. */
export const verdictFor = (
  rubric: Rubric,
  score: number,
  each: number | number[] = score,
  rationale = 'The answer is correct and states what was asked clearly.',
) =>
  JSON.stringify({
    rationale,
    criteria: rubric.criteria.map((c, i) => ({ name: c.name, comment: 'fine', score: Array.isArray(each) ? each[i] : each })),
    score,
  });

/** A scripted judge: answers from `replies` in order (an Error is thrown), records each prompt. */
export function fakeJudge(id: 'openai' | 'google' | 'anthropic', replies: (string | Error)[], modelId = `${id}-model`) {
  const prompts: unknown[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (opts) => {
      prompts.push(opts.prompt);
      const r = replies.shift() ?? new Error('no reply scripted');
      if (r instanceof Error) throw r;
      return {
        content: [{ type: 'text', text: r }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } },
        warnings: [],
      };
    },
  });
  return { judge: { id, label: id, modelId, model } as Judge, prompts };
}
