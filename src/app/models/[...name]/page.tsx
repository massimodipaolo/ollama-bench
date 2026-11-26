import { Suspense } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { modelIndex, runRows, type RunRow } from '@/lib/queries';
import { TESTS } from '@/lib/tests/registry';
import { listOllamaModels } from '@/lib/ollama';
import { RunsTable, ExportLinks } from '@/components/runs-table';
import { HistoryChart, HistoryLegend, type HistoryPoint } from '@/components/charts';
import { Score } from '@/components/score';

export default function ModelPage({ params }: PageProps<'/models/[...name]'>) {
  return (
    <Suspense fallback={<p className="text-muted">Loading…</p>}>
      <ModelView params={params} />
    </Suspense>
  );
}

const fmtDay = (t: number) => new Date(t).toLocaleDateString(undefined, { day: '2-digit', month: 'short' });

async function ModelView({ params }: Pick<PageProps<'/models/[...name]'>, 'params'>) {
  const { name: parts } = await params;
  const name = parts.map((p) => decodeURIComponent(p)).join('/');
  await connection();
  const info = modelIndex().find((m) => m.name === name);
  if (!info) notFound();
  const runs = runRows({ model: name });
  const live = (await listOllamaModels().catch(() => [])).find((m) => m.name === name);
  const testName = (id: string) => TESTS.find((t) => t.id === id)?.name ?? id;

  // one small multiple per (test, language, variant); runs in chronological order
  const groups = new Map<string, RunRow[]>();
  for (const r of runs) {
    const k = `${r.testId}|${r.lang}|${r.variant}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <Link href="/models" className="text-xs text-muted hover:text-fg">
            ← Models
          </Link>
          <h1 className="text-xl font-semibold tracking-tight">{name}</h1>
          <p className="font-mono text-xs text-muted">
            {[info.provider, info.family, info.parameterSize, info.quantization].filter(Boolean).join(' · ')} · {info.digests}{' '}
            {info.digests === 1 ? 'digest' : 'digests'} · capabilities: {(live?.capabilities ?? info.capabilities).join(', ')}
          </p>
          {live?.capabilityNotes.map((n) => (
            <p key={n} className="mt-1 text-xs text-mid">
              {n}
            </p>
          ))}
        </div>
        <span className="ml-auto">
          <ExportLinks query={`model=${encodeURIComponent(name)}`} />
        </span>
      </div>

      {groups.size > 0 && (
        <section className="space-y-3">
          <div className="flex items-baseline gap-4">
            <h2 className="font-semibold">History by test</h2>
            <HistoryLegend />
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {[...groups.entries()].map(([k, rs]) => {
              const [testId, lang, variant] = k.split('|');
              const last = rs[rs.length - 1];
              const digests = new Set(rs.map((r) => r.digest)).size;
              const points: HistoryPoint[] = rs.map((r, i) => ({
                label: `#${i + 1} · ${fmtDay(r.date)}`,
                date: new Date(r.date).toLocaleString(),
                judgeAvg: r.judgeAvg,
                auto: r.autoScore,
                digest: r.digest.slice(0, 8),
              }));
              return (
                <div key={k} className="rounded-lg border border-line bg-panel p-3">
                  <div className="flex items-baseline gap-2">
                    <Link href={`/tests/${testId}?lang=${lang}`} className="font-medium hover:underline">
                      {testName(testId)}
                    </Link>
                    <span className="text-xs uppercase text-muted">{lang}</span>
                    {variant && <span className="rounded bg-code px-1.5 text-xs text-muted">{variant}</span>}
                    <span className="ml-auto text-xs text-muted">
                      latest <Score value={last.judgeAvg} /> · {rs.length} {rs.length === 1 ? 'run' : 'runs'}
                      {digests > 1 ? ` · ${digests} digests` : ''}
                    </span>
                  </div>
                  <HistoryChart points={points} />
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="rounded-lg border border-line bg-panel">
        <h2 className="border-b border-line px-4 py-3 font-semibold">All runs ({runs.length})</h2>
        <RunsTable runs={runs} show="test" />
      </section>
    </div>
  );
}
