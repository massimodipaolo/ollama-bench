import type { CheckResult } from '@/db/schema';
import { LANGUAGES, type LanguageConfig } from '@/config/languages';

/** Declarative checks usable from fixture JSON. */
export type CheckSpec =
  | { type: 'maxWords'; value: number }
  | { type: 'minWords'; value: number }
  | { type: 'bulletCount'; value: number }
  | { type: 'numberedCount'; value: number }
  | { type: 'includes'; values: string[] }
  | { type: 'includesAny'; values: string[]; label?: string }
  | { type: 'excludes'; values: string[] }
  | { type: 'regex'; pattern: string; flags?: string; label?: string }
  | { type: 'notRegex'; pattern: string; flags?: string; label?: string }
  | { type: 'number'; value: number; tolerance?: number }
  | { type: 'inOrder'; values: string[]; label?: string }
  | { type: 'language' };

export function wordCount(s: string) {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

const norm = (s: string) => s.toLowerCase().normalize('NFKC');

/** Stopword-frequency language guess among configured languages. */
export function detectLanguage(text: string): { code: string; confidence: number } {
  const tokens = norm(text).match(/\p{L}+/gu) ?? [];
  if (!tokens.length) return { code: 'unknown', confidence: 0 };
  const scores = LANGUAGES.map((l) => {
    const set = new Set(l.stopwords);
    return { code: l.code, hits: tokens.filter((t) => set.has(t)).length };
  }).sort((a, b) => b.hits - a.hits);
  const total = scores.reduce((s, x) => s + x.hits, 0) || 1;
  return { code: scores[0].hits ? scores[0].code : 'unknown', confidence: scores[0].hits / total };
}

/**
 * Locale-tolerant number extraction: "2,472" / "2.472" / "2 472" → 2472 (thousands groups),
 * "0,80" / "0.80" → 0.8 (decimal). Ambiguous "1.234" is read as thousands, which is what tests expect.
 */
export function extractNumbers(s: string): number[] {
  const tokens = s.match(/-?\d{1,3}(?:[.,   ]\d{3})+(?:[.,]\d+)?(?!\d)|-?\d+(?:[.,]\d+)?/g) ?? [];
  return tokens.map((t) => {
    const grouped = t.match(/^(-?\d{1,3}(?:[.,   ]\d{3})+)(?:([.,])(\d+))?$/);
    if (grouped) {
      const intPart = grouped[1].replace(/[.,   ]/g, '');
      return Number(grouped[3] ? `${intPart}.${grouped[3]}` : intPart);
    }
    return Number(t.replace(',', '.'));
  });
}

function lines(s: string) {
  return s.split(/\r?\n/).map((l) => l.trim());
}

export function runCheck(spec: CheckSpec, output: string, lang: LanguageConfig): CheckResult {
  const out = output.trim();
  switch (spec.type) {
    case 'maxWords': {
      const n = wordCount(out);
      return { name: `≤ ${spec.value} words`, pass: n <= spec.value, detail: `${n} words` };
    }
    case 'minWords': {
      const n = wordCount(out);
      return { name: `≥ ${spec.value} words`, pass: n >= spec.value, detail: `${n} words` };
    }
    case 'bulletCount': {
      const n = lines(out).filter((l) => /^[-*•]\s+/.test(l)).length;
      return { name: `${spec.value} bullet points`, pass: n === spec.value, detail: `${n} bullets` };
    }
    case 'numberedCount': {
      const n = lines(out).filter((l) => /^\d+[.)]\s+/.test(l)).length;
      return { name: `${spec.value} numbered items`, pass: n === spec.value, detail: `${n} items` };
    }
    case 'includes': {
      const missing = spec.values.filter((v) => !norm(out).includes(norm(v)));
      return {
        name: `includes ${spec.values.map((v) => `"${v}"`).join(', ')}`,
        pass: missing.length === 0,
        value: 1 - missing.length / spec.values.length,
        detail: missing.length ? `missing: ${missing.join(', ')}` : undefined,
      };
    }
    case 'includesAny': {
      const hit = spec.values.find((v) => norm(out).includes(norm(v)));
      return {
        name: spec.label ?? `mentions one of ${spec.values.join(' / ')}`,
        pass: !!hit,
        detail: hit ? `found "${hit}"` : 'none found',
      };
    }
    case 'excludes': {
      const found = spec.values.filter((v) => norm(out).includes(norm(v)));
      return {
        name: `avoids ${spec.values.map((v) => `"${v}"`).join(', ')}`,
        pass: found.length === 0,
        detail: found.length ? `found: ${found.join(', ')}` : undefined,
      };
    }
    case 'regex': {
      const pass = new RegExp(spec.pattern, spec.flags ?? 'i').test(out);
      return { name: spec.label ?? `matches /${spec.pattern}/`, pass };
    }
    case 'notRegex': {
      const pass = !new RegExp(spec.pattern, spec.flags ?? 'i').test(out);
      return { name: spec.label ?? `does not match /${spec.pattern}/`, pass };
    }
    case 'number': {
      const tol = spec.tolerance ?? 0;
      const nums = extractNumbers(out);
      const pass = nums.some((n) => Math.abs(n - spec.value) <= tol);
      return {
        name: `answer = ${spec.value}${tol ? ` ±${tol}` : ''}`,
        pass,
        detail: nums.length ? `numbers found: ${nums.slice(-5).join(', ')}` : 'no number',
      };
    }
    case 'inOrder': {
      const o = norm(out);
      let from = 0;
      const missing: string[] = [];
      let ordered = true;
      for (const v of spec.values) {
        const i = o.indexOf(norm(v), from);
        if (i < 0) {
          const anywhere = o.indexOf(norm(v));
          if (anywhere < 0) missing.push(v);
          else ordered = false;
        } else from = i + norm(v).length;
      }
      const found = spec.values.length - missing.length;
      return {
        name: spec.label ?? `${spec.values.length} items in order`,
        pass: !missing.length && ordered,
        value: (found / spec.values.length) * (ordered ? 1 : 0.5),
        detail:
          [missing.length ? `missing: ${missing.join(', ')}` : '', ordered ? '' : 'wrong order'].filter(Boolean).join('; ') || undefined,
      };
    }
    case 'language': {
      const d = detectLanguage(out);
      return {
        name: `answers in ${lang.englishName}`,
        pass: d.code === lang.code,
        detail: `detected ${d.code} (${Math.round(d.confidence * 100)}%)`,
      };
    }
  }
}

/** 0–10 auto score: mean of check values (partial credit where provided). */
export function autoScore(checks: CheckResult[]): number | null {
  if (!checks.length) return null;
  const v = checks.reduce((s, c) => s + (c.value ?? (c.pass ? 1 : 0)), 0) / checks.length;
  return Math.round(v * 100) / 10;
}
