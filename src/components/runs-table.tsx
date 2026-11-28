import Link from 'next/link';
import type { RunRow } from '@/lib/queries';
import { JUDGE_LABEL, JUDGE_ORDER, Score, fmtDuration, fmtMs, fmtNum } from '@/components/score';
import { modelHref } from '@/components/leaderboard-table';

/** Every run, newest first; one row per model run, linking to its session. */
export function RunsTable({ runs, show }: { runs: RunRow[]; show: 'model' | 'test' }) {
  if (!runs.length) return <p className="px-4 py-6 text-muted">No runs.</p>;
  const rows = [...runs].reverse();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead className="text-xs uppercase tracking-wide text-muted">
          <tr className="border-b border-line">
            <th className="px-4 py-2 font-medium">Date</th>
            <th className="px-3 py-2 font-medium">{show === 'model' ? 'Model' : 'Test'}</th>
            <th className="px-3 py-2 font-medium">Lang</th>
            <th className="px-3 py-2 font-medium">Set</th>
            {JUDGE_ORDER.map((j) => (
              <th key={j} className="px-3 py-2 text-right font-medium">
                {JUDGE_LABEL[j]}
              </th>
            ))}
            <th className="px-3 py-2 text-right font-medium">Avg</th>
            <th className="px-3 py-2 text-right font-medium">Auto</th>
            <th className="px-3 py-2 text-right font-medium">tok/s</th>
            <th className="px-3 py-2 text-right font-medium">Latency</th>
            <th
              className="px-3 py-2 text-right font-medium"
              title="Execution time of the run: warm-up, preparation and every case; checks and judging excluded"
            >
              Exec time
            </th>
            <th className="px-4 py-2 font-medium">Digest · suite · SDK</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.runId} className="border-b border-line last:border-0 hover:bg-code">
              <td className="px-4 py-2 whitespace-nowrap tabular">
                <Link href={`/sessions/${r.sessionId}`} className="text-accent hover:underline">
                  {new Date(r.date).toLocaleString()}
                </Link>
              </td>
              <td className="px-3 py-2">
                {show === 'model' ? (
                  <Link href={modelHref(r.model)} className="hover:underline">
                    {r.model}
                  </Link>
                ) : (
                  <Link href={`/tests/${r.testId}`} className="hover:underline">
                    {r.testId}
                  </Link>
                )}
                {r.role === 'baseline' && <span className="ml-2 rounded bg-accent/15 px-1.5 text-xs text-accent">baseline</span>}
                {r.variant && <span className="ml-2 rounded bg-code px-1.5 py-0.5 text-xs text-muted">{r.variant}</span>}
              </td>
              <td className="px-3 py-2 uppercase text-muted">{r.lang}</td>
              <td className="px-3 py-2 text-muted">
                {r.subset}
                {r.think ? ' · think' : ''}
              </td>
              {JUDGE_ORDER.map((j) => (
                <td key={j} className="px-3 py-2 text-right">
                  <Score value={r.judgeScores[j]} />
                </td>
              ))}
              <td className="px-3 py-2 text-right">
                <Score value={r.judgeAvg} />
              </td>
              <td className="px-3 py-2 text-right">
                <Score value={r.autoScore} />
              </td>
              <td className="px-3 py-2 text-right tabular">{fmtNum(r.avgTokPerSec)}</td>
              <td className="px-3 py-2 text-right tabular">{fmtMs(r.avgLatencyMs)}</td>
              <td className="px-3 py-2 text-right tabular">{fmtDuration(r.execMs)}</td>
              <td className="px-4 py-2 font-mono text-xs text-muted">
                {r.digest.slice(0, 8) || '–'} · {r.suiteVersion}
                {r.sdkLabel && <div className="whitespace-nowrap">{r.sdkLabel}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ExportLinks({ query }: { query: string }) {
  return (
    <span className="flex gap-2 text-xs">
      <a href={`/api/export?${query}`} className="rounded-md border border-line px-2.5 py-1 hover:border-accent hover:text-accent">
        Export runs (CSV)
      </a>
      <a
        href={`/api/export?${query}${query ? '&' : ''}level=case`}
        className="rounded-md border border-line px-2.5 py-1 hover:border-accent hover:text-accent"
      >
        Export cases (CSV)
      </a>
    </span>
  );
}
