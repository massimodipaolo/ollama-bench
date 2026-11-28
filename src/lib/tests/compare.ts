/**
 * Field-level comparison of an extracted object against ground truth.
 * Leaves are compared leniently (normalized/fuzzy strings, tolerant numbers, normalized dates);
 * arrays of primitives as sets; arrays of objects matched by a key field (or index).
 */

export interface CompareRules {
  /** path (dot notation, arrays without index, e.g. "institutions") → key field used to align array items */
  arrayKeys?: Record<string, string>;
  /** paths ignored for accuracy (free text evaluated by judges), e.g. ["summary", "action.replyText"] */
  ignore?: string[];
  /**
   * relative tolerance for decimal numbers (default 0.005): rounding of percentages, rates, amounts with cents.
   * Integers (years, counts, ids, whole amounts) always match exactly: 0.5% of a year would accept ±10 years.
   */
  numberTolerance?: number;
}

export interface Mismatch {
  path: string;
  expected: unknown;
  actual: unknown;
}

export interface CompareResult {
  matched: number;
  total: number;
  mismatches: Mismatch[];
}

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'for', 'il', 'la', 'di', 'e']);

export function normStr(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}'.\-/ ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/, '')
    .trim();
}

function tokens(s: string) {
  return new Set(
    normStr(s)
      .split(/[\s\-/]+/)
      .map((t) => t.replace(/s$/, ''))
      .filter((t) => t && !STOP.has(t)),
  );
}

/** Dates in many shapes → YYYY-MM-DD (or null). */
export function normDate(s: string): string | null {
  const t = s.trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // US m/d/yyyy
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

export function stringsMatch(expected: string, actual: string): boolean {
  // "Internal Revenue Service || IRS" → any alternative matches
  if (expected.includes('||')) return expected.split('||').some((alt) => stringsMatch(alt.trim(), actual));
  const de = normDate(expected);
  if (de) return de === normDate(actual);
  const a = normStr(expected);
  const b = normStr(actual);
  if (a === b) return true;
  if (!a || !b) return false;
  // short codes (GIINs, postal codes, ids) must match exactly
  if (a.length <= 12 && !a.includes(' ')) return a === b;
  const ta = tokens(expected);
  const tb = tokens(actual);
  const inter = [...ta].filter((x) => tb.has(x)).length;
  const jaccard = inter / (ta.size + tb.size - inter || 1);
  // every expected token present and the answer not wildly longer (verbatim copy with extra qualifiers)
  return jaccard >= 0.6 || (inter === ta.size && tb.size <= Math.max(ta.size + 2, ta.size * 4));
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function leafMatch(e: unknown, a: unknown, tol: number): boolean {
  if (typeof e === 'number') {
    const n = typeof a === 'number' ? a : typeof a === 'string' ? Number(a.replace(',', '.')) : NaN;
    if (!Number.isFinite(n)) return false;
    if (Number.isInteger(e)) return n === e;
    return Math.abs(n - e) <= Math.max(1e-9, Math.abs(e) * tol);
  }
  if (typeof e === 'boolean') return a === e || (typeof a === 'string' && a.toLowerCase() === String(e));
  if (typeof e === 'string') return (typeof a === 'string' || typeof a === 'number') && stringsMatch(e, String(a));
  if (e === null) return a === null || a === undefined || a === '';
  return false;
}

function countLeaves(v: unknown): number {
  if (Array.isArray(v)) return v.reduce((s: number, x) => s + countLeaves(x), 0) || 1;
  if (isObj(v)) return Object.values(v).reduce((s: number, x) => s + countLeaves(x), 0) || 1;
  return 1;
}

export function compareObjects(expected: unknown, actual: unknown, rules: CompareRules = {}): CompareResult {
  const tol = rules.numberTolerance ?? 0.005;
  const ignore = new Set(rules.ignore ?? []);
  const res: CompareResult = { matched: 0, total: 0, mismatches: [] };

  const walk = (e: unknown, a: unknown, path: string) => {
    if (ignore.has(path)) return;
    if (Array.isArray(e)) {
      const arr = Array.isArray(a) ? a : [];
      const key = rules.arrayKeys?.[path];
      if (e.every((x) => !isObj(x) && !Array.isArray(x))) {
        // set semantics for primitive arrays; extra items count as errors
        const used = new Set<number>();
        for (const item of e) {
          res.total++;
          const idx = arr.findIndex((x, i) => !used.has(i) && leafMatch(item, x, tol));
          if (idx >= 0) {
            used.add(idx);
            res.matched++;
          } else res.mismatches.push({ path: `${path}[]`, expected: item, actual: undefined });
        }
        arr.forEach((x, i) => {
          if (!used.has(i)) {
            res.total++;
            res.mismatches.push({ path: `${path}[]`, expected: undefined, actual: x });
          }
        });
        return;
      }
      const used = new Set<number>();
      e.forEach((item, i) => {
        let j = i;
        if (key && isObj(item)) j = arr.findIndex((x, k) => !used.has(k) && isObj(x) && leafMatch(item[key], x[key], tol));
        if (j >= 0 && j < arr.length) used.add(j);
        walk(item, j >= 0 ? arr[j] : undefined, path);
      });
      arr.forEach((x, i) => {
        if (!used.has(i)) {
          res.total += 1;
          res.mismatches.push({ path: `${path}[]`, expected: undefined, actual: x });
        }
      });
      return;
    }
    if (isObj(e)) {
      if (!isObj(a)) {
        const n = countLeaves(e);
        res.total += n;
        res.mismatches.push({ path: path || '(root)', expected: e, actual: a });
        return;
      }
      for (const [k, v] of Object.entries(e)) walk(v, a[k], path ? `${path}.${k}` : k);
      return;
    }
    res.total++;
    if (leafMatch(e, a, tol)) res.matched++;
    else res.mismatches.push({ path, expected: e, actual: a });
  };

  walk(expected, actual, '');
  return res;
}

/** Pick a value at a dot path (no array indexes). */
export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), obj);
}
