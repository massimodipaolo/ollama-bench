/**
 * Benchmark datasets (OmniDocBench, BFCL, MMMU-Pro, Terminal-Bench): only pinned manifests live in the repo
 * (fixtures/<test>/manifest.json: dataset revision + selected item ids). This script downloads exactly those items
 * into .data/datasets/<test>/ (git-ignored) and builds the cases the tests read.
 *
 *   pnpm datasets:fetch                    # all of them, from the committed manifests
 *   pnpm datasets:fetch terminal-bench     # Terminal-Bench 2.1 tasks (+ --pull: pre-pull the quick tasks' images)
 *   pnpm datasets:fetch bfcl mmmu-pro      # some of them
 *   pnpm datasets:fetch --select           # maintainer: re-select a stratified subset and rewrite the manifests
 *
 * Licenses: OmniDocBench is research-only / non-commercial (never commit its data); BFCL and MMMU-Pro are Apache-2.0;
 * Terminal-Bench is Apache-2.0.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { asyncBufferFromUrl, cachedAsyncBuffer, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { parseTaskToml, type TbCase } from '../../src/lib/tests/terminal-bench/config';

const ROOT = process.cwd();
const DATA = path.join(ROOT, '.data', 'datasets');
const FIX = path.join(ROOT, 'fixtures');
const args = process.argv.slice(2);
const SELECT = args.includes('--select');
const only = args.filter((a) => !a.startsWith('--'));
const want = (k: string) => !only.length || only.includes(k);

const h = (s: string) => crypto.createHash('sha1').update(s).digest('hex');
const writeJson = (p: string, v: unknown) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
};
const readJson = <T,>(p: string) => JSON.parse(fs.readFileSync(p, 'utf8')) as T;

/** The file's text, or undefined if it doesn't exist (read directly: checking first races with a change in between). */
function readIfExists(p: string): string | undefined {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/**
 * Downloads `url` to `dest` unless a non-empty `dest` is already there. The body goes to `<dest>.part` first and is
 * renamed into place when complete, so an interrupted download never leaves a truncated `dest` that a later run
 * would skip. `backoffMs`: base wait between attempts (the HF dataset viewer generates image assets on first
 * request: 403 for ~20 s).
 */
async function download(url: string, dest: string, retries = 3, backoffMs = 1500): Promise<number> {
  const existing = fs.statSync(dest, { throwIfNoEntry: false })?.size;
  if (existing) return existing;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(part, buf);
      fs.renameSync(part, dest);
      return buf.length;
    } catch (e) {
      if (i >= retries) throw new Error(`download failed ${url}: ${(e as Error).message}`);
      await new Promise((res) => setTimeout(res, backoffMs * (i + 1)));
    }
  }
}

/** Stratified, reproducible pick: per group, sort by hash(id) and take n (preferring items matching `prefer`). */
function stratify<T>(items: T[], group: (t: T) => string, id: (t: T) => string, n: number, prefer?: (t: T) => boolean): T[] {
  const groups = new Map<string, T[]>();
  for (const it of items) groups.set(group(it), [...(groups.get(group(it)) ?? []), it]);
  const out: T[] = [];
  for (const g of [...groups.keys()].sort()) {
    const sorted = groups.get(g)!.sort((a, b) => h(id(a)).localeCompare(h(id(b))));
    const pref = prefer ? sorted.filter(prefer).slice(0, Math.ceil(n / 3)) : [];
    out.push(...pref, ...sorted.filter((x) => !pref.includes(x)).slice(0, n - pref.length));
  }
  return out;
}

// ======================================================================= OmniDocBench
const ODB = { dataset: 'opendatalab/OmniDocBench', revision: 'aa1ee96d106dbe53d0ae59474d75c6e6d9b53fec' };
interface OdbDet {
  category_type: string;
  ignore: boolean;
  order: number | null;
  text?: string;
  latex?: string;
  html?: string;
}
interface OdbPage {
  layout_dets: OdbDet[];
  page_info: { image_path: string; page_attribute: { data_source: string; language: string; layout: string } };
}
const ODB_SKIP = new Set(['header', 'footer', 'page_number', 'abandon', 'figure', 'list_group', 'equation_semantic', 'need_mask']);

