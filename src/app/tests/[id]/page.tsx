import { Suspense } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { leaderboard, runRows } from '@/lib/queries';
import { getTest, TESTS } from '@/lib/tests/registry';
import { LANGUAGES } from '@/config/languages';
import { LeaderboardTable } from '@/components/leaderboard-table';
import { RunsTable, ExportLinks } from '@/components/runs-table';
import { SpeedQualityScatter, type SpeedPoint } from '@/components/charts';
import { TierFilter } from '@/components/tier-filter';
import { inTier, parseTier } from '@/lib/tiers';

export default function TestPage({ params, searchParams }: PageProps<'/tests/[id]'>) {
  return (
    <Suspense fallback={<p className="text-muted">Loading…</p>}>
      <TestView params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function TestView({ params, searchParams }: Pick<PageProps<'/tests/[id]'>, 'params' | 'searchParams'>) {
  const { id } = await params;
  const sp = await searchParams;
  await connection();
  if (!TESTS.some((t) => t.id === id)) notFound();
  const test = getTest(id);
  const tier = parseTier(sp.tier);
  const all = leaderboard(id).filter((r) => inTier(r.parameterSize, tier));
  const langs = LANGUAGES.filter((l) => all.some((r) => r.lang === l.code));
  const lang = typeof sp.lang === 'string' && langs.some((l) => l.code === sp.lang) ? sp.lang : (langs[0]?.code ?? 'en');
  const rows = all.filter((r) => r.lang === lang);
  const runs = runRows({ testId: id }).filter((r) => inTier(r.parameterSize, tier));

  // speed vs quality. Quality is the judge average; tests without judges (Terminal-Bench's verifier, retrieval
  // metrics) or with no judged run yet use the automatic score. Never a mix: the two aren't the same measure.
  const useJudge = test.judged !== false && rows.some((r) => r.judgeAvg != null);
  const quality = (r: (typeof rows)[number]) => (useJudge ? r.judgeAvg : r.autoScore);
  // speed: tokens/s when every model has it (generation tests), latency otherwise (retrieval tests)
  const scored = rows.filter((r) => quality(r) != null);
  const useTok = scored.length > 0 && scored.every((r) => r.avgTokPerSec != null);
  const points: SpeedPoint[] = scored
    .filter((r) => (useTok ? r.avgTokPerSec : r.avgLatencyMs) != null)
    .map((r) => ({
      model: r.variant ? `${r.model} (${r.variant})` : r.model,
      x: Math.round((useTok ? r.avgTokPerSec! : r.avgLatencyMs!) * 10) / 10,
      score: quality(r)!,
    }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <Link href="/" className="text-xs text-muted hover:text-fg">
            ← Dashboard
          </Link>
          <h1 className="text-xl font-semibold tracking-tight">{test.name}</h1>
          <p className="text-muted">{test.description}</p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <ExportLinks query={`testId=${id}`} />
          <Link href={`/run?test=${id}`} className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg">
            Run
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        {langs.length > 1 && (
          <nav className="flex gap-1 text-xs">
            {langs.map((l) => (
              <Link
                key={l.code}
                href={`/tests/${id}?lang=${l.code}${tier === 'all' ? '' : `&tier=${tier}`}`}
                className={`rounded-md border px-3 py-1 ${l.code === lang ? 'border-accent text-accent' : 'border-line text-muted hover:text-fg'}`}
              >
                {l.name}
              </Link>
            ))}
          </nav>
        )}
        <TierFilter basePath={`/tests/${id}`} current={tier} params={{ lang }} />
      </div>

      <section className="rounded-lg border border-line bg-panel">
        <h2 className="border-b border-line px-4 py-3 font-semibold">Leaderboard</h2>
        <LeaderboardTable rows={rows} />
      </section>

      <section className="rounded-lg border border-line bg-panel p-4">
        <h2 className="font-semibold">Speed vs quality</h2>
        <p className="mb-3 text-xs text-muted">
          Latest {useJudge ? 'judged run' : 'run'} per model ({lang.toUpperCase()}), scored by{' '}
          {useJudge ? 'the judges' : test.judged === false ? 'its automatic check' : 'the automatic check (no judged runs yet)'}. Up is
          better; {useTok ? 'right is faster (tokens/s)' : 'left is faster (average latency, ms)'}.
        </p>
        <SpeedQualityScatter
          points={points}
          xLabel={useTok ? 'tokens/s' : 'avg latency (ms)'}
          yLabel={useJudge ? 'Judge avg' : 'Auto score'}
        />
      </section>

      <section className="rounded-lg border border-line bg-panel">
        <h2 className="border-b border-line px-4 py-3 font-semibold">All runs ({runs.length})</h2>
        <RunsTable runs={runs} show="model" />
      </section>
    </div>
  );
}
