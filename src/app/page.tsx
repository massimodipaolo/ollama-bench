import { Suspense } from 'react';
import Link from 'next/link';
import { connection } from 'next/server';
import { bestPerModel, capabilityBoard, capabilityOverview, leaderboard, recentSessions } from '@/lib/queries';
import { listTests, type TestSummary } from '@/lib/tests/registry';
import { Score, fmtDuration } from '@/components/score';
import { LeaderboardTable } from '@/components/leaderboard-table';
import { TierFilter } from '@/components/tier-filter';
import { LinkTabs, hrefWith } from '@/components/link-tabs';
import { CapabilityTable, OverviewTable } from '@/components/capability-table';
import { CAPABILITIES, getCapability } from '@/config/capabilities';
import { LANGUAGES } from '@/config/languages';
import { StatusPill } from '@/components/status-pill';
import { SpeedQualityScatter, type SpeedPoint } from '@/components/charts';
import { inTier, parseTier, type Tier } from '@/lib/tiers';

type SP = PageProps<'/'>['searchParams'];
const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default function Dashboard({ searchParams }: PageProps<'/'>) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-muted">
          Per test: each model&apos;s best result (any language or variant; the test page lists them all). Per capability: the latest result
          with default settings. Scores are 0–10: each judge&apos;s score, their average, and the automatic checks.
        </p>
      </div>
      <Suspense fallback={<p className="text-muted">Loading…</p>}>
        <Boards searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Boards({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const tier: Tier = parseTier(str(sp.tier));
  const view = str(sp.view) === 'capability' ? 'capability' : 'test';
  const cap = getCapability(str(sp.cap))?.id ?? 'overview';
  const lang = LANGUAGES.some((l) => l.code === str(sp.lang)) ? str(sp.lang)! : LANGUAGES[0].code;
  await connection();
  const tests = await listTests();
  const recent = recentSessions(15);

  // every link keeps the other filters
  const base = {
    view: view === 'capability' ? 'capability' : undefined,
    cap: cap === 'overview' ? undefined : cap,
    lang: view === 'capability' ? lang : undefined,
    tier: tier === 'all' ? undefined : tier,
  };
  const link = (p: Partial<typeof base>) => hrefWith('/', { ...base, ...p });

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <LinkTabs
          variant="segmented"
          label="View"
          current={view}
          items={[
            { id: 'test', label: 'By test', href: link({ view: undefined, cap: undefined, lang: undefined }) },
            { id: 'capability', label: 'By capability', href: link({ view: 'capability', lang }) },
          ]}
        />
        <TierFilter
          basePath="/"
          current={tier}
          params={Object.fromEntries(Object.entries({ ...base, tier: undefined }).filter((e): e is [string, string] => !!e[1]))}
        />
        {view === 'capability' && (
          <LinkTabs
            variant="segmented"
            label="Language"
            current={lang}
            items={LANGUAGES.map((l) => ({ id: l.code, label: l.code.toUpperCase(), href: link({ lang: l.code }), title: l.englishName }))}
          />
        )}
      </div>

      {view === 'capability' ? <CapabilityView cap={cap} lang={lang} tier={tier} link={link} /> : <TestView tests={tests} tier={tier} />}

      <RecentRuns recent={recent} tests={tests} />
    </>
  );
}

async function CapabilityView({
  cap,
  lang,
  tier,
  link,
}: {
  cap: string;
  lang: string;
  tier: Tier;
  link: (p: Record<string, string | undefined>) => string;
}) {
  const chips = [
    { id: 'overview', label: 'Overview', href: link({ cap: undefined }), title: 'Every model across all capabilities' },
    ...CAPABILITIES.map((c) => ({
      id: c.id,
      label: c.label,
      hint: String(c.tests.length),
      href: link({ cap: c.id }),
      title: c.description,
    })),
  ];
  const def = getCapability(cap);
  return (
    <section className="rounded-lg border border-line bg-panel">
      <div className="space-y-3 border-b border-line px-4 py-3">
        <LinkTabs label="Capability" current={cap} items={chips} />
        {def ? (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-semibold">{def.label}</span>
            <span className="text-muted">{def.description}</span>
            <Link
              href={`/run?mode=capability&cap=${def.id}&lang=${lang}`}
              className="ml-auto whitespace-nowrap text-accent hover:underline"
            >
              Run {def.label.toLowerCase()} batch →
            </Link>
          </div>
        ) : (
          <p className="text-muted">Each capability&apos;s score per model. Click a column for its tests.</p>
        )}
        <p className="text-xs text-muted">
          Score = mean of the model&apos;s best current result on each of the capability&apos;s tests in this language, over every run (a
          superscript marks a non-default variant: 32k for another num_ctx, * for other test options; hover for details). Ranked only with a
          result on every test the model can take that has been run at all; partial rows are shown in brackets. Struck-out cells come from
          an older version of a test and don&apos;t count.
        </p>
      </div>
      {def ? <BoardFor cap={def.id} lang={lang} tier={tier} /> : <OverviewFor lang={lang} tier={tier} link={link} />}
    </section>
  );
}

