import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { FIXTURES_DIR } from '@/lib/tests/fixtures';

export const CORPUS_DIR = path.join(FIXTURES_DIR, 'corpus');

/** Bump when the chunking logic changes (part of the index cache key and of the suite version). */
export const CHUNKER_VERSION = 'c1';
const MAX_CHARS = 1000;
const TABLE_ROWS_PER_CHUNK = 12;

export interface Chunk {
  id: string;
  doc: string;
  /** "Document title › Section › Subsection" */
  headingPath: string;
  /** the chunk body (no breadcrumb) */
  body: string;
  /** what gets embedded / shown: breadcrumb + body */
  text: string;
}

export interface Query {
  id: string;
  title: string;
  quick?: boolean;
  query: string;
  /** relevant chunks = chunks of `doc` whose body contains `contains` */
  relevant: { doc: string; contains: string }[];
  /** short reference answer (for RAG judges) */
  answer: string;
  /** RAG answer checks (CheckSpec JSON) */
  answerChecks?: unknown[];
  /** no answer in the corpus (RAG only: the model must say so) */
  unanswerable?: boolean;
}

function splitParagraphs(body: string): string[] {
  const blocks: string[] = [];
  let cur: string[] = [];
  let inTable = false;
  for (const line of body.split(/\r?\n/)) {
    const isTable = line.trim().startsWith('|');
    if (isTable !== inTable && cur.length) {
      blocks.push(cur.join('\n'));
      cur = [];
    }
    inTable = isTable;
    if (!isTable && !line.trim()) {
      if (cur.length) blocks.push(cur.join('\n'));
      cur = [];
      continue;
    }
    cur.push(line);
  }
  if (cur.length) blocks.push(cur.join('\n'));
  return blocks.filter((b) => b.trim());
}

/** Table block → chunks of N rows, each repeating the header + separator rows. */
function splitTable(block: string): string[] {
  const rows = block.split(/\r?\n/);
  const [header, sep, ...data] = rows;
  const out: string[] = [];
  for (let i = 0; i < data.length; i += TABLE_ROWS_PER_CHUNK)
    out.push([header, sep, ...data.slice(i, i + TABLE_ROWS_PER_CHUNK)].join('\n'));
  return out.length ? out : [block];
}

/** Markdown-aware chunking: sections by heading, paragraphs packed up to MAX_CHARS, tables by row groups. */
export function chunkMarkdown(doc: string, md: string): Chunk[] {
  const lines = md.split(/\r?\n/);
  const title = (lines.find((l) => /^#\s/.test(l)) ?? doc).replace(/^#\s+/, '').trim();
  const path: string[] = [];
  const sections: { headingPath: string; body: string[] }[] = [{ headingPath: title, body: [] }];
  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      const level = h[1].length;
      path.length = level - 1;
      path[level - 1] = h[2].trim();
      const hp = [title, ...path.filter(Boolean).filter((p) => p !== title)].join(' › ');
      sections.push({ headingPath: hp, body: [] });
      continue;
    }
    sections[sections.length - 1].body.push(line);
  }

  const chunks: Chunk[] = [];
  const push = (headingPath: string, body: string) => {
    const b = body.trim();
    if (!b) return;
    chunks.push({ id: `${doc}#${chunks.length}`, doc, headingPath, body: b, text: `${headingPath}\n\n${b}` });
  };
  for (const s of sections) {
    let acc = '';
    for (const block of splitParagraphs(s.body.join('\n'))) {
      if (block.trim().startsWith('|')) {
        push(s.headingPath, acc);
        acc = '';
        for (const t of splitTable(block)) push(s.headingPath, t);
        continue;
      }
      if (acc && acc.length + block.length + 2 > MAX_CHARS) {
        push(s.headingPath, acc);
        acc = '';
      }
      acc = acc ? `${acc}\n\n${block}` : block;
    }
    push(s.headingPath, acc);
  }
  return chunks;
}

interface Corpus {
  chunks: Chunk[];
  hash: string;
}
const g = globalThis as unknown as { __benchCorpus?: Corpus };

/** All corpus documents (fixtures/corpus/docs/*.md), chunked. Cached per process. */
export function loadCorpus(): Corpus {
  if (g.__benchCorpus) return g.__benchCorpus;
  const dir = path.join(CORPUS_DIR, 'docs');
  const h = crypto.createHash('sha256').update(CHUNKER_VERSION);
  const chunks: Chunk[] = [];
  for (const f of fs
    .readdirSync(dir)
    .filter((x) => x.endsWith('.md'))
    .sort()) {
    const md = fs.readFileSync(path.join(dir, f), 'utf8');
    h.update(f).update(md);
    for (const c of chunkMarkdown(f.replace(/\.md$/, ''), md)) chunks.push(c);
  }
  return (g.__benchCorpus = { chunks, hash: h.digest('hex').slice(0, 12) });
}

/** Ids of the chunks relevant to a query. */
export function relevantIds(q: Query, chunks: Chunk[]): Set<string> {
  const ids = new Set<string>();
  for (const r of q.relevant) for (const c of chunks) if (c.doc === r.doc && c.body.includes(r.contains)) ids.add(c.id);
  return ids;
}
