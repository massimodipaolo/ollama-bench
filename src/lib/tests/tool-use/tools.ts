import 'server-only';
import { tool } from 'ai';
import { z } from 'zod';
import Papa from 'papaparse';
import { readSourceFile } from '../fixtures';

interface Institution {
  giin: string;
  name: string;
  country: string;
  category: string;
}

let cache: Institution[] | null = null;
export function institutions(): Institution[] {
  if (cache) return cache;
  const rows = Papa.parse<{ GIIN: string; FINm: string; CountryNm: string }>(readSourceFile('FFIListExample3.0.csv').toString('utf8'), {
    header: true,
    skipEmptyLines: true,
  }).data;
  cache = rows.map((r) => ({
    giin: r.GIIN.trim(),
    name: r.FINm.trim(),
    country: r.CountryNm.trim(),
    category: r.GIIN.split('.')[2] ?? '',
  }));
  return cache;
}

/** Safe arithmetic: digits, + - * / ( ) . % and spaces only. */
export function calc(expression: string): number {
  const expr = expression.replace(/,/g, '.').replace(/×/g, '*').replace(/÷/g, '/');
  if (!/^[\d\s+\-*/().%]+$/.test(expr)) throw new Error('Only numbers and + - * / ( ) % are allowed');
  const js = expr.replace(/(\d+(?:\.\d+)?)\s*%/g, '($1/100)');
  const v = Function(`"use strict"; return (${js});`)() as unknown;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('Invalid expression');
  return Math.round(v * 1e10) / 1e10;
}

function addDaysIso(date: string, days: number): string {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error('date must be YYYY-MM-DD');
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The tool set offered to the model in every tool-use case (same tools, so choosing well is part of the test). */
export function benchmarkTools() {
  return {
    lookupInstitution: tool({
      description: 'Look up a financial institution in the FFI list by its exact GIIN (Global Intermediary Identification Number).',
      inputSchema: z.object({ giin: z.string().describe('GIIN, format XXXXXX.XXXXX.XX.XXX') }),
      execute: async ({ giin }) => {
        const hit = institutions().find((i) => i.giin.toUpperCase() === giin.trim().toUpperCase());
        return hit ? { found: true, ...hit } : { found: false, giin, message: 'No institution with this GIIN in the FFI list.' };
      },
    }),
    searchInstitutions: tool({
      description: 'Search the FFI list. All filters are optional and combined with AND. Country names are in English.',
      inputSchema: z.object({
        country: z.string().optional().describe('country name in English, exact match (case-insensitive)'),
        nameContains: z.string().optional().describe('case-insensitive substring of the institution name'),
        category: z.string().optional().describe('GIIN category code, e.g. LE, BR, ME, SP'),
      }),
      execute: async ({ country, nameContains, category }) => {
        const res = institutions().filter(
          (i) =>
            (!country || i.country.toLowerCase() === country.trim().toLowerCase()) &&
            (!nameContains || i.name.toLowerCase().includes(nameContains.trim().toLowerCase())) &&
            (!category || i.category.toUpperCase() === category.trim().toUpperCase()),
        );
        return { count: res.length, results: res.slice(0, 50) };
      },
    }),
    refundTimeline: tool({
      description: 'IRS refund timeline rules: when the taxpayer can start checking the refund status, and the typical refund window.',
      inputSchema: z.object({ filingMethod: z.enum(['e-file', 'paper']) }),
      execute: async ({ filingMethod }) =>
        filingMethod === 'e-file'
          ? { checkStatusAfterHours: 72, refundWithinDays: { min: 10, max: 21 }, tool: "Where's My Refund" }
          : {
              checkStatusAfterWeeks: 4,
              refundWithinDays: null,
              note: 'Paper returns take longer; no typical window published.',
              tool: "Where's My Refund",
            },
    }),
    addDays: tool({
      description: 'Add (or subtract, with a negative number) a number of days to a date.',
      inputSchema: z.object({ date: z.string().describe('YYYY-MM-DD'), days: z.number().int() }),
      execute: async ({ date, days }) => ({ date: addDaysIso(date, days) }),
    }),
    calculator: tool({
      description: 'Evaluate an arithmetic expression, e.g. "2/5*100".',
      inputSchema: z.object({ expression: z.string() }),
      execute: async ({ expression }) => ({ result: calc(expression) }),
    }),
  };
}

export function toolCatalog(): string {
  return Object.entries(benchmarkTools())
    .map(([name, t]) => `- ${name}: ${t.description}`)
    .join('\n');
}
