/**
 * The session page's state, kept out of the component so it can be tested on its own: the shape the page renders
 * (ViewState), how the stored session becomes that state (fromDetail), how each live event updates it (apply), and
 * the execution times shown while it runs (runTime, sessionTotal).
 */
import type { CheckResult, CriterionScore } from '@/db/schema';
import type { SessionEvent } from '@/lib/runner/events';
import { fmtDuration } from '@/components/score';
import { runExecMs, sessionExecMs } from '@/lib/timing';

export interface JudgeCell {
  score: number | null;
  rationale?: string;
  criteria?: CriterionScore[];
  cached?: boolean;
  error?: string;
  withoutAttachments?: boolean;
}
export interface CaseCell {
  status: 'running' | 'done';
  caseResultId?: number;
  output: string;
  reasoning?: string;
  data?: unknown;
  error?: string;
  checks: CheckResult[];
  autoScore: number | null;
  metrics: {
    latencyMs?: number | null;
    ttftMs?: number | null;
    tokensOut?: number | null;
    reasoningTokens?: number | null;
    tokPerSec?: number | null;
    execMs?: number | null;
  };
  judgments: Record<string, JudgeCell>;
}
export interface RunState {
  id: number;
  label: string;
  model: { name: string; parameterSize: string | null; quantization: string | null; digest: string };
  status: string;
  error?: string | null;
  loadMs?: number | null;
  role: 'candidate' | 'baseline';
  stats?: Record<string, number | string> | null;
  autoScore: number | null;
  judgeScores: Record<string, number | null>;
  judgeAvg: number | null;
  avgTokPerSec?: number | null;
  avgLatencyMs?: number | null;
  startedAt: number | null;
  execMs: number | null;
  finishedAt: number | null;
  cases: Record<string, CaseCell>;
}
export interface ViewState {
  testName: string;
  lang: string;
  status: string;
  phase?: string;
  error?: string | null;
  createdAt: number;
  finishedAt: number | null;
  config: {
    subset: string;
    think: boolean;
    temperature: number;
    seed: number;
    numCtx: number;
    numCtxRequested?: number;
    judges: string[];
    ollamaVersion?: string;
    sdk?: Record<string, string>;
    extra?: Record<string, string>;
  };
  suiteVersion: string;
  cases: { id: string; title: string }[];
  judges: { id: string; label: string; modelId: string }[];
  runs: RunState[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function fromDetail(d: any): ViewState {
  return {
    testName: d.testName,
    lang: d.lang,
    status: d.status,
    error: d.error,
    createdAt: d.createdAt,
    finishedAt: d.finishedAt ?? null,
    config: d.config,
    suiteVersion: d.suiteVersion,
    cases: d.cases,
    judges: d.judges,
    runs: d.runs.map((r: any) => ({
      id: r.id,
      label: r.blindLabel,
      role: r.role,
      stats: r.stats,
      model: r.model,
      status: r.status,
      error: r.error,
      loadMs: r.loadMs,
      autoScore: r.autoScore,
      judgeScores: r.judgeScores ?? {},
      judgeAvg: r.judgeAvg,
      avgTokPerSec: r.avgTokPerSec,
      avgLatencyMs: r.avgLatencyMs,
      startedAt: r.startedAt ?? null,
      execMs: r.execMs ?? null,
      finishedAt: r.finishedAt ?? null,
      cases: Object.fromEntries(
        r.cases.map((c: any) => [
          c.caseId,
          {
            status: 'done',
            caseResultId: c.id,
            output: c.output ?? '',
            reasoning: c.reasoning ?? undefined,
            data: c.data ?? undefined,
            error: c.error ?? undefined,
            checks: c.checks ?? [],
            autoScore: c.autoScore,
            metrics: c,
            judgments: Object.fromEntries(
              c.judgments.map((j: any) => [
                j.judge,
                {
                  score: j.score,
                  rationale: j.rationale,
                  criteria: j.criteria,
                  cached: j.cached,
                  error: j.error,
                  withoutAttachments: j.withoutAttachments,
                },
              ]),
            ),
          } satisfies CaseCell,
        ]),
      ),
    })),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function apply(s: ViewState, e: SessionEvent): ViewState {
  const runs = s.runs.map((r) => ({ ...r, cases: { ...r.cases } }));
  const run = 'runId' in e ? runs.find((r) => r.id === e.runId) : undefined;
  switch (e.type) {
    case 'session':
      return { ...s, status: 'running', phase: e.status };
    case 'run-status':
      if (run) {
        // live timestamps (client clock) until the reload at session end brings the stored ones
        const at = Date.now();
        Object.assign(run, {
          status: e.status,
          loadMs: e.loadMs ?? run.loadMs,
          error: e.error,
          startedAt: run.startedAt ?? at,
          finishedAt: e.status === 'done' || e.status === 'error' ? at : run.finishedAt,
        });
      }
      break;
    case 'case-start':
      if (run) run.cases[e.caseId] = { status: 'running', output: '', checks: [], autoScore: null, metrics: {}, judgments: {} };
      break;
    case 'delta':
      if (run && run.cases[e.caseId]) run.cases[e.caseId] = { ...run.cases[e.caseId], output: run.cases[e.caseId].output + e.text };
      break;
    case 'case-end':
      if (run)
        run.cases[e.caseId] = {
          ...(run.cases[e.caseId] ?? { judgments: {} }),
          status: 'done',
          caseResultId: e.caseResultId,
          output: e.output,
          reasoning: e.reasoning,
          data: e.data,
          error: e.error,
          checks: e.checks,
          autoScore: e.autoScore,
          metrics: e.metrics,
        };
      break;
    case 'judgment':
      if (run && run.cases[e.caseId]) {
        const c = run.cases[e.caseId];
        run.cases[e.caseId] = {
          ...c,
          judgments: {
            ...c.judgments,
            [e.judge]: {
              score: e.score,
              rationale: e.rationale,
              cached: e.cached,
              error: e.error,
              withoutAttachments: e.withoutAttachments,
            },
          },
        };
      }
      break;
    case 'run-scores':
      if (run) Object.assign(run, { autoScore: e.autoScore, judgeScores: e.judgeScores, judgeAvg: e.judgeAvg });
      break;
    case 'session-end':
      return { ...s, runs, status: e.status, error: e.error, phase: undefined, finishedAt: Date.now() };
  }
  return { ...s, runs };
}

export function avgOf(r: RunState, k: 'latencyMs' | 'tokPerSec') {
  const v = Object.values(r.cases)
    .map((c) => c.metrics[k])
    .filter((x): x is number => typeof x === 'number');
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/** Time so far of a run still in progress (a live estimate: its checks are in it); null otherwise. */
export function liveRunMs(r: RunState, now: number): number | null {
  return (r.status === 'loading' || r.status === 'running') && r.startedAt != null && r.finishedAt == null ? now - r.startedAt : null;
}

/** A run's execution time: stored once done, ticking while it runs. */
export function runTime(r: RunState, now: number): string {
  if (r.status === 'done') return fmtDuration(runExecMs(r));
  const live = liveRunMs(r, now);
  return live != null ? `${fmtDuration(live)}…` : '–';
}

/**
 * The header's total: the models' execution times, judging excluded. Stored once finished (also while a re-judge
 * reopens the session); while the models run, the finished runs plus the current one so far (live: true).
 */
export function sessionTotal(state: ViewState, now: number): { ms: number | null; live: boolean } | null {
  const running = state.status === 'running' || state.status === 'queued';
  if (state.finishedAt != null) return { ms: sessionExecMs({ status: 'done' }, state.runs), live: false };
  if (!running || !state.runs.some((r) => r.startedAt != null)) return null;
  return {
    ms: state.runs.reduce((sum, r) => sum + (runExecMs(r) ?? liveRunMs(r, now) ?? 0), 0),
    live: state.runs.some((r) => r.status === 'loading' || r.status === 'running'),
  };
}

/** Case ids in fixture order, then any the fixtures no longer have (renamed or removed since the run). */
export function visibleCaseIds(state: ViewState): string[] {
  const known = state.cases.map((c) => c.id).filter((cid) => state.runs.some((r) => r.cases[cid]));
  const extra = [...new Set(state.runs.flatMap((r) => Object.keys(r.cases)))].filter((x) => !known.includes(x));
  return [...known, ...extra];
}

/** Judges this far apart (highest − lowest score) on one case are flagged as disagreeing. */
export const DISAGREEMENT = 4;

/** Mean and spread of the judges' scores on one case (judges with no score left out). */
export function judgeSpread(cell: CaseCell, judgeIds: string[]): { avg: number | null; spread: number } {
  const judged = judgeIds.map((j) => cell.judgments[j]?.score).filter((x): x is number => typeof x === 'number');
  return {
    avg: judged.length ? judged.reduce((a, b) => a + b, 0) / judged.length : null,
    spread: judged.length > 1 ? Math.max(...judged) - Math.min(...judged) : 0,
  };
}
