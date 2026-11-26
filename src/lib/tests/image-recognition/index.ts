import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import type { FilePart } from 'ai';
import type { TestDefinition, BaseCase } from '../types';
import { FIXTURES_DIR, readCases } from '../fixtures';
import { runStream, toCaseOutput } from '../generate';
import { runCheck, type CheckSpec } from '../checks';
import { formatFilePartForOllama, mediaTypeOf } from '@/lib/files/file-part';

interface VisionCase extends BaseCase {
  /** files in fixtures/image-recognition/images */
  images: string[];
  prompt: string;
  reference: string;
  checks: CheckSpec[];
}

const IMG_DIR = path.join(FIXTURES_DIR, 'image-recognition', 'images');

function imageParts(c: VisionCase): FilePart[] {
  return c.images.map((f) => ({
    type: 'file',
    data: new Uint8Array(fs.readFileSync(path.join(IMG_DIR, f))),
    mediaType: mediaTypeOf(f),
    filename: f,
  }));
}

const system = (langName: string) =>
  `You answer questions about images precisely. Read text in images exactly as written. If something asked is not visible in the image, say so instead of guessing. Answer in ${langName}; quote text from the image in its original language.`;

export const imageRecognition: TestDefinition<VisionCase> = {
  id: 'image-recognition',
  name: 'Image recognition',
  description:
    'OCR, layout and reading order, visual Q&A, hallucination traps and accessibility descriptions on an infographic and rendered PDF pages.',
  version: '1',
  requires: ['completion', 'vision'],
  numCtx: 16384,
  rubric: {
    version: 'img-1',
    instructions:
      'The candidate answered a question about the attached image(s). Check the answer against the image itself and the reference. Text read from the image must be exact; claiming something that is not in the image (hallucination) is severe; saying that something is not visible, when it is not, is correct.',
    criteria: [
      { name: 'Visual accuracy', description: 'What is read or described matches the image exactly (text, numbers, layout).' },
      { name: 'Completeness', description: 'Answers every part of the question.' },
      { name: 'No hallucination', description: 'Nothing invented; absent information is reported as absent.' },
      { name: 'Language & clarity', description: 'Clear answer in the required language; quoted text kept as in the image.' },
    ],
  },
  loadCases: (lang) => readCases<VisionCase>('image-recognition', lang),

  async run(ctx, c) {
    const parts = await Promise.all(imageParts(c).map(formatFilePartForOllama));
    const r = await runStream(ctx, {
      system: system(ctx.lang.englishName),
      messages: [{ role: 'user', content: [...parts, { type: 'text', text: c.prompt }] }],
      maxOutputTokens: 2048,
    });
    return toCaseOutput(r);
  },

  check: (c, out, lang) => c.checks.map((s) => runCheck(s, out.output, lang)),

  judgeMaterial: (c, out, lang) => ({
    task: `${c.title}: answer a question about the attached image(s).`,
    input: `System: ${system(lang.englishName)}\n\nUser: ${c.prompt}\n(images: ${c.images.join(', ')})`,
    reference: c.reference,
    response: out.output,
    attachments: imageParts(c),
  }),
};