/** Reference Markdown + typed parts from a page's annotations (reading order; page furniture and figures dropped). */
function odbReference(p: OdbPage) {
  const dets = p.layout_dets
    .filter((d) => !d.ignore && d.order != null && !ODB_SKIP.has(d.category_type) && !d.category_type.endsWith('_mask'))
    .sort((a, b) => a.order! - b.order!);
  const md: string[] = [];
  const text: string[] = [];
  const tables: string[] = [];
  const equations: string[] = [];
  for (const d of dets) {
    if (d.category_type === 'table') {
      if (d.html) {
        tables.push(d.html);
        md.push(d.html);
      }
    } else if (d.category_type === 'equation_isolated') {
      if (d.latex) {
        equations.push(d.latex);
        md.push(d.latex);
      }
    } else if (d.text?.trim()) {
      text.push(d.text.trim());
      md.push(d.category_type === 'title' ? `## ${d.text.trim()}` : d.text.trim());
    }
  }
  return { markdown: md.join('\n\n'), text, tables, equations };
}

async function omnidocbench() {
  const dir = path.join(DATA, 'omnidocbench');
  const manifestPath = path.join(FIX, 'omnidocbench', 'manifest.json');
  const jsonPath = path.join(dir, 'OmniDocBench.json');
  const kb = await download(`https://huggingface.co/datasets/${ODB.dataset}/resolve/${ODB.revision}/OmniDocBench.json`, jsonPath);
  const pages = readJson<OdbPage[]>(jsonPath);
  const byId = new Map(pages.map((p) => [p.page_info.image_path, p]));

  if (SELECT) {
    const en = pages.filter((p) => p.page_info.page_attribute.language === 'english');
    const common = (p: OdbPage) => p.page_info.page_attribute.data_source;
    const sizes = new Map<string, number>();
    for (const p of en) sizes.set(common(p), (sizes.get(common(p)) ?? 0) + 1);
    const usable = en.filter((p) => (sizes.get(common(p)) ?? 0) >= 6 && odbReference(p).markdown.length > 200);
    const full = stratify(
      usable,
      common,
      (p) => p.page_info.image_path,
      6,
      (p) => p.layout_dets.some((d) => d.category_type === 'table'),
    );
    const quick = stratify(full, common, (p) => p.page_info.image_path, 1).slice(0, 5);
    writeJson(manifestPath, {
      ...ODB,
      license: 'Research use only, not for commercial use (dataset card). Data is downloaded at runtime, never committed.',
      selection: 'English pages, 6 per document type (types with ≥6 English pages), ≥1/3 with tables where available; hash-ordered',
      quick: quick.map((p) => p.page_info.image_path),
      full: full.map((p) => p.page_info.image_path),
    });
    console.log(`omnidocbench: selected ${full.length} pages (${[...new Set(full.map(common))].join(', ')})`);
  }

  const m = readJson<{ quick: string[]; full: string[] }>(manifestPath);
  let bytes = 0;
  const cases = [];
  for (const img of m.full) {
    const p = byId.get(img);
    if (!p) throw new Error(`omnidocbench: ${img} not in the dataset revision`);
    bytes += await download(
      `https://huggingface.co/datasets/${ODB.dataset}/resolve/${ODB.revision}/images/${encodeURIComponent(img)}`,
      path.join(dir, 'images', img),
    );
    const ref = odbReference(p);
    const a = p.page_info.page_attribute;
    cases.push({
      id: img.replace(/\.(png|jpg)$/i, ''),
      image: img,
      quick: m.quick.includes(img),
      dataSource: a.data_source,
      layout: a.layout,
      ...ref,
    });
  }
  writeJson(path.join(dir, 'cases.json'), cases);
  console.log(`omnidocbench: ${cases.length} pages, images ${(bytes / 1e6).toFixed(1)} MB (+ annotations ${(kb / 1e6).toFixed(1)} MB)`);
}

// ======================================================================= BFCL
const BFCL = {
  repo: 'ShishirPatil/gorilla',
  revision: 'f7cf7359b7ac615a0b294831c5ba2bc95ee4a000',
  base: 'berkeley-function-call-leaderboard/bfcl_eval/data',
};
const BFCL_CATS: Record<string, number> = { simple_python: 15, multiple: 10, parallel: 10, parallel_multiple: 10, irrelevance: 15 };

const parseJsonl = <T,>(s: string): T[] =>
  s
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);

