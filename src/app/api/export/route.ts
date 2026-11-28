import { connection, type NextRequest } from 'next/server';
import { inArray } from 'drizzle-orm';
import { getDb, schema } from '@/db';
import { runRows, type RunRow } from '@/lib/queries';

const JUDGES = ['openai', 'google', 'anthropic'];

function csvCell(v: unknown): string {
  if (v == null) return '';
  const raw = typeof v === 'object' ? JSON.stringify(v) : String(v);
  const s = /^[\u0000-\u0020]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

const runCols = (r: RunRow) => [
  new Date(r.date).toISOString(),
  r.sessionId,
  r.testId,
  r.lang,
  r.variant,
  r.subset,
  r.think,
  r.suiteVersion,
  r.model,
  r.provider,
  r.digest,
  r.quantization,
  r.role,
  r.ollamaVersion,
  r.sdk['ai'],
  r.sdk['ai-sdk-ollama'],
  r.sdk['ollama'],
  Object.entries(r.sdk)
    .map(([k, v]) => `${k}@${v}`)
    .join(' '),
];
const RUN_HEAD = [
  'date',
  'session_id',
  'test',
  'lang',
  'variant',
  'subset',
  'think',
  'suite_version',
  'model',
  'provider',
  'digest',
  'quantization',
  'role',
  'ollama_version',
  'ai',
  'ai_sdk_ollama',
  'ollama_js',
  'sdk_all',
];

/**
 * CSV export. ?level=run (default) one row per model run; ?level=case one row per case result.
 * Filters: ?testId=…  ?model=… (model name, all digests).
 */
export async function GET(req: NextRequest) {
  await connection();
  const p = req.nextUrl.searchParams;
  const level = p.get('level') === 'case' ? 'case' : 'run';
  const runs = runRows({ testId: p.get('testId') ?? undefined, model: p.get('model') ?? undefined });
  let body: string;

  if (level === 'run') {
    body = csv([
      [
        ...RUN_HEAD,
        ...JUDGES.map((j) => `judge_${j}`),
        'judge_avg',
        'auto',
        'avg_latency_ms',
        'avg_ttft_ms',
        'avg_tok_s',
        'load_ms',
        'exec_ms',
        'stats',
      ],
      ...runs.map((r) => [
        ...runCols(r),
        ...JUDGES.map((j) => r.judgeScores[j]),
        r.judgeAvg,
        r.autoScore,
        r.avgLatencyMs?.toFixed(0),
        r.avgTtftMs?.toFixed(0),
        r.avgTokPerSec?.toFixed(1),
        r.loadMs?.toFixed(0),
        r.execMs?.toFixed(0),
        r.stats,
      ]),
    ]);
  } else {
    const db = getDb();
    const byRun = new Map(runs.map((r) => [r.runId, r]));
    const crs = runs.length
      ? db
          .select()
          .from(schema.caseResults)
          .where(inArray(schema.caseResults.runId, [...byRun.keys()]))
          .all()
      : [];
    const js = crs.length
      ? db
          .select()
          .from(schema.judgments)
          .where(
            inArray(
              schema.judgments.caseResultId,
              crs.map((c) => c.id),
            ),
          )
          .all()
      : [];
    body = csv([
      [
        ...RUN_HEAD,
        'case_id',
        ...JUDGES.map((j) => `judge_${j}`),
        'auto',
        'failed_checks',
        'latency_ms',
        'ttft_ms',
        'tokens_in',
        'tokens_out',
        'tok_s',
        'exec_ms',
        'error',
        'output',
      ],
      ...crs.map((c) => {
        const r = byRun.get(c.runId)!;
        const mine = js.filter((j) => j.caseResultId === c.id);
        return [
          ...runCols(r),
          c.caseId,
          ...JUDGES.map((j) => mine.find((x) => x.judge === j)?.score),
          c.autoScore,
          (c.checks ?? [])
            .filter((x) => !x.pass)
            .map((x) => x.name)
            .join('; '),
          c.latencyMs?.toFixed(0),
          c.ttftMs?.toFixed(0),
          c.tokensIn,
          c.tokensOut,
          c.tokPerSec?.toFixed(1),
          c.execMs?.toFixed(0),
          c.error,
          c.output,
        ];
      }),
    ]);
  }

  const name = ['ollama-bench', p.get('testId'), p.get('model')?.replace(/[^\w.-]+/g, '_'), level].filter(Boolean).join('-');
  // BOM so Excel opens UTF-8 correctly
  return new Response('﻿' + body, {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.csv"` },
  });
}
