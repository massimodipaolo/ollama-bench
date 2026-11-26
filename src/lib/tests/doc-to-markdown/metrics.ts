import type { CheckResult } from '@/db/schema';
import { stringsMatch } from '../compare';

/** Plain words of a Markdown text (markup stripped, quotes/dashes normalized, lowercased). */
export function words(md: string): string[] {
  const plain = md
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .normalize('NFKC');
  return plain.match(/[\p{L}\p{N}]+(?:['.,][\p{L}\p{N}]+)*/gu) ?? [];
}

function multisetOverlap(a: string[], b: string[]): number {
  const m = new Map<string, number>();
  for (const x of b) m.set(x, (m.get(x) ?? 0) + 1);
  let n = 0;
  for (const x of a) {
    const c = m.get(x) ?? 0;
    if (c > 0) {
      n++;
      m.set(x, c - 1);
    }
  }
  return n;
}

export function headings(md: string): { level: number; text: string }[] {
  return md
    .split(/\r?\n/)
    .map((l) => l.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ level: m[1].length, text: m[2].replace(/[*_`]/g, '').trim() }));
}

/** GFM tables: blocks of `|` lines with a separator row. Returns the cells of each table (header included). */
export function tables(md: string): string[][][] {
  const lines = md.split(/\r?\n/);
  const out: string[][][] = [];
  let cur: string[][] | null = null;
  const split = (l: string) =>
    l
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split(/(?<!\\)\|/)
      .map((c) => c.trim());
  const isSeparator = (l: string) => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(l);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (isSeparator(l) && i > 0 && lines[i - 1].includes('|')) {
      // the separator opens a table whose header is the previous line
      if (cur) out.push(cur);
      cur = [split(lines[i - 1])];
      continue;
    }
    if (cur && l.includes('|')) {
      cur.push(split(l));
      continue;
    }
    if (cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const normCell = (c: string) =>
  c
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/[*_`]/g, '')
    .replace(/\\\|/g, '|')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

function listItems(md: string): number {
  return md.split(/\r?\n/).filter((l) => /^\s*([-*+]|\d+[.)])\s+\S/.test(l)).length;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

const boldSpans = (md: string) => (md.match(/\*\*[^*\n]+?\*\*|__[^_\n]+?__/g) ?? []).length;
const linkTargets = (md: string) =>
  [...md.matchAll(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g)].map((m) =>
    m[2]
      .replace(/^https?:\/\/(www\.)?/i, '')
      .replace(/\/$/, '')
      .toLowerCase(),
  );

/** Automatic checks of a Markdown conversion against the reference. `forbid`: page furniture that must be removed. */
export function markdownChecks(output: string, reference: string, forbid: string[] = []): CheckResult[] {
  const checks: CheckResult[] = [];
  const out = output.trim();

  const clean = !/^```/.test(out) && !/^(here is|here's|sure|certo|ecco|di seguito)\b/i.test(out);
  checks.push({ name: 'clean output (no fences/preamble)', pass: clean });

  const gw = words(reference);
  const ow = words(out);
  const common = multisetOverlap(gw, ow);
  const recall = gw.length ? common / gw.length : 1;
  const precision = ow.length ? common / ow.length : 0;
  checks.push({
    name: `content recall ${pct(recall)}`,
    pass: recall >= 0.95,
    value: recall,
    detail: `${common}/${gw.length} reference words present`,
  });
  checks.push({
    name: `content precision ${pct(precision)}`,
    pass: precision >= 0.9,
    value: precision,
    detail: `${ow.length - common} extra/changed words`,
  });

  const ratio = gw.length ? ow.length / gw.length : 0;
  checks.push({ name: 'length 85–120% of reference', pass: ratio >= 0.85 && ratio <= 1.2, detail: `${pct(ratio)}` });

  const gh = headings(reference);
  if (gh.length) {
    const oh = headings(out);
    const used = new Set<number>();
    let hit = 0;
    let levelOk = 0;
    for (const h of gh) {
      const j = oh.findIndex((x, i) => !used.has(i) && stringsMatch(h.text, x.text));
      if (j >= 0) {
        used.add(j);
        hit++;
        if (oh[j].level === h.level) levelOk++;
      }
    }
    const v = hit / gh.length;
    checks.push({ name: `headings ${hit}/${gh.length}`, pass: v >= 0.9, value: v, detail: `${oh.length} headings in output` });
    if (hit) {
      const lv = levelOk / hit;
      checks.push({ name: `heading levels ${levelOk}/${hit}`, pass: lv >= 0.9, value: lv });
    }
  }

  const gt = tables(reference);
  if (gt.length) {
    const ot = tables(out);
    const gCells = gt.flat(2).map(normCell).filter(Boolean);
    const oCells = ot.flat(2).map(normCell).filter(Boolean);
    const hit = multisetOverlap(gCells, oCells);
    const v = gCells.length ? hit / gCells.length : 1;
    checks.push({
      name: `table cells ${pct(v)}`,
      pass: v >= 0.95,
      value: v,
      detail: `${hit}/${gCells.length} reference cells found in ${ot.length} output table(s) (reference: ${gt.length})`,
    });
    const gRows = gt.reduce((s, t) => s + t.length, 0);
    const oRows = ot.reduce((s, t) => s + t.length, 0);
    checks.push({ name: 'table rows', pass: Math.abs(oRows - gRows) <= Math.max(1, gRows * 0.02), detail: `${oRows} rows vs ${gRows}` });
  }

  const gb = boldSpans(reference);
  const ob = boldSpans(out);
  if (gb >= 5) {
    // only where the reference uses emphasis meaningfully (extracted text carries no bold information)
    // spurious or missing emphasis: penalize the relative difference
    const diff = Math.abs(ob - gb) / Math.max(gb, 1);
    checks.push({ name: 'bold emphasis', pass: diff <= 0.3, value: Math.max(0, 1 - diff), detail: `${ob} bold spans vs ${gb}` });
  }

  const gLinks = linkTargets(reference);
  if (gLinks.length) {
    const oLinks = linkTargets(out);
    const hit = gLinks.filter((u) => oLinks.some((o) => o === u || o.endsWith(u) || u.endsWith(o))).length;
    checks.push({ name: `links ${hit}/${gLinks.length}`, pass: hit === gLinks.length, value: hit / gLinks.length });
  }

  if (forbid.length) {
    const lo = out.toLowerCase();
    const found = forbid.filter((f) => lo.includes(f.toLowerCase()));
    checks.push({
      name: 'page furniture removed',
      pass: !found.length,
      value: 1 - found.length / forbid.length,
      detail: found.length ? `still present: ${found.join(', ')}` : undefined,
    });
  }

  const gl = listItems(reference);
  if (gl >= 3) {
    const ol = listItems(out);
    const r = ol / gl;
    checks.push({ name: 'list items', pass: r >= 0.8 && r <= 1.25, value: Math.max(0, 1 - Math.abs(1 - r)), detail: `${ol} vs ${gl}` });
  }
  return checks;
}
