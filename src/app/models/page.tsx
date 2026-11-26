import { Suspense } from 'react';
import Link from 'next/link';
import { connection } from 'next/server';
import { modelIndex } from '@/lib/queries';
import { modelHref } from '@/components/leaderboard-table';
import { ExportLinks } from '@/components/runs-table';
import { TierFilter } from '@/components/tier-filter';
import { inTier, parseTier, type Tier } from '@/lib/tiers';
import { listOllamaModels } from '@/lib/ollama';
import { RefreshModelsButton } from '@/components/refresh-models-button';

export default function ModelsPage({ searchParams }: PageProps<'/models'>) {
  return (
    <div className="space-y-6">
      <div className="flex items-end gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Models</h1>
          <p className="text-muted">
            Every model on the Ollama host or ever benchmarked (a re-pulled model with a new digest counts as a new version).
          </p>
        </div>
        <span className="ml-auto flex flex-wrap items-center justify-end gap-3">
          <RefreshModelsButton />
          <ExportLinks query="" />
        </span>
      </div>
      <Suspense fallback={<p className="text-muted">Loading…</p>}>
        <ModelList searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function ModelList({ searchParams }: { searchParams: PageProps<'/models'>['searchParams'] }) {
  const tier: Tier = parseTier((await searchParams).tier);
  await connection();
  const rows = modelIndex().filter((m) => inTier(m.parameterSize, tier));
  // which Ollama models are on the host right now (null = host unreachable: no badges)
  const live = await listOllamaModels()
    .then((ms) => new Set(ms.map((m) => m.name)))
    .catch(() => null);
  return (
    <>
      <TierFilter basePath="/models" current={tier} />
      <section className="overflow-x-auto rounded-lg border border-line bg-panel">
        <table className="w-full text-left">
          <thead className="text-xs uppercase tracking-wide text-muted">
            <tr className="border-b border-line">
              <th className="px-4 py-2 font-medium">Model</th>
              <th className="px-3 py-2 font-medium">Size · quant</th>
              <th className="px-3 py-2 font-medium">Capabilities</th>
              <th className="px-3 py-2 text-right font-medium">Tests</th>
              <th className="px-3 py-2 text-right font-medium">Runs</th>
              <th className="px-3 py-2 text-right font-medium">Digests</th>
              <th className="px-4 py-2 font-medium">Last run</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.name} className="border-b border-line last:border-0 hover:bg-code">
                <td className="px-4 py-2">
                  <Link href={modelHref(m.name)} className="font-medium hover:underline">
                    {m.name}
                  </Link>
                  {m.provider !== 'ollama' && <span className="ml-2 rounded bg-accent/15 px-1.5 text-xs text-accent">{m.provider}</span>}
                  {m.provider === 'ollama' && live && !live.has(m.name) && (
                    <span
                      className="ml-2 rounded bg-code px-1.5 text-xs text-muted"
                      title="No longer on the Ollama host; its history is kept"
                    >
                      not on host
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-muted">
                  {[m.parameterSize, m.quantization].filter(Boolean).join(' · ') || '–'}
                </td>
                <td className="px-3 py-2 text-xs text-muted">{m.capabilities.join(', ')}</td>
                <td className="px-3 py-2 text-right tabular">{m.tests}</td>
                <td className="px-3 py-2 text-right tabular">{m.runs}</td>
                <td className="px-3 py-2 text-right tabular">{m.digests}</td>
                <td className="px-4 py-2 text-muted tabular">{m.lastRunAt ? new Date(m.lastRunAt).toLocaleString() : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
