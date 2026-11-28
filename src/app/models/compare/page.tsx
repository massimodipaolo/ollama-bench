import { Suspense } from 'react';
import Link from 'next/link';
import { connection } from 'next/server';
import { compareModels, modelIndex, type ModelComparison, type SpeedCell } from '@/lib/queries';
import { LANGUAGES } from '@/config/languages';
import { CompareForm } from '@/components/compare-form';
import { CompareHistoryChart, CompareLegend, CompareRadar, CompareSpeed, type CompareAxis, type SpeedAxis } from '@/components/charts';
import { LinkTabs, hrefWith } from '@/components/link-tabs';
import { modelHref } from '@/components/leaderboard-table';
import { fmtDuration, fmtNum } from '@/components/score';

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default function ComparePage({ searchParams }: PageProps<'/models/compare'>) {
  return (
    <Suspense fallback={<p className="text-muted">Loading…</p>}>
      <CompareView searchParams={searchParams} />
    </Suspense>
  );
}

async function CompareView({ searchParams }: { searchParams: PageProps<'/models/compare'>['searchParams'] }) {
  const sp = await searchParams;
  const a = str(sp.a) ?? '';
  const b = str(sp.b) ?? '';
  const lang = LANGUAGES.some((l) => l.code === str(sp.lang)) ? str(sp.lang)! : LANGUAGES[0].code;
  await connection();
  const options = modelIndex().map((m) => ({ name: m.name, capabilities: m.capabilities, parameterSize: m.parameterSize }));
  const cmp = a && b ? await compareModels(a, b, lang) : null;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/models" className="text-xs text-muted hover:text-fg">
          ← Models
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">{cmp ? `${a} vs ${b}` : 'Compare models'}</h1>
      </div>
      <section className="rounded-lg border border-line bg-panel px-4 py-3">
        <CompareForm key={`${a}|${b}`} models={options} initialA={a} initialB={b} lang={lang} />
      </section>
      {a && b && !cmp && <p className="text-bad">Unknown model: {[a, b].filter((n) => !options.some((o) => o.name === n)).join(', ')}</p>}
      {cmp && <Comparison cmp={cmp} />}
    </div>
  );
}

const sign = (d: number) => (d > 0 ? `+${d.toFixed(1)}` : d.toFixed(1));

/** table columns: label + score (A, B, Δ) + tokens/s (A, B) + avg case time (A, B) */
const COLS = 8;

/** Sub-headers of a column group: each model's swatch and name (the swatches match the charts), plus Δ for scores. */
function ModelHeads({ names, delta }: { names: [string, string]; delta: boolean }) {
  return (
    <>
      {names.map((n, i) => (
        <th key={n} className={`px-3 pb-2 text-right font-medium normal-case ${i === 0 ? 'border-l border-line' : ''}`} title={n}>
          <span className="inline-flex max-w-[11rem] items-center justify-end gap-1.5">
            <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: `var(--series-${i + 1})` }} />
            <span className="truncate">{n}</span>
          </span>
        </th>
      ))}
      {delta && (
        <th className="px-4 pb-2 text-right font-medium" title="first model minus second model">
          Δ
        </th>
      )}
    </>
  );
}

/** Tokens/s and average case time of both models; an estimated time is marked ≈, an outdated result struck through. */
function SpeedCells({ a, b, stale = [false, false] }: { a?: SpeedCell; b?: SpeedCell; stale?: [boolean, boolean] }) {
  const cls = (i: number, first: boolean) =>
    `px-3 py-1.5 text-right tabular ${first ? 'border-l border-line' : ''} ${stale[i] ? 'text-muted line-through' : ''}`;
  return (
    <>
      {[a, b].map((s, i) => (
        <td key={`tok${i}`} className={cls(i, i === 0)}>
          {fmtNum(s?.tokPerSec)}
        </td>
      ))}
      {[a, b].map((s, i) => (
        <td
          key={`ms${i}`}
          className={cls(i, i === 0)}
          title={s?.approx ? 'estimated: (run time − model load) / cases, for a run recorded before cases were timed' : undefined}
        >
          {s?.caseMs == null ? '–' : `${s.approx ? '≈ ' : ''}${fmtDuration(s.caseMs)}`}
        </td>
      ))}
    </>
  );
}

