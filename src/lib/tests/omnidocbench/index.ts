import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import type { FilePart } from 'ai';
import type { TestDefinition, BaseCase } from '../types';
import { FIXTURES_DIR } from '../fixtures';
import { runStream, toCaseOutput } from '../generate';
import { datasetCases, datasetLanguages, datasetPath } from '../datasets';
import { mediaTypeOf } from '@/lib/files/file-part';
import { odbChecks } from './metrics';

/**
 * OmniDocBench (CVPR 2025) — page image → Markdown, English pages, 6 per document type.
 * Data: research use only; downloaded at runtime (pnpm datasets:fetch omnidocbench), never committed.
 */
interface OdbCase extends BaseCase {
  image: string;
  dataSource: string;
  layout: string;
  markdown: string;
  text: string[];
  tables: string[];
  equations: string[];
}

const PROMPT =
  fs.readFileSync(path.join(FIXTURES_DIR, 'doc-to-markdown', 'prompts', 'en.md'), 'utf8').trim() +
  '\n\nFor this benchmark: write tables as HTML <table> or Markdown tables, and display equations in LaTeX between $$ … $$.';

function pagePart(c: OdbCase): FilePart {
  return {
    type: 'file',
    data: new Uint8Array(fs.readFileSync(datasetPath('omnidocbench', 'images', c.image))),
    mediaType: mediaTypeOf(c.image),
    filename: c.image,
  };
}

export const omnidocbench: TestDefinition<OdbCase> = {
  id: 'omnidocbench',
  name: 'OmniDocBench (page → Markdown)',
  description:
    'Document page images (slides, papers, books, textbooks, exams, magazines, newspapers) → Markdown. Text edit similarity, table cell F1, formula similarity; judges see the page.',
  version: '1',
  requires: ['completion', 'vision'],
  numCtx: 16384,
  responseLanguage: 'source',
  languages: datasetLanguages('omnidocbench'),
  rubric: {
    version: 'odb-1',
    instructions:
      'The candidate converted the attached document page image to Markdown. Compare with the page itself and the reference (the benchmark ground truth in reading order; tables as HTML, equations as LaTeX; headers, footers, page numbers and figures are intentionally omitted). Missing, reordered or invented text is severe; then judge tables (structure and cells) and formulas (correct LaTeX).',
    criteria: [
      { name: 'Text fidelity', description: 'All text present, verbatim, in the right reading order.' },
      { name: 'Tables', description: 'Tables reproduced with correct structure and cell values (N/A if none).' },
      { name: 'Formulas', description: 'Equations transcribed as correct LaTeX (N/A if none).' },
      { name: 'Structure & cleanliness', description: 'Headings, paragraphs and lists; no page furniture or commentary.' },
    ],
  },
  loadCases: (lang) => datasetCases<OdbCase>('omnidocbench', lang).map((c) => ({ ...c, title: `${c.dataSource} · ${c.id}` })),

  async run(ctx, c) {
    const r = await runStream(ctx, {
      system: PROMPT,
      messages: [{ role: 'user', content: [pagePart(c), { type: 'text', text: 'Convert this page to Markdown.' }] }],
      maxOutputTokens: 8192,
    });
    return toCaseOutput(r);
  },

  check: (c, out) => odbChecks(out.output, c),

  judgeMaterial: (c, out) => ({
    task: `${c.title}: convert the attached page image to Markdown.`,
    input:
      'Conversion rules: keep all content verbatim in reading order; headings, lists, tables (HTML or Markdown), display equations as $$ LaTeX $$; drop running headers/footers and page numbers.',
    reference: c.markdown,
    response: out.output,
    attachments: [pagePart(c)],
  }),
};