async function bfcl() {
  const dir = path.join(DATA, 'bfcl');
  const manifestPath = path.join(FIX, 'bfcl', 'manifest.json');
  const raw = (p: string) => `https://raw.githubusercontent.com/${BFCL.repo}/${BFCL.revision}/${BFCL.base}/${p}`;
  const entries: Record<string, { id: string }[]> = {};
  const answers: Record<string, Map<string, unknown>> = {};
  for (const cat of Object.keys(BFCL_CATS)) {
    const f = path.join(dir, `BFCL_v4_${cat}.json`);
    await download(raw(`BFCL_v4_${cat}.json`), f);
    entries[cat] = parseJsonl<{ id: string }>(fs.readFileSync(f, 'utf8'));
    if (cat !== 'irrelevance') {
      const a = path.join(dir, 'possible_answer', `BFCL_v4_${cat}.json`);
      await download(raw(`possible_answer/BFCL_v4_${cat}.json`), a);
      answers[cat] = new Map(
        parseJsonl<{ id: string; ground_truth: unknown }>(fs.readFileSync(a, 'utf8')).map((x) => [x.id, x.ground_truth]),
      );
    }
  }

  if (SELECT) {
    const pick: Record<string, string[]> = {};
    for (const [cat, n] of Object.entries(BFCL_CATS))
      pick[cat] = [...entries[cat]]
        .sort((a, b) => h(a.id).localeCompare(h(b.id)))
        .slice(0, n)
        .map((e) => e.id);
    writeJson(manifestPath, {
      ...BFCL,
      license: 'Apache-2.0',
      selection: 'BFCL v4 single-turn categories, hash-ordered; quick = first id of each category',
      ids: pick,
      quick: Object.values(pick).map((ids) => ids[0]),
    });
    console.log(`bfcl: selected ${Object.values(pick).flat().length} items`);
  }

  const m = readJson<{ ids: Record<string, string[]>; quick: string[] }>(manifestPath);
  const cases = [];
  for (const [cat, ids] of Object.entries(m.ids)) {
    for (const id of ids) {
      const e = entries[cat].find((x) => x.id === id) as { id: string; question: unknown; function: unknown } | undefined;
      if (!e) throw new Error(`bfcl: ${id} not found`);
      cases.push({
        id,
        category: cat,
        quick: m.quick.includes(id),
        question: e.question,
        functions: e.function,
        groundTruth: answers[cat]?.get(id) ?? [],
      });
    }
  }
  writeJson(path.join(dir, 'cases.json'), cases);
  console.log(`bfcl: ${cases.length} items`);
}

// ======================================================================= MMMU-Pro
// Read straight from the pinned Parquet files with HTTP range requests and the page index (hyparquet), so only the
// pages holding the selected rows are downloaded (the dataset viewer's image assets proved unreliable: 403s).
const MMMU = { dataset: 'MMMU/MMMU_Pro', revision: '0d7426df4ccb3d8704a992fe6850abee7c262127' };
const MMMU_FILES = {
  standard: ['standard (10 options)/test-00000-of-00002.parquet', 'standard (10 options)/test-00001-of-00002.parquet'],
  vision: [
    'vision/test-00000-of-00004.parquet',
    'vision/test-00001-of-00004.parquet',
    'vision/test-00002-of-00004.parquet',
    'vision/test-00003-of-00004.parquet',
  ],
};
const mmmuUrl = (f: string) =>
  `https://huggingface.co/datasets/${MMMU.dataset}/resolve/${MMMU.revision}/${f.split('/').map(encodeURIComponent).join('/')}`;

/** The options column is a Python list literal: parse it without eval. */
export function parsePyList(s: string): string[] {
  const out: string[] = [];
  let i = s.indexOf('[') + 1;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    const q = s[i];
    if (q !== "'" && q !== '"') break;
    let v = '';
    i++;
    while (i < s.length && s[i] !== q) {
      if (s[i] === '\\' && i + 1 < s.length) {
        const n = s[++i];
        v += n === 'n' ? '\n' : n === 't' ? '\t' : n;
      } else v += s[i];
      i++;
    }
    out.push(v);
    i++;
  }
  return out;
}

interface PqFile {
  name: string;
  file: Awaited<ReturnType<typeof asyncBufferFromUrl>>;
  metadata: Awaited<ReturnType<typeof parquetMetadataAsync>>;
  rowStart: number;
  rows: number;
}
let transferred = 0;

