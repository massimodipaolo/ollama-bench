import 'server-only';
import type { TestDefinition, BaseCase } from '../types';
import { readCases } from '../fixtures';
import { runCheck, type CheckSpec } from '../checks';
import { streamWithMetrics } from '../generate';

interface TextGenCase extends BaseCase {
  prompt: string;
  context?: string;
  system?: string;
  reference?: string;
  checks: CheckSpec[];
}

const buildPrompt = (c: TextGenCase) => (c.context ? `${c.prompt}\n\n---\n${c.context}\n---` : c.prompt);

export const textGeneration: TestDefinition<TextGenCase> = {
  id: 'text-generation',
  name: 'Text generation',
  description: 'Summaries, reasoning, plain-language rewrite, constrained formatting, email, translation, extraction.',
  version: '1',
  requires: ['completion'],
  numCtx: 8192,
  rubric: {
    version: 'tg-1',
    instructions:
      'Evaluate how well the response fulfils the task. Hard constraints stated in the task (counts, word limits, required format, required language) matter: a response that ignores them cannot score above 6. Factual errors or invented facts relative to the provided text are severe.',
    criteria: [
      { name: 'Task fulfilment', description: 'Does it do exactly what was asked, including every explicit constraint?' },
      { name: 'Accuracy', description: 'Facts, numbers and reasoning are correct and consistent with the source text / reference.' },
      { name: 'Language & fluency', description: 'Written in the required language, grammatical, natural, appropriate register.' },
      { name: 'Concision', description: 'No padding, preambles or unrequested content.' },
    ],
  },
  loadCases: (lang) => readCases<TextGenCase>('text-generation', lang),
  run: (ctx, c) => streamWithMetrics(ctx, { system: c.system, prompt: buildPrompt(c), maxOutputTokens: 2048 }),
  check: (c, out, lang) => c.checks.map((s) => runCheck(s, out.output, lang)),
  judgeMaterial: (c, out) => ({ task: c.title, input: buildPrompt(c), reference: c.reference, response: out.output }),
};
