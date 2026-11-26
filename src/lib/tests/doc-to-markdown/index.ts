import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import type { FilePart } from 'ai';
import type { TestDefinition, BaseCase } from '../types';
import { FIXTURES_DIR, readCases, readSourceFile } from '../fixtures';
import { runStream, toCaseOutput } from '../generate';
import { formatFilePartForOllama, mediaTypeOf } from '@/lib/files/file-part';
import { markdownChecks } from './metrics';

interface DocCase extends BaseCase {
  /** file in .data/files */
  file: string;
  /** reference Markdown in fixtures/doc-to-markdown/reference */
  reference: string;
  /** user message accompanying the file */
  instruction: string;
  maxOutputTokens?: number;
  /** page furniture (running headers/footers, catalog numbers…) that must not survive the conversion */
  forbid?: string[];
}

const DIR = path.join(FIXTURES_DIR, 'doc-to-markdown');

/** System prompt per language: fixtures/doc-to-markdown/prompts/<lang>.md (falls back to English). */
function conversionPrompt(lang: string): string {
  const p = path.join(DIR, 'prompts', `${lang}.md`);
  return fs.readFileSync(fs.existsSync(p) ? p : path.join(DIR, 'prompts', 'en.md'), 'utf8').trim();
}

const reference = (c: DocCase) => fs.readFileSync(path.join(DIR, 'reference', c.reference), 'utf8');

/** The source file as an AI SDK file part (bytes + media type). */
function sourcePart(c: DocCase): FilePart {
  return { type: 'file', data: new Uint8Array(readSourceFile(c.file)), mediaType: mediaTypeOf(c.file), filename: c.file };
}

export const docToMarkdown: TestDefinition<DocCase> = {
  id: 'doc-to-markdown',
  name: 'Document → Markdown',
  description:
    'PDF, DOCX, CSV, XLSX and an image sent as file parts (images native, other files as extracted text parts); the model rebuilds the document as Markdown.',
  version: '2',
  requires: ['completion'],
  numCtx: 40960,
  responseLanguage: 'source',
  rubric: {
    version: 'd2m-1',
    instructions:
      'The candidate converted a document to GitHub-flavored Markdown. The reference is a correct conversion (wording must match; equivalent Markdown syntax is fine). Missing, summarized, reordered, translated or invented content is a severe error. Then judge how well the structure was rebuilt: headings hierarchy, paragraphs re-joined, lists, tables with every row/column, removal of page furniture. Wrapping the output in code fences or adding commentary is a minor error.',
    criteria: [
      { name: 'Completeness', description: 'All content of the reference is present; nothing summarized or dropped.' },
      { name: 'Fidelity', description: 'Text is verbatim (no rewording, translation, hallucination); numbers and names exact.' },
      { name: 'Structure', description: 'Heading hierarchy, paragraphs, lists and emphasis match the document.' },
      { name: 'Tables', description: 'Tables are valid GFM with correct header, rows, columns and cell values (N/A if no tables).' },
      { name: 'Cleanliness', description: 'No page furniture, fences, preambles or commentary.' },
    ],
  },
  loadCases: (lang) => readCases<DocCase>('doc-to-markdown', lang),

  async run(ctx, c) {
    // File part → what Ollama can read: image natively, anything else as a <file> text part.
    const part = await formatFilePartForOllama(sourcePart(c));
    const r = await runStream(ctx, {
      system: conversionPrompt(ctx.lang.code),
      messages: [{ role: 'user', content: [{ type: 'text', text: c.instruction }, part] }],
      maxOutputTokens: c.maxOutputTokens ?? 16384,
    });
    return {
      ...toCaseOutput(r),
      data: { input: part.type === 'text' ? 'text-part' : 'image', inputChars: part.type === 'text' ? part.text.length : undefined },
    };
  },

  check: (c, out) => markdownChecks(out.output, reference(c), c.forbid),

  judgeMaterial: (c, out) => {
    const src = sourcePart(c);
    // judges read images and PDFs natively; other formats are covered by the reference
    const nativeForJudges = src.mediaType.startsWith('image/') || src.mediaType === 'application/pdf';
    return {
      task: `${c.title}: convert the attached file (${c.file}) to GitHub-flavored Markdown following the conversion rules.`,
      input: `Conversion rules given to the candidate:\n${conversionPrompt('en')}\n\nThe candidate received ${src.mediaType.startsWith('image/') ? 'the image itself' : 'the text extracted from the file (layout lost)'}.`,
      reference: reference(c),
      response: out.output,
      attachments: nativeForJudges ? [src] : undefined,
    };
  },
};
