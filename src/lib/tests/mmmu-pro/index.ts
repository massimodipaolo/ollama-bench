import 'server-only';
import fs from 'node:fs';
import type { FilePart, TextPart } from 'ai';
import type { TestDefinition, BaseCase } from '../types';
import { runStream, toCaseOutput } from '../generate';
import { datasetCases, datasetLanguages, datasetPath } from '../datasets';
import { mediaTypeOf } from '@/lib/files/file-part';

/**
 * MMMU-Pro (multimodal multiple choice, 10 options). Configs: "standard" (question + options as text, images
 * attached) and "vision" (question and options exist only inside a screenshot). Metric: accuracy (deterministic).
 * Prompts follow the MMMU-Pro paper (CoT: "Answer: $LETTER" on the last line; direct: letter only).
 * Difference from the official scorer: an unparseable answer counts as wrong (the official code picks a random letter).
 */
interface MmmuCase extends BaseCase {
  subject: string;
  question: string;
  options: string[];
  answer: string;
  images: string[];
  visionImage: string;
}

interface MmmuData {
  predicted: string | null;
  answer: string;
  config: string;
}

const LETTERS = 'ABCDEFGHIJ'.split('');
const COT =
  "Answer the following multiple-choice question. The last line of your response should be of the following format: 'Answer: $LETTER' (without quotes) where LETTER is one of options. Think step by step before answering.";
const DIRECT = 'Answer with the option letter from the given choices directly.';
const VISION_COT =
  "Write out the multiple-choice question in the image and then solve it. The last line of your response should be of the following format: 'Answer: $LETTER' (without quotes) where LETTER is one of options. Think step by step before answering.";
const VISION_DIRECT =
  "Answer with the option letter from the given choices directly. The last line of your response should be of the following format: 'Answer: $LETTER' (without quotes) where LETTER is one of options.";

function imagePart(file: string): FilePart {
  return {
    type: 'file',
    data: new Uint8Array(fs.readFileSync(datasetPath('mmmu-pro', 'images', file))),
    mediaType: mediaTypeOf(file),
    filename: file,
  };
}

/** The single user message for a case, per the session's options (shared by run() and the prompt preview). */
function userContent(c: MmmuCase, extra: Record<string, unknown> | undefined): (FilePart | TextPart)[] {
  const cot = (extra?.prompt ?? 'cot') === 'cot';
  if (extra?.config === 'vision') return [imagePart(c.visionImage), { type: 'text', text: cot ? VISION_COT : VISION_DIRECT }];
  const options = c.options.map((o, i) => `${LETTERS[i]}. ${o}`).join('\n');
  return [...c.images.map(imagePart), { type: 'text', text: `${c.question}\n\nOptions:\n${options}\n\n${cot ? COT : DIRECT}` }];
}

/** "Answer: C" (last occurrence) → C; for direct prompts also a bare leading letter. */
export function extractLetter(text: string, n: number): string | null {
  const valid = LETTERS.slice(0, n).join('');
  const all = [...text.matchAll(new RegExp(`answer\\s*[:：]\\s*\\**\\s*\\(?([${valid}])\\)?\\b`, 'gi'))];
  if (all.length) return all[all.length - 1][1].toUpperCase();
  const t = text.trim().replace(/^\**|\**$/g, '');
  // a leading "(B)", or "B" followed by . ) : or nothing. Not by a space: with 10 options (A–J) the words "I" and "A"
  // are letters, and "I think…" or "A good approach…" are not answers
  const lead = t.match(new RegExp(`^(?:\\(([${valid}])\\)|([${valid}])(?:[.):]|$))`));
  return lead ? (lead[1] ?? lead[2]) : null;
}

export const mmmuPro: TestDefinition<MmmuCase> = {
  id: 'mmmu-pro',
  name: 'MMMU-Pro (multimodal reasoning)',
  description:
    'Expert-level multimodal multiple choice with 10 options, one item per subject (30). "vision" config: the question exists only inside a screenshot. Accuracy.',
  // 3: a leading "I …" / "A …" (pronoun, article) is no longer read as option I / A
  version: '3',
  requires: ['completion', 'vision'],
  numCtx: 16384,
  judged: false,
  languages: datasetLanguages('mmmu-pro'),
  options: [
    {
      id: 'config',
      label: 'Config',
      description: 'standard = question + 10 options as text with images; vision = only a screenshot containing question and options.',
      choices: [
        { value: 'standard-10', label: 'Standard (10 options)' },
        { value: 'vision', label: 'Vision (screenshot)' },
      ],
      default: 'standard-10',
    },
    {
      id: 'prompt',
      label: 'Prompt',
      description: 'cot = reason step by step, final "Answer: X"; direct = answer letter only (MMMU-Pro prompts).',
      choices: [
        { value: 'cot', label: 'Chain of thought' },
        { value: 'direct', label: 'Direct' },
      ],
      default: 'cot',
    },
  ],
  rubric: { version: 'mmmu-1', instructions: 'Not judged: MMMU-Pro accuracy is deterministic.', criteria: [] },
  loadCases: (lang) => datasetCases<MmmuCase>('mmmu-pro', lang).map((c) => ({ ...c, title: `${c.subject} · ${c.id}` })),

  async run(ctx, c) {
    const vision = ctx.config.extra?.config === 'vision';
    const cot = (ctx.config.extra?.prompt ?? 'cot') === 'cot';
    const content = userContent(c, ctx.config.extra);
    // CoT budget 8192: 4096 truncated qwen3.8:27b before its 'Answer: X' line on hard items
    const r = await runStream(ctx, { messages: [{ role: 'user', content }], maxOutputTokens: cot ? 8192 : 256 });
    const predicted = extractLetter(r.output, c.options.length);
    return { ...toCaseOutput(r), data: { predicted, answer: c.answer, config: vision ? 'vision' : 'standard-10' } satisfies MmmuData };
  },

  check(c, out) {
    const d = out.data as MmmuData;
    return [
      {
        name: `correct option (${c.answer})`,
        pass: d.predicted === c.answer,
        detail: d.predicted ? `answered ${d.predicted}` : 'no answer letter found',
      },
    ];
  },

  judgeMaterial: (c, out) => ({ task: c.title, input: c.question, reference: c.answer, response: out.output }),

  promptPreview(c, _lang, extra) {
    const content = userContent(c, extra);
    const files = content.filter((p): p is FilePart => p.type === 'file');
    return {
      task: `${c.title}: multiple choice, ${extra.config === 'vision' ? 'question and options only inside the screenshot' : 'question and options as text'}, ${(extra.prompt ?? 'cot') === 'cot' ? 'chain of thought' : 'direct answer'}`,
      input: [
        ...files.map((f) => `[image: ${f.filename}]`),
        ...content.filter((p): p is TextPart => p.type === 'text').map((p) => `User: ${p.text}`),
      ].join('\n\n'),
      reference: `Correct option: ${c.answer}`,
      attachments: files,
    };
  },
};