const tok1 = (x: number) => Math.round(x * 10) / 10;

async function BoardFor({ cap, lang, tier }: { cap: string; lang: string; tier: Tier }) {
  const board = await capabilityBoard(cap, lang, tier);
  if (!board) return null;
  const ranked = board.rows.filter((r) => r.ranked && r.score != null);
  const points: SpeedPoint[] = ranked
    .filter((r) => r.avgTokPerSec != null)
    .map((r) => ({ model: r.model, x: tok1(r.avgTokPerSec!), score: r.score! }));
  return (
    <>
      <CapabilityTable board={board} />
      <SpeedVsQuality
        points={points}
        withoutTok={ranked.length - points.length}
        yLabel={`${board.capability.label} score`}
        scope={`Ranked models: the ${board.capability.label.toLowerCase()} score above against their mean tokens/s on the same results`}
      />
    </>
  );
}

async function OverviewFor({ lang, tier, link }: { lang: string; tier: Tier; link: (p: Record<string, string | undefined>) => string }) {
  const rows = await capabilityOverview(lang, tier);
  const ranked = rows.filter((r) => !r.baseline && r.overall != null);
  const points: SpeedPoint[] = ranked
    .filter((r) => r.avgTokPerSec != null)
    .map((r) => ({
      model: r.model,
      x: tok1(r.avgTokPerSec!),
      score: r.overall!,
      detail: `Mean of ${r.overallOf.length} ranked ${r.overallOf.length === 1 ? 'capability' : 'capabilities'}: ${r.overallOf.join(', ')}`,
    }));
  return (
    <>
      <OverviewTable rows={rows} capHref={(id) => link({ cap: id })} />
      <SpeedVsQuality
        points={points}
        withoutTok={ranked.length - points.length}
        yLabel="Overall score"
        scope="Models with at least one ranked capability: the mean of their ranked capability scores against their mean tokens/s (each test once)"
      />
    </>
  );
}

/** Only where tokens/s applies: models without a throughput figure (embedding, reranking) are left out and counted. */
function SpeedVsQuality({
  points,
  withoutTok,
  yLabel,
  scope,
}: {
  points: SpeedPoint[];
  withoutTok: number;
  yLabel: string;
  scope: string;
}) {
  if (!points.length && !withoutTok) return null;
  return (
    <div className="border-t border-line p-4">
      <h3 className="font-semibold">Speed vs quality</h3>
      <p className="mb-3 text-xs text-muted">
        {scope}. Up is better; right is faster.
        {withoutTok > 0 &&
          ` Not shown: ${withoutTok} ranked ${withoutTok === 1 ? 'model' : 'models'} with no tokens/s (embedding and reranking models don't generate text).`}
      </p>
      {points.length ? (
        <SpeedQualityScatter points={points} xLabel="tokens/s" yLabel={yLabel} />
      ) : (
        <p className="text-xs text-muted">Tokens/s doesn&apos;t apply to these models.</p>
      )}
    </div>
  );
}

function TestView({ tests, tier }: { tests: TestSummary[]; tier: Tier }) {
  return (
    <>
      {tests.map((t) => {
        // one row per model: its best result in any language or variant (the test page lists them all)
        const rows = bestPerModel(
          leaderboard(t.id).filter((r) => inTier(r.parameterSize, tier)),
          t.suiteVersion,
        );
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
            <LeaderboardTable rows={rows} moreHref={`/tests/${t.id}`} />
          </section>
        );
      })}
    </>
  );
}

function RecentRuns({ recent, tests }: { recent: ReturnType<typeof recentSessions>; tests: TestSummary[] }) {
  return (
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
            <li key={s.id} className="flex items-center border-b border-line last:border-0 hover:bg-code">
              <Link href={`/sessions/${s.id}`} className="flex flex-1 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
                <span className="w-36 text-muted tabular">{new Date(s.createdAt).toLocaleString()}</span>
                <span className="w-36 font-medium">{tests.find((t) => t.id === s.testId)?.name ?? s.testId}</span>
                <span className="w-16 uppercase text-muted">
                  {s.lang} · {s.subset}
                </span>
                {s.variant && <span className="text-xs text-muted">{s.variant}</span>}
                <span className="flex flex-1 flex-wrap gap-4">
                  {s.runs.map((r, i) => (
                    <span key={i}>
                      {r.model} <Score value={r.judgeAvg ?? r.autoScore} />
                    </span>
                  ))}
                </span>
                {s.execMs != null && (
                  <span
                    className="text-xs text-muted tabular"
                    title="Execution time: the models' work; automatic checks, judging and time queued excluded"
                  >
                    {fmtDuration(s.execMs)}
                  </span>
                )}
                <StatusPill status={s.status} />
              </Link>
              {s.batchId && (
                <Link
                  href={`/batches/${s.batchId}`}
                  className="mr-4 rounded bg-code px-1.5 py-0.5 text-xs text-muted hover:text-fg"
                  title="Part of a capability batch"
                >
                  batch
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
