'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { BatchDetail } from '@/lib/queries';
import { getCapability } from '@/config/capabilities';
import { Score, fmtNum, heat } from '@/components/score';
import { StatusPill } from '@/components/status-pill';
import { modelHref } from '@/components/leaderboard-table';

const ACTIVE = new Set(['queued', 'running']);

export function BatchView({ initial, testNames }: { initial: BatchDetail; testNames: Record<string, string> }) {
  const [batch, setBatch] = useState(initial);
  const [cancelling, setCancelling] = useState(false);
  const active = ACTIVE.has(batch.status);

  // poll while anything is queued or running; each session page has the live, case-by-case view
  useEffect(() => {
    if (!active) return;
    const t = setInterval(async () => {
      const res = await fetch(`/api/batches/${batch.id}`, { cache: 'no-store' });
      if (res.ok) setBatch(await res.json());
    }, 3000);
    return () => clearInterval(t);
  }, [active, batch.id]);

  async function cancel() {
    setCancelling(true);
    await fetch(`/api/batches/${batch.id}/cancel`, { method: 'POST' });
  }

  const cap = getCapability(batch.capability);
  const finished = batch.sessions.filter((s) => !ACTIVE.has(s.status)).length;
  const capScore = (model: string) => {
    const xs = batch.testIds
      .map((t) => batch.cells[model]?.[t])
      .filter((c) => c?.status === 'done' && c.score != null)
      .map((c) => c!.score!);
    return { score: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null, n: xs.length };
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{cap?.label ?? batch.capability} batch</h1>
          <p className="text-xs text-muted">
            {new Date(batch.createdAt).toLocaleString()} · {batch.lang.toUpperCase()} · {batch.config.subset ?? 'quick'}
            {batch.config.think ? ' · thinking' : ''}
            {batch.config.numCtx ? ` · num_ctx ${batch.config.numCtx}` : ''} · judges {(batch.config.judges ?? []).join(', ') || 'none'}
          </p>
        </div>
        <span className="ml-auto flex items-center gap-3">
          <span className="text-xs text-muted tabular">
            {finished}/{batch.sessions.length} sessions
          </span>
          <StatusPill status={batch.status} />
          {active && (
            <button
              onClick={cancel}
              disabled={cancelling}
              className="rounded-md border border-line px-3 py-1 text-xs hover:border-bad hover:text-bad disabled:opacity-50"
            >
              {cancelling ? 'Cancelling…' : 'Cancel batch'}
            </button>
          )}
        </span>
      </div>

      <section className="overflow-x-auto rounded-lg border border-line bg-panel">
        <table className="w-full text-left">
          <thead className="text-xs uppercase tracking-wide text-muted">
            <tr className="border-b border-line">
              <th className="px-4 py-2 font-medium">Test</th>
              {batch.models.map((m) => (
                <th key={m} className="px-3 py-2 text-center font-medium normal-case">
                  <Link href={modelHref(m)} className="hover:underline">
                    {m}
                  </Link>
                </th>
              ))}
              <th className="px-4 py-2 text-right font-medium">Session</th>
            </tr>
          </thead>
          <tbody>
            {batch.testIds.map((t) => {
              const s = batch.sessions.find((x) => x.testId === t);
              return (
                <tr key={t} className="border-b border-line">
                  <td className="px-4 py-2">
                    <Link href={`/tests/${t}`} className="font-medium hover:underline">
                      {testNames[t] ?? t}
                    </Link>
                    {s?.variant && <span className="ml-2 rounded bg-code px-1.5 py-0.5 text-xs text-muted">{s.variant}</span>}
                    {s?.error && <p className="text-xs text-bad">{s.error}</p>}
                  </td>
                  {batch.models.map((m) => {
                    const c = batch.cells[m]?.[t];
                    if (!c)
                      return (
                        <td key={m} className="px-3 py-2 text-center text-muted">
                          –
                        </td>
                      );
                    if (c.status === 'done')
                      return (
                        <td key={m} className="px-1 py-1 text-center">
                          <span
                            className="block rounded px-2 py-1 tabular"
                            style={heat(c.score)}
                            title={c.judgeAvg != null ? 'Judge average' : 'Automatic score'}
                          >
                            {fmtNum(c.score)}
                          </span>
                        </td>
                      );
                    return (
                      <td key={m} className="px-3 py-2 text-center">
                        <StatusPill status={c.status} />
                      </td>
                    );
                  })}
                  <td className="px-4 py-2 text-right">
                    {s ? (
                      <Link href={`/sessions/${s.id}`} className="inline-flex items-center gap-2 hover:underline">
                        <StatusPill status={s.status} /> <span className="text-xs text-muted">open →</span>
                      </Link>
                    ) : (
                      <span className="text-muted">–</span>
                    )}
                  </td>
                </tr>
              );
            })}
            <tr>
              <td className="px-4 py-3 font-semibold">{cap?.label ?? 'Capability'} score</td>
              {batch.models.map((m) => {
                const { score, n } = capScore(m);
                return (
                  <td key={m} className="px-3 py-3 text-center text-base">
                    {n === batch.testIds.length ? (
                      <Score value={score} />
                    ) : (
                      <span className="tabular text-muted" title="Not every test has finished">
                        ({fmtNum(score)}){' '}
                        <span className="text-[10px]">
                          {n}/{batch.testIds.length}
                        </span>
                      </span>
                    )}
                  </td>
                );
              })}
              <td />
            </tr>
          </tbody>
        </table>
      </section>
      <p className="text-xs text-muted">
        Scores are each run&apos;s judge average (or the automatic score for unjudged tests). The capability score here is this batch&apos;s
        mean; the{' '}
        <Link href={`/?view=capability&cap=${batch.capability}&lang=${batch.lang}`} className="text-accent hover:underline">
          dashboard
        </Link>{' '}
        combines each model&apos;s latest current results.
      </p>
    </div>
  );
}
