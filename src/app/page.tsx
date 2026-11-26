import { Suspense } from 'react';
import Link from 'next/link';
import { connection } from 'next/server';
import { leaderboard, recentSessions } from '@/lib/queries';
import { listTests } from '@/lib/tests/registry';
import { Score } from '@/components/score';
import { LeaderboardTable } from '@/components/leaderboard-table';
import { TierFilter } from '@/components/tier-filter';
import { inTier, parseTier, type Tier } from '@/lib/tiers';

export default function Dashboard({ searchParams }: PageProps<'/'>) {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-muted">
          The latest result of each model on each test. Scores are 0–10: each judge&apos;s score, their average, and the automatic checks.
        </p>
      </div>
      <Suspense fallback={<p className="text-muted">Loading…</p>}>
        <Boards searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Boards({ searchParams }: { searchParams: PageProps<'/'>['searchParams'] }) {
  const tier: Tier = parseTier((await searchParams).tier);
  await connection();
  const tests = await listTests();
  const recent = recentSessions(15);
  return (
    <>
      <TierFilter basePath="/" current={tier} />
      {tests.map((t) => {
        const rows = leaderboard(t.id).filter((r) => inTier(r.parameterSize, tier));
        return (
          <section key={t.id} className="rounded-lg border border-line bg-panel">
            <div className="flex items-baseline gap-3 border-b border-line px-4 py-3">
              <Link href={`/tests/${t.id}`} className="font-semibold hover:underline">
                {t.name}
              </Link>
              <span className="hidden text-muted lg:inline">{t.description}</span>
              <span className="ml-auto flex gap-3 whitespace-nowrap">
                <Link href={`/tests/${t.id}`} className="text-muted hover:text-fg">
                  History
                </Link>
                <Link href={`/run?test=${t.id}`} className="text-accent hover:underline">
                  Run →
                </Link>
              </span>
            </div>
            <LeaderboardTable rows={rows} />
          </section>
        );
      })}

      <section className="rounded-lg border border-line bg-panel">
        <h2 className="border-b border-line px-4 py-3 font-semibold">Recent runs</h2>
        {recent.length === 0 ? (
          <p className="px-4 py-6 text-muted">
            Nothing yet.{' '}
            <Link className="text-accent hover:underline" href="/run">
              Start a run
            </Link>
            .
          </p>
        ) : (
          <ul>
            {recent.map((s) => (
              <li key={s.id} className="border-b border-line last:border-0">
                <Link href={`/sessions/${s.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 hover:bg-code">
                  <span className="w-36 text-muted tabular">{new Date(s.createdAt).toLocaleString()}</span>
                  <span className="w-36 font-medium">{tests.find((t) => t.id === s.testId)?.name ?? s.testId}</span>
                  <span className="w-16 uppercase text-muted">
                    {s.lang} · {s.subset}
                  </span>
                  {s.variant && <span className="text-xs text-muted">{s.variant}</span>}
                  <span className="flex flex-1 flex-wrap gap-4">
                    {s.runs.map((r, i) => (
                      <span key={i}>
                        {r.model} <Score value={r.judgeAvg} />
                      </span>
                    ))}
                  </span>
                  <StatusPill status={s.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function StatusPill({ status }: { status: string }) {
  const cls = status === 'done' ? 'text-good' : status === 'error' ? 'text-bad' : 'text-mid';
  return <span className={`text-xs font-medium uppercase ${cls}`}>{status}</span>;
}
