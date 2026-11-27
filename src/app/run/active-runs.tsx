'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ActiveSession } from '@/lib/queries';
import { StatusPill } from '@/components/status-pill';

/**
 * What the GPU is busy with: the running session (with progress) and any queued behind it. Polls while visible.
 * A new run started now is queued behind these, never run in parallel.
 */
export function ActiveRuns() {
  const [active, setActive] = useState<ActiveSession[] | null>(null);

  useEffect(() => {
    let stop = false;
    const load = () =>
      fetch('/api/active', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : []))
        .then((a: ActiveSession[]) => !stop && setActive(a))
        .catch(() => {});
    load();
    const t = setInterval(() => document.visibilityState === 'visible' && load(), 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  if (!active?.length) return null;
  const [current, ...queued] = active;
  const pct = current.total ? Math.min(100, Math.round((current.done / current.total) * 100)) : 0;
  const stage = current.status === 'queued' ? 'starting' : current.total && current.done >= current.total ? 'judging' : 'running';
  const candidates = current.runs.filter((r) => r.role === 'candidate');

  return (
    <section className="rounded-lg border border-accent/40 bg-panel" aria-live="polite">
      <Link href={`/sessions/${current.id}`} className="block px-4 py-3 hover:bg-code">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="relative flex h-2 w-2" aria-hidden>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
          </span>
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Running now</span>
          <span className="font-medium">{current.testName}</span>
          <span className="text-xs uppercase text-muted">
            {current.lang} · {current.subset}
          </span>
          {current.variant && <span className="rounded bg-code px-1.5 py-0.5 text-xs text-muted">{current.variant}</span>}
          <span className="text-muted">{candidates.map((r) => r.model).join(' vs ')}</span>
          {current.batchId && <span className="rounded bg-code px-1.5 py-0.5 text-xs text-muted">batch</span>}
          <span className="ml-auto flex items-center gap-3 text-xs">
            <span className="tabular text-muted">
              {current.done}/{current.total} cases · {stage}
            </span>
            <span className="text-accent">open →</span>
          </span>
        </div>
        <div
          className="mt-2 h-1 overflow-hidden rounded bg-code"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="h-full rounded bg-accent transition-[width] duration-500" style={{ width: `${pct}%` }} />
        </div>
      </Link>
      {queued.length > 0 && (
        <ul className="border-t border-line text-xs">
          {queued.map((s) => (
            <li key={s.id}>
              <Link
                href={s.batchId ? `/batches/${s.batchId}` : `/sessions/${s.id}`}
                className="flex flex-wrap items-center gap-3 px-4 py-1.5 hover:bg-code"
              >
                <StatusPill status="queued" />
                <span className="font-medium">{s.testName}</span>
                <span className="uppercase text-muted">
                  {s.lang} · {s.subset}
                </span>
                <span className="text-muted">
                  {s.runs
                    .filter((r) => r.role === 'candidate')
                    .map((r) => r.model)
                    .join(' vs ')}
                </span>
                {s.batchId && <span className="rounded bg-code px-1.5 py-0.5 text-muted">batch</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="border-t border-line px-4 py-1.5 text-[11px] text-muted">
        A run you start now waits in the queue behind {active.length === 1 ? 'this one' : `these ${active.length}`}.
      </p>
    </section>
  );
}
