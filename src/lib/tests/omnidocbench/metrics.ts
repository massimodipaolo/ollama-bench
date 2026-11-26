import type { CheckResult } from '@/db/schema';
import { tables as mdTables } from '../doc-to-markdown/metrics';

/**
 * OmniDocBench-style metrics, adapted:
 * - text: 1 − normalized edit distance (NED) between reference text blocks and the prediction's text (tables and
 *   display equations removed), as in OmniDocBench's text metric;
 * - tables: cell-level F1 (HTML or Markdown tables) instead of TEDS (tree edit distance is not ported);
 * - formulas: 1 − NED per reference display equation (best match among predicted ones) instead of CDM (needs TeX).
 */

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (a.length > b.length) [a, b] = [b, a];
  let prev = Array.from({ length: a.length + 1 }, (_, i) => i);
  let cur = new Array<number>(a.length + 1);
  for (let j = 1; j <= b.length; j++) {
    cur[0] = j;
    const bj = b.charCodeAt(j - 1);
    for (let i = 1; i <= a.length; i++) {
      cur[i] = Math.min(prev[i] + 1, cur[i - 1] + 1, prev[i - 1] + (a.charCodeAt(i - 1) === bj ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[a.length];
}

/** Normalized edit distance; very long pairs fall back to word-level tokens to bound the cost. */
export function ned(a: string, b: string): number {
  if (!a.length && !b.length) return 0;
  if (a.length * b.length > 40_000_000) {
    const wa = a.split(' ');
    const wb = b.split(' ');
    const vocab = new Map<string, string>();
    const enc = (w: string) => vocab.get(w) ?? (vocab.set(w, String.fromCharCode(0xe000 + vocab.size)), vocab.get(w)!);
    return levenshtein(wa.map(enc).join(''), wb.map(enc).join('')) / Math.max(wa.length, wb.length);
  }
  return levenshtein(a, b) / Math.max(a.length, b.length);
}

const normText = (s: string) =>
  s
    .normalize('NFKC')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#*_`>|$\\]/g, ' ')
    .replace(/^\s*([-+]|\d+[.)])\s+/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const HTML_TABLE = /<table[\s\S]*?<\/table>/gi;
const DISPLAY_EQ = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]/g;

/** Prediction text without tables and display equations. */
function predictionText(md: string): string {
  return md
    .replace(HTML_TABLE, ' ')
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('|'))
    .join('\n')
    .replace(DISPLAY_EQ, ' ');
}

const normCell = (s: string) => normText(s).replace(/\s+/g, '');

function htmlCells(html: string): string[] {
  return [...html.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => normCell(m[1])).filter(Boolean);
}

function multisetF1(ref: string[], pred: string[]): number {
  if (!ref.length && !pred.length) return 1;
  const m = new Map<string, number>();
  for (const x of pred) m.set(x, (m.get(x) ?? 0) + 1);
  let hit = 0;
  for (const x of ref) {
    const c = m.get(x) ?? 0;
    if (c > 0) {
      hit++;
      m.set(x, c - 1);
    }
  }
  const p = pred.length ? hit / pred.length : 0;
  const r = ref.length ? hit / ref.length : 0;
  return p + r ? (2 * p * r) / (p + r) : 0;
}

const normEq = (s: string) =>
  s
    .replace(/^\$\$|\$\$$|^\\\[|\\\]$/g, '')
    .replace(/\\(left|right|displaystyle|mathrm|textstyle|,|;|!|quad|qquad)\b/g, '')
    .replace(/\s+/g, '');

export interface OdbRef {
  text: string[];
  tables: string[];
  equations: string[];
}

export function odbChecks(output: string, ref: OdbRef): CheckResult[] {
  const out = output.trim();
  const checks: CheckResult[] = [];
  checks.push({ name: 'clean output (no fences/preamble)', pass: !/^```/.test(out) && !/^(here is|here's|sure)\b/i.test(out) });

  const refText = normText(ref.text.join(' '));
  const predText = normText(predictionText(out));
  const textSim = 1 - ned(refText, predText);
  checks.push({
    name: `text similarity ${Math.round(textSim * 100)}%`,
    pass: textSim >= 0.9,
    value: textSim,
    detail: `1 − normalized edit distance (${refText.length} reference chars)`,
  });

  if (ref.tables.length) {
    const refCells = ref.tables.flatMap(htmlCells);
    const predCells = [...(out.match(HTML_TABLE) ?? []).flatMap(htmlCells), ...mdTables(out).flat(2).map(normCell).filter(Boolean)];
    const f1 = multisetF1(refCells, predCells);
    checks.push({
      name: `table cells F1 ${Math.round(f1 * 100)}%`,
      pass: f1 >= 0.9,
      value: f1,
      detail: `${refCells.length} reference cells, ${predCells.length} predicted (cell-level F1, not TEDS)`,
    });
  }

  if (ref.equations.length) {
    const preds = (out.match(DISPLAY_EQ) ?? []).map(normEq);
    const scores = ref.equations.map((e) => {
      const n = normEq(e);
      return preds.length ? Math.max(...preds.map((p) => 1 - ned(n, p))) : 0;
    });
    const v = scores.reduce((a, b) => a + b, 0) / scores.length;
    checks.push({
      name: `formula similarity ${Math.round(v * 100)}%`,
      pass: v >= 0.8,
      value: v,
      detail: `${ref.equations.length} display equations, ${preds.length} predicted (1 − NED of normalized LaTeX, not CDM)`,
    });
  }
  return checks;
}
