#!/usr/bin/env node
/**
 * Local MCP server (stdio) for the MCP test. It exposes the SAME tools as the native tool-use test, so a model's MCP
 * score is directly comparable with its native tool-calling score, plus an MCP Apps surface:
 *   - showDashboard        model-visible, linked to the ui://benchmark/dashboard resource
 *   - refreshDashboardData app-only (_meta.ui.visibility = ['app']): a host must NOT give it to the model
 *
 * Spawned by the app (cwd = project root): `node scripts/mcp/benchmark-server.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import Papa from 'papaparse';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const csv = fs.readFileSync(path.join(process.cwd(), '.data', 'files', 'FFIListExample3.0.csv'), 'utf8');
const institutions = Papa.parse(csv, { header: true, skipEmptyLines: true }).data.map((r) => ({
  giin: r.GIIN.trim(),
  name: r.FINm.trim(),
  country: r.CountryNm.trim(),
  category: r.GIIN.split('.')[2] ?? '',
}));

const json = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });

function calc(expression) {
  const expr = expression.replace(/,/g, '.').replace(/×/g, '*').replace(/÷/g, '/');
  if (!/^[\d\s+\-*/().%]+$/.test(expr)) throw new Error('Only numbers and + - * / ( ) % are allowed');
  const v = Function(`"use strict"; return (${expr.replace(/(\d+(?:\.\d+)?)\s*%/g, '($1/100)')});`)();
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('Invalid expression');
  return Math.round(v * 1e10) / 1e10;
}

function addDaysIso(date, days) {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error('date must be YYYY-MM-DD');
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const server = new McpServer({ name: 'ollama-benchmark-mcp', version: '1.0.0' });

server.registerTool(
  'lookupInstitution',
  {
    description: 'Look up a financial institution in the FFI list by its exact GIIN (Global Intermediary Identification Number).',
    inputSchema: { giin: z.string().describe('GIIN, format XXXXXX.XXXXX.XX.XXX') },
  },
  async ({ giin }) => {
    const hit = institutions.find((i) => i.giin.toUpperCase() === giin.trim().toUpperCase());
    return json(hit ? { found: true, ...hit } : { found: false, giin, message: 'No institution with this GIIN in the FFI list.' });
  },
);

server.registerTool(
  'searchInstitutions',
  {
    description: 'Search the FFI list. All filters are optional and combined with AND. Country names are in English.',
    inputSchema: {
      country: z.string().optional().describe('country name in English, exact match (case-insensitive)'),
      nameContains: z.string().optional().describe('case-insensitive substring of the institution name'),
      category: z.string().optional().describe('GIIN category code, e.g. LE, BR, ME, SP'),
    },
  },
  async ({ country, nameContains, category }) => {
    const res = institutions.filter(
      (i) =>
        (!country || i.country.toLowerCase() === country.trim().toLowerCase()) &&
        (!nameContains || i.name.toLowerCase().includes(nameContains.trim().toLowerCase())) &&
        (!category || i.category.toUpperCase() === category.trim().toUpperCase()),
    );
    return json({ count: res.length, results: res.slice(0, 50) });
  },
);

server.registerTool(
  'refundTimeline',
  {
    description: 'IRS refund timeline rules: when the taxpayer can start checking the refund status, and the typical refund window.',
    inputSchema: { filingMethod: z.enum(['e-file', 'paper']) },
  },
  async ({ filingMethod }) =>
    json(
      filingMethod === 'e-file'
        ? { checkStatusAfterHours: 72, refundWithinDays: { min: 10, max: 21 }, tool: "Where's My Refund" }
        : {
            checkStatusAfterWeeks: 4,
            refundWithinDays: null,
            note: 'Paper returns take longer; no typical window published.',
            tool: "Where's My Refund",
          },
    ),
);

server.registerTool(
  'addDays',
  {
    description: 'Add (or subtract, with a negative number) a number of days to a date.',
    inputSchema: { date: z.string().describe('YYYY-MM-DD'), days: z.number().int() },
  },
  async ({ date, days }) => json({ date: addDaysIso(date, days) }),
);

server.registerTool(
  'calculator',
  { description: 'Evaluate an arithmetic expression, e.g. "2/5*100".', inputSchema: { expression: z.string() } },
  async ({ expression }) => json({ result: calc(expression) }),
);

// ---- MCP Apps: a UI resource, one model-visible tool and one app-only tool ----
const DASHBOARD_URI = 'ui://benchmark/dashboard';

server.registerResource(
  'institutions-dashboard',
  DASHBOARD_URI,
  { mimeType: 'text/html;profile=mcp-app', description: 'Dashboard of FFI institutions by country' },
  async () => ({
    contents: [
      {
        uri: DASHBOARD_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: `<!doctype html><html><body><h1>FFI institutions by country</h1><ul>${Object.entries(
          institutions.reduce((a, i) => ((a[i.country] = (a[i.country] ?? 0) + 1), a), {}),
        )
          .map(([c, n]) => `<li>${c}: ${n}</li>`)
          .join('')}</ul></body></html>`,
        _meta: { ui: { prefersBorder: true } },
      },
    ],
  }),
);

server.registerTool(
  'showDashboard',
  {
    description: 'Open the interactive dashboard of FFI institutions grouped by country for the user. Optionally highlight one country.',
    inputSchema: { highlightCountry: z.string().optional().describe('country name in English') },
    _meta: { ui: { resourceUri: DASHBOARD_URI, visibility: ['model', 'app'] } },
  },
  async ({ highlightCountry }) => json({ shown: true, resourceUri: DASHBOARD_URI, highlightCountry: highlightCountry ?? null }),
);

server.registerTool(
  'refreshDashboardData',
  {
    description: 'Refresh the dashboard data (called by the dashboard UI itself, never by the model).',
    inputSchema: { reason: z.string().optional() },
    _meta: { ui: { resourceUri: DASHBOARD_URI, visibility: ['app'] } },
  },
  async () => json({ refreshed: true, at: new Date().toISOString() }),
);

await server.connect(new StdioServerTransport());