function Comparison({ cmp }: { cmp: ModelComparison }) {
  const [ma, mb] = cmp.models;
  const link = (p: Record<string, string>) => hrefWith('/models/compare', { a: ma.name, b: mb.name, lang: cmp.lang, ...p });

  // polar axes: only where both models have a score (a missing value would read as 0)
  const capAxes: CompareAxis[] = cmp.capabilities
    .filter((c) => c.a?.score != null && c.b?.score != null)
    .map((c) => ({ axis: c.label, a: c.a!.score, b: c.b!.score }));
  const testAxes: CompareAxis[] = cmp.tests
    .filter((t) => t.a && !t.a.stale && t.a.score != null && t.b && !t.b.stale && t.b.score != null)
    .map((t) => ({ axis: t.name.replace(/\s*\(.*\)$/, ''), a: t.a!.score, b: t.b!.score }));
  // speed: per test, current results only (as the radar); a chart draws a test where both models have the measure
  const speedAxes: SpeedAxis[] = cmp.tests
    .filter((t) => t.a && !t.a.stale && t.b && !t.b.stale)
    .map((t) => ({
      axis: t.name.replace(/\s*\(.*\)$/, ''),
      aTok: t.speed.a?.tokPerSec ?? null,
      bTok: t.speed.b?.tokPerSec ?? null,
      aMs: t.speed.a?.caseMs ?? null,
      bMs: t.speed.b?.caseMs ?? null,
    }));
  const anyApprox = cmp.tests.some((t) => t.speed.a?.approx || t.speed.b?.approx);
  const history = cmp.history.filter((h) => h.lang === cmp.lang);

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <div className="grid flex-1 gap-1 text-sm sm:grid-cols-2">
          {[ma, mb].map((m, i) => (
            <div key={m.name} className="flex items-center gap-2">
              <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: `var(--series-${i + 1})` }} />
              <Link href={modelHref(m.name)} className="font-medium hover:underline">
                {m.name}
              </Link>
              <span className="font-mono text-xs text-muted">{[m.parameterSize, m.quantization].filter(Boolean).join(' · ')}</span>
            </div>
          ))}
        </div>
        <Link href={link({ a: mb.name, b: ma.name })} className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:text-fg">
          ⇄ Swap
        </Link>
        <LinkTabs
          variant="segmented"
          label="Language"
          current={cmp.lang}
          items={LANGUAGES.map((l) => ({ id: l.code, label: l.code.toUpperCase(), href: link({ lang: l.code }), title: l.englishName }))}
        />
      </div>
      <p className="text-xs text-muted">
        Shared capabilities: {cmp.commonCapabilities.join(', ')}. Scores are the latest current results with default options (as on the
        dashboard): judge average, or the automatic score for unjudged tests.
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-lg border border-line bg-panel p-4">
          <div className="mb-2 flex flex-wrap items-baseline gap-3">
            <h2 className="font-semibold">By capability</h2>
            <CompareLegend a={ma.name} b={mb.name} />
          </div>
          <CompareRadar axes={capAxes} a={ma.name} b={mb.name} />
        </section>
        <section className="rounded-lg border border-line bg-panel p-4">
          <div className="mb-2 flex flex-wrap items-baseline gap-3">
            <h2 className="font-semibold">By test</h2>
            <CompareLegend a={ma.name} b={mb.name} />
          </div>
          <CompareRadar axes={testAxes} a={ma.name} b={mb.name} />
        </section>
      </div>

      <section className="rounded-lg border border-line bg-panel p-4">
        <div className="mb-2 flex flex-wrap items-baseline gap-3">
          <h2 className="font-semibold">Speed by test</h2>
          <CompareLegend a={ma.name} b={mb.name} />
        </div>
        <CompareSpeed axes={speedAxes} a={ma.name} b={mb.name} />
        <p className="mt-2 text-xs text-muted">
          Same results as the scores. Case execution time covers the whole case (every model call, tool call and test step); automatic
          checks and judging are left out.
          {anyApprox && ' Runs recorded before cases were timed are estimated as (run time − model load) / cases, marked ≈ in the table.'}
        </p>
      </section>

      <section className="overflow-x-auto rounded-lg border border-line bg-panel">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 pt-2 font-medium" rowSpan={2}>
                {' '}
              </th>
              <th colSpan={3} className="border-l border-line px-3 pt-2 text-center font-medium">
                Score
              </th>
              <th colSpan={2} className="border-l border-line px-3 pt-2 text-center font-medium">
                Tokens/s
              </th>
              <th
                colSpan={2}
                className="border-l border-line px-3 pt-2 text-center font-medium"
                title="Average execution time of one case: checks and judging excluded"
              >
                Avg case time
              </th>
            </tr>
            <tr className="border-b border-line">
              {[0, 1, 2].map((g) => (
                <ModelHeads key={g} names={[ma.name, mb.name]} delta={g === 0} />
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-line bg-code/50">
              <td colSpan={COLS} className="px-4 py-1.5 text-xs font-medium uppercase tracking-wide text-muted">
                Capabilities
              </td>
            </tr>
            {cmp.capabilities
              .filter((c) => c.a?.score != null || c.b?.score != null)
              .map((c) => (
                <tr key={c.id} className="border-b border-line">
                  <td className="px-4 py-1.5">
                    <Link href={`/?view=capability&cap=${c.id}&lang=${cmp.lang}`} className="hover:underline">
                      {c.label}
                    </Link>
                  </td>
                  {[c.a, c.b].map((x, i) => (
                    <td
                      key={i}
                      className="px-3 py-1.5 text-right tabular"
                      title={x && !x.ranked ? `partial: ${x.covered}/${x.required} tests` : undefined}
                    >
                      {x?.score == null ? '–' : x.ranked ? fmtNum(x.score) : `(${fmtNum(x.score)})`}
                    </td>
                  ))}
                  <td className="px-4 py-1.5 text-right tabular text-muted">
                    {c.a?.score != null && c.b?.score != null ? sign(c.a.score - c.b.score) : ''}
                  </td>
                  <SpeedCells a={c.speed.a} b={c.speed.b} />
                </tr>
              ))}
            <tr className="border-b border-line bg-code/50">
              <td colSpan={COLS} className="px-4 py-1.5 text-xs font-medium uppercase tracking-wide text-muted">
                Tests
              </td>
            </tr>
            {cmp.tests
              .filter((t) => t.a || t.b)
              .map((t) => (
                <tr key={t.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-1.5">
                    <Link href={`/tests/${t.id}?lang=${cmp.lang}`} className="hover:underline">
                      {t.name}
                    </Link>
                  </td>
                  {[t.a, t.b].map((x, i) => (
                    <td key={i} className="px-3 py-1.5 text-right tabular">
                      {x ? (
                        <Link
                          href={`/sessions/${x.sessionId}`}
                          className={`hover:underline ${x.stale ? 'text-muted line-through' : ''}`}
                          title={x.stale ? 'older version of the test: not compared' : undefined}
                        >
                          {fmtNum(x.score)}
                        </Link>
                      ) : (
                        '–'
                      )}
                    </td>
                  ))}
                  <td className="px-4 py-1.5 text-right tabular text-muted">
                    {t.a && t.b && !t.a.stale && !t.b.stale && t.a.score != null && t.b.score != null ? sign(t.a.score - t.b.score) : ''}
                  </td>
                  <SpeedCells a={t.speed.a} b={t.speed.b} stale={[!!t.a?.stale, !!t.b?.stale]} />
                </tr>
              ))}
          </tbody>
        </table>
      </section>

      {history.length > 0 && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-baseline gap-4">
            <h2 className="font-semibold">History by test</h2>
            <CompareLegend a={ma.name} b={mb.name} />
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {history.map((h) => {
              const lastA = h.a[h.a.length - 1];
              const lastB = h.b[h.b.length - 1];
              return (
                <div key={h.key} className="rounded-lg border border-line bg-panel p-3">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <Link href={`/tests/${h.testId}?lang=${h.lang}`} className="font-medium hover:underline">
                      {h.testName}
                    </Link>
                    {h.variant && <span className="rounded bg-code px-1.5 text-xs text-muted">{h.variant}</span>}
                    <span className="ml-auto text-xs text-muted tabular">
                      latest {fmtNum(lastA?.score)} vs {fmtNum(lastB?.score)}
                    </span>
                  </div>
                  <CompareHistoryChart a={h.a} b={h.b} aName={ma.name} bName={mb.name} />
                </div>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}