/** Open the files of one config: footers only; rows are addressed globally across files (dataset row order). */
async function openConfig(files: string[]): Promise<PqFile[]> {
  const out: PqFile[] = [];
  let start = 0;
  for (const name of files) {
    const raw = await asyncBufferFromUrl({ url: mmmuUrl(name) });
    const file = cachedAsyncBuffer({
      byteLength: raw.byteLength,
      slice: async (s: number, e?: number) => {
        const r = await raw.slice(s, e);
        transferred += r.byteLength;
        return r;
      },
    });
    const metadata = await parquetMetadataAsync(file);
    const rows = Number(metadata.num_rows);
    out.push({ name, file, metadata, rowStart: start, rows });
    start += rows;
  }
  return out;
}

async function readRow(files: PqFile[], row: number, columns?: string[]): Promise<Record<string, unknown>> {
  const f = files.find((x) => row >= x.rowStart && row < x.rowStart + x.rows);
  if (!f) throw new Error(`row ${row} out of range`);
  const local = row - f.rowStart;
  // utf8: false: otherwise hyparquet decodes un-annotated binary columns (the image bytes) as UTF-8 text, corrupting them
  const [r] = await parquetReadObjects({
    file: f.file,
    metadata: f.metadata,
    rowStart: local,
    rowEnd: local + 1,
    columns,
    useOffsetIndex: true,
    utf8: false,
  });
  return r as Record<string, unknown>;
}

/** With utf8: false, text columns come back as bytes: decode them explicitly. */
const text = (v: unknown): string => (v instanceof Uint8Array ? new TextDecoder().decode(v) : v == null ? '' : String(v));
const pathOf = (img: { path?: unknown }) => (img.path == null ? undefined : text(img.path));
const isImage = (b: Uint8Array) => (b[0] === 0x89 && b[1] === 0x50) || (b[0] === 0xff && b[1] === 0xd8);

const imageExt = (p: string | undefined, bytes: Uint8Array) =>
  p?.match(/\.(png|jpe?g|webp|gif)$/i)?.[1].toLowerCase() ?? (bytes[0] === 0x89 ? 'png' : 'jpg');

async function mmmuPro() {
  const dir = path.join(DATA, 'mmmu-pro');
  const manifestPath = path.join(FIX, 'mmmu-pro', 'manifest.json');
  const std = await openConfig(MMMU_FILES.standard);
  const vis = await openConfig(MMMU_FILES.vision);

  if (SELECT) {
    // only the small id/subject columns of the standard config
    const all: { id: string; subject: string; row: number }[] = [];
    for (const f of std) {
      const rows = (await parquetReadObjects({ file: f.file, metadata: f.metadata, columns: ['id', 'subject'] })) as {
        id: string;
        subject: string;
      }[];
      rows.forEach((r, i) => all.push({ id: r.id, subject: r.subject, row: f.rowStart + i }));
    }
    const full = stratify(
      all,
      (r) => r.subject,
      (r) => r.id,
      1,
    );
    const quick = stratify(
      full,
      (r) => (h(r.subject) < '8' ? 'a' : 'b'),
      (r) => r.id,
      3,
    ).slice(0, 5);
    writeJson(manifestPath, {
      ...MMMU,
      license: 'Apache-2.0',
      files: MMMU_FILES,
      selection: `One item per subject (${full.length} subjects) from the test split, hash-ordered; same rows in the "standard (10 options)" and "vision" configs`,
      quick: quick.map((r) => r.id),
      items: full.map((r) => ({ id: r.id, row: r.row, subject: r.subject })),
    });
    console.log(`mmmu-pro: selected ${full.length} items`);
  }

  const m = readJson<{ quick: string[]; items: { id: string; row: number; subject: string }[] }>(manifestPath);
  const imageCols = Array.from({ length: 7 }, (_, k) => `image_${k + 1}`);
  const cases = [];
  for (const it of m.items) {
    const s = await readRow(std, it.row, ['id', 'question', 'options', 'answer', 'topic_difficulty', 'subject', ...imageCols]);
    const v = await readRow(vis, it.row, ['id', 'image']);
    if (text(s.id) !== it.id || text(v.id) !== it.id)
      throw new Error(`mmmu-pro: row ${it.row} is ${text(s.id)} / ${text(v.id)}, expected ${it.id}`);
    const images: string[] = [];
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    for (const col of imageCols) {
      const img = s[col] as { bytes?: Uint8Array; path?: unknown } | null;
      if (!img?.bytes?.length) continue;
      if (!isImage(img.bytes)) throw new Error(`mmmu-pro: ${it.id} ${col} is not a PNG/JPEG`);
      const f = `${it.id}_${col}.${imageExt(pathOf(img), img.bytes)}`;
      fs.writeFileSync(path.join(dir, 'images', f), img.bytes);
      images.push(f);
    }
    const vimg = v.image as { bytes: Uint8Array; path?: unknown };
    if (!isImage(vimg.bytes)) throw new Error(`mmmu-pro: ${it.id} vision image is not a PNG/JPEG`);
    const visionImage = `${it.id}_vision.${imageExt(pathOf(vimg), vimg.bytes)}`;
    fs.writeFileSync(path.join(dir, 'images', visionImage), vimg.bytes);
    cases.push({
      id: it.id,
      subject: it.subject,
      quick: m.quick.includes(it.id),
      question: text(s.question),
      options: parsePyList(text(s.options)),
      answer: text(s.answer),
      difficulty: text(s.topic_difficulty),
      images,
      visionImage,
    });
    process.stdout.write('.');
  }
  writeJson(path.join(dir, 'cases.json'), cases);
  console.log(`\nmmmu-pro: ${cases.length} items, ${(transferred / 1e6).toFixed(1)} MB transferred`);
}

