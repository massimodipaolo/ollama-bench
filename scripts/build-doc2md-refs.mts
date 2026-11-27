/**
 * Builds the draft reference Markdown for the doc-to-markdown test (fixtures/doc-to-markdown/reference/*.md).
 * Deterministic for CSV, XLSX and DOCX; the PDF draft is produced by Claude reading the PDF natively (needs
 * ANTHROPIC_API_KEY / ANTHROPIC_MODEL). The infographic reference is hand-written. Review the drafts before relying
 * on them: they are the ground truth of the test.
 *
 * Usage: pnpm tsx --conditions=react-server --env-file=.env scripts/build-doc2md-refs.mts [csv|xlsx|docx|pdf]...
 */
import fs from 'node:fs';
import path from 'node:path';
import Papa from 'papaparse';
import mammoth from 'mammoth';
import TurndownService from 'turndown';
import ExcelJS from 'exceljs';
import { decodeText } from '../src/lib/files/file-part';

const SRC = '.data/files';
const OUT = 'fixtures/doc-to-markdown/reference';
const only = process.argv.slice(2);
const want = (k: string) => !only.length || only.includes(k);

const cell = (s: string) =>
  s
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
function gfmTable(header: string[], rows: string[][]): string {
  const w = header.length;
  const line = (cs: string[]) => `| ${Array.from({ length: w }, (_, i) => cell(cs[i] ?? '')).join(' | ')} |`;
  return [line(header), `|${' --- |'.repeat(w)}`, ...rows.map(line)].join('\n');
}

// ---------- CSV: one table, decoded like the adapter (cp1252 fallback) ----------
if (want('csv')) {
  const text = decodeText(new Uint8Array(fs.readFileSync(path.join(SRC, 'FFIListExample3.0.csv'))));
  const rows = Papa.parse<string[]>(text.trim(), { skipEmptyLines: true }).data;
  fs.writeFileSync(path.join(OUT, 'FFIListExample3.0.md'), gfmTable(rows[0], rows.slice(1)) + '\n');
  console.log('csv ok', rows.length - 1, 'rows');
}

// ---------- XLSX: title/notes as text, one table with flattened two-level header ----------
if (want('xlsx')) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(SRC, '17incdak.xlsx'));
  const ws = wb.worksheets[0];
  const grid: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cs: string[] = [];
    for (let c = 1; c <= ws.columnCount; c++) {
      const x = row.getCell(c);
      cs.push(x.isMerged && x.master.address !== x.address ? '' : x.text.trim());
    }
    grid.push(cs);
  });
  // header row = the one starting with "Congressional district"; the next row holds Number/Amount sub-headers
  const h = grid.findIndex((r) => /^Congressional/i.test(r[0]));
  const top = grid[h];
  const sub = grid[h + 1];
  const header: string[] = [];
  let parent = '';
  for (let c = 0; c < top.length; c++) {
    if (top[c]) parent = top[c];
    const s = sub[c];
    header.push(cell(s && !/^\(\d+\)$/.test(s) ? `${parent} — ${s}` : top[c] || parent));
  }
  // skip column-number row(s) like "(1) (2) …" then data rows until the first notes row
  let r = h + 2;
  while (grid[r] && grid[r].filter(Boolean).every((v) => /^\(\d+\)$/.test(v))) r++;
  const data: string[][] = [];
  for (; r < grid.length; r++) {
    const filled = grid[r].filter(Boolean).length;
    if (filled <= 1 && data.length) break;
    if (filled) data.push(grid[r]);
  }
  const lastCol =
    Math.max(
      ...data.map((d) => d.findLastIndex((v) => v !== '')),
      header.findLastIndex((v) => v !== ''),
    ) + 1;
  const pre = grid
    .slice(0, h)
    .map((x) => x.filter(Boolean).join(' '))
    .filter(Boolean);
  const notes = grid
    .slice(r)
    .map((x) => x.filter(Boolean).join(' '))
    .filter(Boolean);
  const md = [
    `# ${cell(pre[1] ?? '')}`,
    '',
    `**${cell(pre[0] ?? '')}**`,
    '',
    ...pre.slice(2).map((p) => `${cell(p)}\n`),
    gfmTable(
      header.slice(0, lastCol),
      data.map((d) => d.slice(0, lastCol)),
    ),
    '',
    ...notes.map((n) => `${cell(n)}\n`),
  ].join('\n');
  fs.writeFileSync(path.join(OUT, '17incdak.md'), md.trim() + '\n');
  console.log('xlsx ok', data.length, 'rows ×', lastCol, 'cols');
}

