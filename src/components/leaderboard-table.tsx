import Link from 'next/link';
import type { LeaderboardRow } from '@/lib/queries';
import { JUDGE_LABEL, JUDGE_ORDER, Score, fmtDuration, fmtMs, fmtNum } from '@/components/score';

export const modelHref = (name: string) => `/models/${name.split('/').map(encodeURIComponent).join('/')}`;

/** `moreHref`: where a row's folded results (`others`, see bestPerModel) are listed. */
export function LeaderboardTable({ rows, moreHref }: { rows: LeaderboardRow[]; moreHref?: string }) {
  if (!rows.length) return <p className="px-4 py-6 text-muted">No runs yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead className="text-xs uppercase tracking-wide text-muted">
          <tr className="border-b border-line">
            <th className="px-4 py-2 font-medium">#</th>
            <th className="px-4 py-2 font-medium">Lang</th>
            <th className="px-4 py-2 font-medium">Model</th>
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
              title="Execution time of the run shown, on its case set (quick or full); checks and judging excluded"
            >
              Exec time
            </th>
            <th className="px-4 py-2 text-right font-medium">Runs</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.modelId}-${r.lang}-${r.variant}`} className="border-b border-line last:border-0">
              <td className="px-4 py-2 text-muted tabular">{i + 1}</td>
              <td className="px-4 py-2 uppercase text-muted">{r.lang}</td>
              <td className="px-4 py-2">
                <Link href={modelHref(r.model)} className="font-medium hover:underline">
                  {r.model}
                </Link>
                {r.provider !== 'ollama' && <span className="ml-2 rounded bg-accent/15 px-1.5 text-xs text-accent">baseline</span>}
                {r.variant && <span className="ml-2 rounded bg-code px-1.5 py-0.5 text-xs text-muted">{r.variant}</span>}
                <span className="ml-2 font-mono text-xs text-muted">
                  {r.quantization ? `${r.quantization} · ` : ''}
                  {r.digest}
                </span>
                {!!r.others && moreHref && (
                  <Link
                    href={moreHref}
                    className="ml-2 text-xs text-muted hover:text-fg"
                    title={`Best of ${r.others + 1} results (languages, variants, versions): all of them on the test page`}
                  >
                    +{r.others}
                  </Link>
                )}
              </td>
              {JUDGE_ORDER.map((j) => (
                <td key={j} className="px-3 py-2 text-right">
                  <Score value={r.judgeScores[j]} />
                </td>
              ))}
              <td className="px-3 py-2 text-right text-base">
                <Score value={r.judgeAvg} />
              </td>
              <td className="px-3 py-2 text-right">
                <Score value={r.autoScore} />
              </td>
              <td className="px-3 py-2 text-right tabular">{fmtNum(r.avgTokPerSec)}</td>
              <td className="px-3 py-2 text-right tabular">{fmtMs(r.avgLatencyMs)}</td>
              <td className="px-3 py-2 text-right tabular" title={r.execMs != null ? `${r.subset} set` : undefined}>
                {fmtDuration(r.execMs)}
              </td>
              <td className="px-4 py-2 text-right tabular text-muted">{r.runs}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