const run = (cmd: string, argv: string[], opts: { cwd?: string } = {}) => {
  const r = spawnSync(cmd, argv, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.slice(0, 3).join(' ')} … failed (exit ${r.status ?? r.error?.message})`);
};

// ---------- Terminal-Bench 2.1 (harbor-framework/terminal-bench-2-1) ----------

async function terminalBench() {
  const dir = path.join(DATA, 'terminal-bench');
  const m = readJson<{ repo: string; commit: string; quick: string[]; count: number }>(path.join(FIX, 'terminal-bench', 'manifest.json'));
  const repo = path.join(dir, 'repo');
  const stamp = path.join(repo, '.commit');
  if (readIfExists(stamp)?.trim() !== m.commit) {
    const tgz = path.join(dir, `${m.commit.slice(0, 12)}.tar.gz`);
    const bytes = await download(`https://codeload.github.com/${m.repo}/tar.gz/${m.commit}`, tgz);
    console.log(`terminal-bench: ${(bytes / 1e6).toFixed(1)} MB at ${m.commit.slice(0, 12)}`);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.mkdirSync(repo, { recursive: true });
    // relative paths: GNU tar (Git for Windows) reads "C:\\…" as a remote host; only tasks/ is needed
    run('tar', ['-xzf', path.basename(tgz), '-C', 'repo', '--strip-components=1', '--wildcards', '*/tasks/*'], { cwd: dir });
    fs.writeFileSync(stamp, m.commit);
  }
  const tasksDir = path.join(repo, 'tasks');
  const cases: TbCase[] = fs
    .readdirSync(tasksDir)
    .filter((n) => fs.existsSync(path.join(tasksDir, n, 'task.toml')))
    .sort()
    .map((name) => ({
      ...parseTaskToml(name, fs.readFileSync(path.join(tasksDir, name, 'task.toml'), 'utf8')),
      quick: m.quick.includes(name) || undefined,
      dir: path.posix.join('repo', 'tasks', name),
    }));
  if (cases.length !== m.count) throw new Error(`terminal-bench: ${cases.length} tasks, manifest says ${m.count}`);
  const missing = m.quick.filter((q) => !cases.some((c) => c.id === q));
  if (missing.length) throw new Error(`terminal-bench: quick tasks not found: ${missing.join(', ')}`);
  writeJson(path.join(dir, 'cases.json'), cases);
  console.log(`terminal-bench: ${cases.length} tasks (quick: ${m.quick.join(', ')})`);
  if (args.includes('--pull')) {
    for (const c of cases.filter((x) => x.quick)) {
      console.log(`terminal-bench: pulling ${c.image}`);
      run('docker', ['pull', '-q', c.image]);
    }
  }
}

if (want('omnidocbench')) await omnidocbench();
if (want('bfcl')) await bfcl();
if (want('mmmu-pro')) await mmmuPro();
if (want('terminal-bench')) await terminalBench();