// ---------- DOCX: mammoth HTML → turndown (GFM tables); bold-only paragraphs → headings ----------
if (want('docx')) {
  let html = (await mammoth.convertToHtml({ path: path.join(SRC, '17incddocguide.docx') })).value;
  html = html
    .replace(/<a id="[^"]*"><\/a>/g, '')
    .replace(/<tr><\/tr>/g, '')
    .replace(/ (rowspan|colspan)="\d+"/g, '');
  // tables: built by hand (no <th> in Word tables, so turndown-plugin-gfm would keep them as HTML)
  const decode = (s: string) =>
    s
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  const tables: string[] = [];
  html = html.replace(/<table>([\s\S]*?)<\/table>/g, (_m, inner: string) => {
    const rows = [...inner.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((r) =>
      [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) =>
        decode(
          c[1]
            .replace(/<\/p>\s*<p>/g, '<br>')
            .replace(/<br\s*\/?>/g, '\u0000')
            .replace(/<[^>]+>/g, ''),
        )
          .split('\u0000')
          .map((x) => x.replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .join('<br>'),
      ),
    );
    tables.push(gfmTable(rows[0], rows.slice(1)));
    return `<p>@@TABLE${tables.length - 1}@@</p>`;
  });
  let first = true;
  html = html.replace(/<p><strong>([^<]+)<\/strong><\/p>/g, (_m, t: string) => {
    const s = decode(t).trim();
    if (first) return ((first = false), `<h1>${s}</h1>`);
    if (/^[A-G]\. /.test(s) || /^(Contents|Tax Year 2017 Documentation Guide)$/.test(s)) return `<h2>${s}</h2>`;
    return `<h3>${s}</h3>`;
  });
  const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', emDelimiter: '*' });
  td.escape = (str: string) => str.replace(/</g, '&lt;').replace(/>/g, '&gt;'); // keep source Markdown literal, not HTML
  let md = td.turndown(html);
  md = md
    .replace(/@@TABLE(\d+)@@/g, (_m, i: string) => tables[Number(i)])
    .replace(/^(\s*)-\s{2,}/gm, '$1- ')
    .replace(/^(\s*)(\d+)\.\s{2,}/gm, '$1$2. ')
    .replace(/ /g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(path.join(OUT, '17incddocguide.md'), md.trim() + '\n');
  console.log('docx ok', md.length, 'chars');
}

// ---------- PDF: Claude reads the PDF natively ----------
if (want('pdf')) {
  const { generateText } = await import('ai');
  const { createAnthropic } = await import('@ai-sdk/anthropic');
  const CONVERSION_PROMPT_EN = fs.readFileSync('fixtures/doc-to-markdown/prompts/en.md', 'utf8');
  const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(process.env.ANTHROPIC_MODEL!);
  const { text } = await generateText({
    model,
    system: CONVERSION_PROMPT_EN,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Convert the attached file to Markdown.' },
          {
            type: 'file',
            data: new Uint8Array(fs.readFileSync(path.join(SRC, 'i1095a.pdf'))),
            mediaType: 'application/pdf',
            filename: 'i1095a.pdf',
          },
        ],
      },
    ],
    maxOutputTokens: 16000,
  });
  fs.writeFileSync(path.join(OUT, 'i1095a.md'), text.trim() + '\n');
  console.log('pdf ok', text.length, 'chars');
}
