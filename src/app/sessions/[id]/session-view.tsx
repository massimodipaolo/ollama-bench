'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { SessionEvent } from '@/lib/runner/events';
import type { CheckResult, CriterionScore } from '@/db/schema';
import { JUDGE_LABEL, JUDGE_ORDER, Score, fmtMs, fmtNum } from '@/components/score';

interface JudgeCell {
  score: number | null;
  rationale?: string;
  criteria?: CriterionScore[];
  cached?: boolean;
  error?: string;
  withoutAttachments?: boolean;
}
interface CaseCell {
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
  };
  judgments: Record<string, JudgeCell>;
}
interface RunState {
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
  cases: Record<string, CaseCell>;
}
interface ViewState {
  testName: string;
  lang: string;
  status: string;
  phase?: string;
  error?: string | null;
  createdAt: number;
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
function fromDetail(d: any): ViewState {
  return {
    testName: d.testName,
    lang: d.lang,
    status: d.status,
    error: d.error,
    createdAt: d.createdAt,
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

function apply(s: ViewState, e: SessionEvent): ViewState {
  const runs = s.runs.map((r) => ({ ...r, cases: { ...r.cases } }));
  const run = 'runId' in e ? runs.find((r) => r.id === e.runId) : undefined;
  switch (e.type) {
    case 'session':
      return { ...s, status: 'running', phase: e.status };
    case 'run-status':
      if (run) Object.assign(run, { status: e.status, loadMs: e.loadMs ?? run.loadMs, error: e.error });
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
      return { ...s, runs, status: e.status, error: e.error, phase: undefined };
  }
  return { ...s, runs };
}

export function SessionView({ id }: { id: string }) {
  const [state, setState] = useState<ViewState | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [liveKey, setLiveKey] = useState(0);

  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;
    const load = () =>
      fetch(`/api/sessions/${id}`, { cache: 'no-store' }).then(async (res) => {
        if (cancelled) return null;
        if (!res.ok) {
          setNotFound(true);
          return null;
        }
        const d = await res.json();
        if (!cancelled) setState(fromDetail(d));
        return d as { live: boolean };
      });
    load().then((d) => {
      if (cancelled || !d?.live) return;
      es = new EventSource(`/api/sessions/${id}/events`);
      es.onmessage = (m) => {
        const e = JSON.parse(m.data) as SessionEvent | { type: 'not-live' };
        if (e.type === 'not-live') return es?.close();
        setState((s) => (s ? apply(s, e) : s));
        if (e.type === 'session-end') {
          es?.close();
          void load(); // reload persisted, aggregated state
        }
      };
      es.onerror = () => {
        es?.close();
        void load();
      };
    });
    return () => {
      cancelled = true;
      es?.close();
    };
  }, [id, liveKey]);

  /** Re-ask one judge on one case (e.g. a broken verdict); the other judgments stay. */
  async function rejudgeOne(caseResultId: number, judge: string) {
    const res = await fetch(`/api/sessions/${id}/rejudge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ judges: [judge], caseResultIds: [caseResultId] }),
    });
    if (res.ok) setLiveKey((k) => k + 1);
  }

  async function rejudge() {
    const res = await fetch(`/api/sessions/${id}/rejudge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (res.ok) setLiveKey((k) => k + 1);
  }

  if (notFound) return <p className="text-bad">Session not found.</p>;
  if (!state) return <p className="text-muted">Loading…</p>;

  const running = state.status === 'running' || state.status === 'queued';
  const judgeIds = JUDGE_ORDER.filter((j) => state.config.judges.includes(j));
  const caseIds = state.cases.map((c) => c.id).filter((cid) => state.runs.some((r) => r.cases[cid]));
  const extraIds = [...new Set(state.runs.flatMap((r) => Object.keys(r.cases)))].filter((x) => !caseIds.includes(x));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start gap-4">
        <div>
          <Link href="/" className="text-xs text-muted hover:text-fg">
            ← Dashboard
          </Link>
          <h1 className="text-xl font-semibold tracking-tight">
            {state.testName} <span className="text-muted uppercase">· {state.lang}</span>
          </h1>
          <p className="text-xs text-muted">
            {new Date(state.createdAt).toLocaleString()} · {state.config.subset} · temp {state.config.temperature} · seed{' '}
            {state.config.seed} · num_ctx {state.config.numCtx}
            {state.config.numCtxRequested ? ` (capped from ${state.config.numCtxRequested}: model maximum)` : ''}
            {state.config.think ? ' · thinking' : ''} · suite {state.suiteVersion}
            {state.config.ollamaVersion ? ` · ollama ${state.config.ollamaVersion}` : ''}
            {Object.entries(state.config.extra ?? {}).map(([k, v]) => ` · ${k}=${v}`)}
            {state.config.sdk && (
              <span
                className="block"
                title={Object.entries(state.config.sdk)
                  .map(([k, v]) => `${k}@${v}`)
                  .join(', ')}
              >
                {['ai', 'ai-sdk-ollama', 'ollama']
                  .filter((k) => state.config.sdk?.[k])
                  .map((k) => `${k === 'ollama' ? 'ollama-js' : k} ${state.config.sdk![k]}`)
                  .join(' · ')}
              </span>
            )}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span
            className={`text-xs font-medium uppercase ${state.status === 'done' ? 'text-good' : state.status === 'error' ? 'text-bad' : 'text-mid'}`}
          >
            {running ? (state.phase === 'judging' ? 'judging…' : 'running…') : state.status}
          </span>
          {!running && (
            <button
              onClick={rejudge}
              title="Run the judges again on the stored outputs"
              className="rounded-md border border-line px-3 py-1 text-xs hover:border-accent hover:text-accent"
            >
              Re-judge
            </button>
          )}
          {running && (
            <button
              onClick={() => fetch(`/api/sessions/${id}/cancel`, { method: 'POST' })}
              className="rounded-md border border-line px-3 py-1 text-xs hover:border-bad hover:text-bad"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
      {state.error && <p className="rounded-md border border-bad p-3 text-bad">{state.error}</p>}

      {/* Run summary cards */}
      <div className={`grid gap-4 ${gridCols(state.runs.length)}`}>
        {state.runs.map((r) => (
          <div key={r.id} className="rounded-lg border border-line bg-panel p-4">
            <div className="flex items-baseline gap-2">
              <span className="rounded bg-code px-1.5 font-mono text-xs text-muted">{r.label}</span>
              <span className="font-semibold">{r.model.name}</span>
              {r.role === 'baseline' && <span className="rounded bg-accent/15 px-1.5 text-xs text-accent">baseline</span>}
              <span className="font-mono text-xs text-muted">
                {r.model.parameterSize} · {r.model.quantization} · {r.model.digest.slice(0, 12)}
              </span>
              <span className="ml-auto text-xs uppercase text-muted">{r.status}</span>
            </div>
            {r.error && <p className="mt-2 text-xs text-bad">{r.error}</p>}
            {r.stats && (
              <p className="mt-1 font-mono text-xs text-muted">
                {Object.entries(r.stats)
                  .map(([k, v]) => `${k} ${v}`)
                  .join(' · ')}
              </p>
            )}
            <div className="mt-3 grid grid-cols-3 gap-3 sm:grid-cols-6">
              {judgeIds.map((j) => (
                <Stat key={j} label={JUDGE_LABEL[j]}>
                  <Score value={r.judgeScores[j]} className="text-lg" />
                </Stat>
              ))}
              <Stat label="Judge avg">
                <Score value={r.judgeAvg} className="text-2xl" />
              </Stat>
              <Stat label="Auto">
                <Score value={r.autoScore} className="text-lg" />
              </Stat>
              <Stat label="Load">{fmtMs(r.loadMs)}</Stat>
              <Stat label="Avg latency">{fmtMs(r.avgLatencyMs ?? avgOf(r, 'latencyMs'))}</Stat>
              <Stat label="tok/s">{fmtNum(r.avgTokPerSec ?? avgOf(r, 'tokPerSec'))}</Stat>
            </div>
          </div>
        ))}
      </div>

      {/* Per-case side-by-side */}
      <div className="space-y-4">
        {[...caseIds, ...extraIds].map((cid) => (
          <section key={cid} className="rounded-lg border border-line bg-panel">
            <h3 className="border-b border-line px-4 py-2 font-medium">
              {state.cases.find((c) => c.id === cid)?.title ?? cid} <span className="font-mono text-xs text-muted">{cid}</span>
            </h3>
            <div className={`grid divide-line ${gridCols(state.runs.length)} md:divide-x`}>
              {state.runs.map((r) => (
                <CaseColumn
                  key={r.id}
                  cell={r.cases[cid]}
                  judgeIds={judgeIds}
                  label={state.runs.length > 1 ? `${r.label} · ${r.model.name}` : undefined}
                  onRejudge={running ? undefined : rejudgeOne}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function gridCols(n: number) {
  return n >= 3 ? 'md:grid-cols-2 xl:grid-cols-3' : n === 2 ? 'md:grid-cols-2' : '';
}

function avgOf(r: RunState, k: 'latencyMs' | 'tokPerSec') {
  const v = Object.values(r.cases)
    .map((c) => c.metrics[k])
    .filter((x): x is number => typeof x === 'number');
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className="tabular">{children}</div>
    </div>
  );
}

const DISAGREEMENT = 4; // points between the highest and lowest judge score

function CaseColumn({
  cell,
  judgeIds,
  label,
  onRejudge,
}: {
  cell?: CaseCell;
  judgeIds: string[];
  label?: string;
  onRejudge?: (caseResultId: number, judge: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  if (!cell) return <div className="p-4 text-muted">{label && <div className="mb-2 text-xs">{label}</div>}Waiting…</div>;
  if (cell.error?.startsWith('skipped'))
    return (
      <div className="p-4 text-muted">
        {label && <div className="mb-2 text-xs">{label}</div>}
        <span className="rounded bg-code px-2 py-1 text-xs">{cell.error}</span>
      </div>
    );
  const judged = judgeIds.map((j) => cell.judgments[j]?.score).filter((x): x is number => typeof x === 'number');
  const avg = judged.length ? judged.reduce((a, b) => a + b, 0) / judged.length : null;
  const spread = judged.length > 1 ? Math.max(...judged) - Math.min(...judged) : 0;
  return (
    <div className="min-w-0 space-y-3 p-4">
      {label && <div className="text-xs text-muted">{label}</div>}
      {cell.reasoning && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">Reasoning ({cell.metrics.reasoningTokens ?? '?'} tokens)</summary>
          <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-code p-2 font-mono">{cell.reasoning}</pre>
        </details>
      )}
      {cell.status === 'done' && <ToolTrace data={cell.data} />}
      {cell.status === 'done' && <RetrievalView data={cell.data} />}
      {/* retrieval tests: the ranked list above replaces the plain-text ranking */}
      {!(cell.status === 'done' && (cell.data as { ranked?: unknown } | undefined)?.ranked) && (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-code p-3 font-mono text-[13px] leading-relaxed">
          {cell.output}
          {cell.status === 'running' && <span className="animate-pulse">▍</span>}
        </pre>
      )}
      {cell.error && <p className="text-xs text-bad">{cell.error}</p>}
      {cell.status === 'done' && (
        <>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted tabular">
            <span>latency {fmtMs(cell.metrics.latencyMs)}</span>
            <span>TTFT {fmtMs(cell.metrics.ttftMs)}</span>
            <span>{cell.metrics.tokensOut ?? '–'} tok</span>
            <span>{fmtNum(cell.metrics.tokPerSec)} tok/s</span>
          </div>
          {cell.checks.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-xs text-muted">
                Auto <Score value={cell.autoScore} />
              </span>
              {cell.checks.map((c, i) => (
                <span
                  key={i}
                  title={c.detail}
                  className={`rounded px-1.5 py-0.5 text-[11px] ${c.pass ? 'bg-good/10 text-good' : 'bg-bad/10 text-bad'}`}
                >
                  {c.pass ? '✓' : '✗'} {c.name}
                </span>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {judgeIds.map((j) => {
              const jc = cell.judgments[j];
              return (
                <button
                  key={j}
                  onClick={() => setOpen(open === j ? null : j)}
                  className={`rounded-md border px-2 py-1 ${open === j ? 'border-accent' : 'border-line'} hover:border-muted`}
                  title={jc?.error}
                >
                  {JUDGE_LABEL[j]}{' '}
                  {jc ? (
                    jc.error ? (
                      <span className="text-bad">error</span>
                    ) : (
                      <Score value={jc.score} />
                    )
                  ) : (
                    <span className="animate-pulse text-muted">…</span>
                  )}
                  {jc?.cached && <span className="ml-1 text-muted">(cached)</span>}
                  {jc?.withoutAttachments && (
                    <span
                      className="ml-1 text-mid"
                      title="Judged without the attached file(s): with them this judge gave a flat verdict (every criterion the same mid-scale score). Scored against the reference only."
                    >
                      (no file)
                    </span>
                  )}
                </button>
              );
            })}
            {spread >= DISAGREEMENT && (
              <span
                className="rounded bg-mid/15 px-1.5 py-0.5 text-[11px] text-mid"
                title="Open each judge's rationale; re-judge an outlier if its verdict looks broken"
              >
                ⚠ judges disagree (Δ {spread.toFixed(1)})
              </span>
            )}
            <span className="ml-auto">
              avg <Score value={avg} className="text-base" />
            </span>
          </div>
          {open && cell.judgments[open] && (
            <div className="rounded-md border border-line p-3 text-xs">
              {cell.judgments[open].error ? (
                <p className="text-bad">{cell.judgments[open].error}</p>
              ) : (
                <>
                  {cell.judgments[open].withoutAttachments && (
                    <p className="mb-2 text-mid">
                      Judged without the attached file(s): with them, this judge returned a flat verdict (every criterion the same mid-scale
                      score). This verdict checks the answer against the reference only.
                    </p>
                  )}
                  <p>{cell.judgments[open].rationale}</p>
                  {cell.judgments[open].criteria && (
                    <ul className="mt-2 space-y-1">
                      {cell.judgments[open].criteria!.map((c, i) => (
                        <li key={i} className="flex gap-2">
                          <Score value={c.score} className="w-8 shrink-0" />
                          <span>
                            <span className="font-medium">{c.name}</span> <span className="text-muted">{c.comment}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
              {onRejudge && cell.caseResultId != null && (
                <button
                  onClick={() => onRejudge(cell.caseResultId!, open)}
                  className="mt-2 rounded-md border border-line px-2 py-0.5 text-[11px] text-muted hover:border-accent hover:text-accent"
                  title="Ask this judge again on this case only; the other judges' verdicts are kept"
                >
                  ↻ Re-judge with {JUDGE_LABEL[open]}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

interface TraceEntry {
  step: number;
  toolName: string;
  input: unknown;
  output?: unknown;
  error?: string;
}

function ToolTrace({ data }: { data: unknown }) {
  const trace = (data as { trace?: TraceEntry[] } | undefined)?.trace;
  if (!trace) return null;
  return (
    <details className="text-xs" open={trace.length > 0 && trace.length <= 4}>
      <summary className="cursor-pointer text-muted">
        Tool calls ({trace.length}){trace.length === 0 ? ': none' : ''}
      </summary>
      <ol className="mt-1 space-y-1">
        {trace.map((t, i) => (
          <li key={i} className="rounded bg-code p-2 font-mono">
            <span className="text-muted">#{t.step}</span> <span className="font-semibold text-accent">{t.toolName}</span>(
            {JSON.stringify(t.input)})
            <div className={`mt-0.5 break-all ${t.error ? 'text-bad' : 'text-muted'}`}>
              → {t.error ?? JSON.stringify(t.output)?.slice(0, 400)}
            </div>
          </li>
        ))}
      </ol>
    </details>
  );
}

interface RetrievalItem {
  id: string;
  headingPath: string;
  score?: number;
  relevant: boolean;
  n?: number;
}

/** Ranked chunks (embeddings / reranking) or the passages given to the generator (RAG), relevant ones highlighted. */
function RetrievalView({ data }: { data: unknown }) {
  const d = data as
    { ranked?: RetrievalItem[]; passages?: RetrievalItem[]; method?: string; cited?: number[]; reranker?: string } | undefined;
  const items = d?.ranked ?? d?.passages;
  if (!items) return null;
  const isRag = !!d?.passages;
  return (
    <details className="text-xs" open={!isRag}>
      <summary className="cursor-pointer text-muted">
        {isRag ? `Passages given to the model (reranker: ${d?.reranker})` : `Ranking${d?.method ? ` (${d.method})` : ''}`}
      </summary>
      <ol className="mt-1 space-y-0.5">
        {items.slice(0, 10).map((it, i) => (
          <li key={it.id} className={`flex gap-2 rounded px-1.5 py-0.5 ${it.relevant ? 'bg-good/10 text-good' : 'text-muted'}`}>
            <span className="w-5 shrink-0 text-right tabular">{it.n ?? i + 1}.</span>
            <span className="truncate" title={it.headingPath}>
              {it.headingPath}
            </span>
            <span className="ml-auto shrink-0 font-mono">
              {isRag && d?.cited?.includes(it.n ?? -1) ? 'cited ' : ''}
              {it.score != null ? it.score.toFixed(3) : ''}
              {it.relevant ? ' ✓' : ''}
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}
