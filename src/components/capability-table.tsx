import Link from 'next/link';
import type { CapabilityBoard, CapabilityCell, OverviewRow } from '@/lib/queries';
import { CAPABILITIES } from '@/config/capabilities';
import { Score, fmtNum, heat } from '@/components/score';
import { modelHref } from '@/components/leaderboard-table';

function TestCell({ cell }: { cell: CapabilityCell | undefined }) {
  if (!cell) return <td className="px-3 py-2 text-center text-muted">–</td>;
  if (cell.stale)
    return (
      <td className="px-3 py-2 text-center">
        <Link
          href={`/sessions/${cell.sessionId}`}
          className="tabular text-muted line-through decoration-1 hover:underline"
          title="From an older version of this test (its cases changed since): not counted. Run it again to update."
        >
          {fmtNum(cell.score)}
        </Link>
      </td>
    );
  return (
    <td className="px-1 py-1 text-center">
      <Link
        href={`/sessions/${cell.sessionId}`}
        className="block rounded px-2 py-1 tabular hover:outline hover:outline-1 hover:outline-accent"
        style={heat(cell.score)}
      >
        {fmtNum(cell.score)}
      </Link>
    </td>
  );
}

const ModelCell = ({ name, size, quant, baseline }: { name: string; size: string | null; quant?: string | null; baseline: boolean }) => (
  <td className="px-4 py-2">
    <Link href={modelHref(name)} className="font-medium hover:underline">
      {name}
    </Link>
    {baseline && <span className="ml-2 rounded bg-accent/15 px-1.5 text-xs text-accent">baseline</span>}
    <span className="ml-2 font-mono text-xs text-muted">{[size, quant].filter(Boolean).join(' · ')}</span>
  </td>
);

export function CapabilityTable({ board }: { board: CapabilityBoard }) {
  if (!board.rows.length) return <p className="px-4 py-6 text-muted">No results for these tests in this language yet.</p>;
  let rank = 0;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead className="text-xs uppercase tracking-wide text-muted">
          <tr className="border-b border-line">
            <th className="px-4 py-2 font-medium">#</th>
            <th className="px-4 py-2 font-medium">Model</th>
            <th className="px-3 py-2 text-right font-medium">{board.capability.label}</th>
            <th className="px-3 py-2 text-right font-medium" title="Current results / tests this model can take that anyone has run">
              Tests
            </th>
            {board.tests.map((t) => (
              <th key={t.id} className="px-3 py-2 text-center font-medium normal-case">
                <Link
                  href={`/tests/${t.id}`}
                  className={`hover:underline ${t.hasResults ? '' : 'opacity-50'}`}
                  title={t.hasResults ? undefined : 'No current results yet: not required'}
                >
                  {t.name}
                </Link>
              </th>
            ))}
            <th className="px-4 py-2 text-right font-medium">tok/s</th>
          </tr>
        </thead>
        <tbody>
          {board.rows.map((r) => (
            <tr key={r.model} className={`border-b border-line last:border-0 ${r.ranked ? '' : 'text-muted'}`}>
              <td className="px-4 py-2 tabular text-muted">{r.ranked ? ++rank : '–'}</td>
              <ModelCell name={r.model} size={r.parameterSize} quant={r.quantization} baseline={r.baseline} />
              <td className="px-3 py-2 text-right text-base">
                {r.ranked ? <Score value={r.score} /> : <span className="tabular">({fmtNum(r.score)})</span>}
              </td>
              <td
                className="px-3 py-2 text-right tabular"
                title={r.baseline ? 'Reference: never ranked' : r.ranked ? undefined : 'Partial: not ranked'}
              >
                {r.covered}/{r.required}
              </td>
              {board.tests.map((t) => (
                <TestCell key={t.id} cell={r.cells[t.id]} />
              ))}
              <td className="px-4 py-2 text-right tabular">{fmtNum(r.avgTokPerSec)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function OverviewTable({ rows, capHref }: { rows: OverviewRow[]; capHref: (capId: string) => string }) {
  if (!rows.length) return <p className="px-4 py-6 text-muted">No results in this language yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead className="text-xs uppercase tracking-wide text-muted">
          <tr className="border-b border-line">
            <th className="px-4 py-2 font-medium">Model</th>
            {CAPABILITIES.map((c) => (
              <th key={c.id} className="px-3 py-2 text-center font-medium normal-case">
                <Link href={capHref(c.id)} className="hover:underline" title={c.description}>
                  {c.label}
                </Link>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.model} className="border-b border-line last:border-0">
              <ModelCell name={r.model} size={r.parameterSize} baseline={r.baseline} />
              {CAPABILITIES.map((c) => {
                const s = r.scores[c.id];
                if (!s)
                  return (
                    <td key={c.id} className="px-3 py-2 text-center text-muted">
                      –
                    </td>
                  );
                return s.ranked ? (
                  <td key={c.id} className="px-1 py-1 text-center">
                    <Link href={capHref(c.id)} className="block rounded px-2 py-1 font-semibold tabular" style={heat(s.score)}>
                      {fmtNum(s.score)}
                    </Link>
                  </td>
                ) : (
                  <td
                    key={c.id}
                    className="px-3 py-2 text-center tabular text-muted"
                    title={`Partial: ${s.covered}/${s.required} tests, not ranked`}
                  >
                    ({fmtNum(s.score)}){' '}
                    <span className="text-[10px]">
                      {s.covered}/{s.required}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
