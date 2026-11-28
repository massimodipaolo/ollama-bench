/**
 * The tests that send files to the model, end to end against the fake Ollama: how each file type reaches Ollama
 * (images natively, everything else as extracted text) and how the answers are scored.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getLanguage } from '@/config/languages';
import { autoScore } from '@/lib/tests/checks';
import { headings, markdownChecks, tables, words } from '@/lib/tests/doc-to-markdown/metrics';
import { chatReply, startFakeOllama } from '../../helpers/fake-ollama';
import { caseOf, runContext } from '../../helpers/context';

const ollama = await startFakeOllama();
process.env.OLLAMA_HOST = ollama.url;
const { docToMarkdown } = await import('@/lib/tests/doc-to-markdown');
const { imageRecognition } = await import('@/lib/tests/image-recognition');

afterAll(() => ollama.close());
beforeEach(() => ollama.reset());

const en = getLanguage('en');
const docCases = docToMarkdown.loadCases('en');
const referenceOf = (id: string) =>
  readFileSync(join(process.cwd(), 'fixtures', 'doc-to-markdown', 'reference', caseOf(docCases, id).reference), 'utf8');
/** The user message the fake Ollama received. */
const userMessage = () =>
  (ollama.calls('/api/chat')[0].body?.messages as { role: string; content: string; images?: string[] }[]).find((m) => m.role === 'user')!;

describe('Markdown metrics', () => {
  it('parses words, headings and GFM tables', () => {
    expect(words('**Bold** [link](http://x) don’t 1,234.5')).toEqual(['bold', 'link', "don't", '1,234.5']);
    expect(headings('# Title\ntext\n### Sub ###')).toEqual([
      { level: 1, text: 'Title' },
      { level: 3, text: 'Sub' },
    ]);
    expect(tables('| a | b |\n|---|---|\n| 1 | 2 |\n\nafter')).toEqual([
      [
        ['a', 'b'],
        ['1', '2'],
      ],
    ]);
  });

  it('the reference scored against itself passes every check', () => {
    for (const c of docCases) {
      const ref = referenceOf(c.id);
      expect(markdownChecks(ref, ref, []).filter((x) => !x.pass)).toEqual([]);
    }
  });

  it('flags fences and preambles, summaries, and page furniture left in', () => {
    const ref = referenceOf('pdf-instructions');
    expect(markdownChecks('```markdown\n' + ref + '\n```', ref)[0]).toMatchObject({
      name: 'clean output (no fences/preamble)',
      pass: false,
    });
    expect(markdownChecks(`Here is the document:\n\n${ref}`, ref)[0].pass).toBe(false);
    const half = ref.slice(0, Math.floor(ref.length / 2));
    const recall = markdownChecks(half, ref).find((x) => x.name.startsWith('content recall'))!;
    expect(recall.pass).toBe(false);
    expect(recall.value!).toBeLessThan(0.6);
    expect(markdownChecks(`${ref}\nCat. No. 60703Q`, ref, ['Cat. No.']).find((x) => x.name === 'page furniture removed')).toMatchObject({
      pass: false,
      detail: 'still present: Cat. No.',
    });
  });

  it('tables: missing rows and cells are counted', () => {
    const ref = referenceOf('csv-table');
    const lines = ref.split('\n');
    const fewer = lines.slice(0, Math.floor(lines.length * 0.7)).join('\n');
    const checks = markdownChecks(fewer, ref);
    expect(checks.find((x) => x.name === 'table rows')?.pass).toBe(false);
    expect(checks.find((x) => x.name.startsWith('table cells'))?.pass).toBe(false);
  });
});

describe('doc-to-markdown runs: what reaches Ollama', () => {
  it('a CSV goes as a <file> text part with the instruction, under the conversion system prompt', async () => {
    const c = caseOf(docCases, 'csv-table');
    ollama.replies.push(chatReply({ text: referenceOf('csv-table') }));
    const out = await docToMarkdown.run(runContext().ctx, c);
    const user = userMessage();
    expect(user.content).toContain(c.instruction);
    expect(user.content).toContain('<file name="FFIListExample3.0.csv" type="text/csv">');
    expect(user.images ?? []).toEqual([]);
    expect(out.data).toMatchObject({ input: 'text-part' });
    expect(autoScore(docToMarkdown.check(c, out, en))).toBe(10);
  });

  it('a PDF goes as its extracted text', async () => {
    ollama.replies.push(chatReply({ text: 'x' }));
    await docToMarkdown.run(runContext().ctx, caseOf(docCases, 'pdf-instructions'));
    expect(userMessage().content).toMatch(/<file name="i1095a.pdf" type="application\/pdf">[\s\S]*1095-A/);
  });

  it('an image goes natively, as an Ollama image', async () => {
    ollama.replies.push(chatReply({ text: 'x' }));
    const out = await docToMarkdown.run(runContext().ctx, caseOf(docCases, 'image-infographic'));
    const user = userMessage();
    expect(user.images).toHaveLength(1);
    expect(Buffer.from(user.images![0], 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // a JPEG
    expect(out.data).toMatchObject({ input: 'image' });
  });

  it('judges get images and PDFs natively, extracted formats only through the reference', () => {
    const out = { output: 'x' };
    expect(docToMarkdown.judgeMaterial(caseOf(docCases, 'pdf-instructions'), out, en).attachments?.[0].mediaType).toBe('application/pdf');
    expect(docToMarkdown.judgeMaterial(caseOf(docCases, 'csv-table'), out, en).attachments).toBeUndefined();
  });
});

describe('image recognition', () => {
  const c = caseOf(imageRecognition.loadCases('en'), 'infographic-ocr');

  it('sends every image of the case natively, with the question', async () => {
    ollama.replies.push(chatReply({ text: 'x' }));
    await imageRecognition.run(runContext().ctx, c);
    const user = userMessage();
    expect(user.images).toHaveLength(c.images.length);
    expect(user.content).toContain(c.prompt);
  });

  it('scores the answer with the case checks; the judges get the images', async () => {
    ollama.replies.push(chatReply({ text: 'I cannot read it.' }));
    const out = await imageRecognition.run(runContext().ctx, c);
    const checks = imageRecognition.check(c, out, en);
    expect(checks).toHaveLength(c.checks.length);
    expect(imageRecognition.judgeMaterial(c, out, en).attachments).toHaveLength(c.images.length);
  });
});
