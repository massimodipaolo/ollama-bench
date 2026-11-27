import { Suspense } from 'react';
import Link from 'next/link';
import { connection } from 'next/server';
import { compareModels, modelIndex, type ModelComparison } from '@/lib/queries';
import { LANGUAGES } from '@/config/languages';
import { CompareForm } from '@/components/compare-form';
import { CompareHistoryChart, CompareLegend, CompareRadar, type CompareAxis } from '@/components/charts';
import { LinkTabs, hrefWith } from '@/components/link-tabs';
import { modelHref } from '@/components/leaderboard-table';
import { fmtNum } from '@/components/score';

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

      <section className="overflow-x-auto rounded-lg border border-line bg-panel">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted">
            <tr className="border-b border-line">
              <th className="px-4 py-2 font-medium"> </th>
              <th className="px-3 py-2 text-right font-medium normal-case">{ma.name}</th>
              <th className="px-3 py-2 text-right font-medium normal-case">{mb.name}</th>
              <th className="px-4 py-2 text-right font-medium" title="first model minus second model">
                Δ
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-line bg-code/50">
              <td colSpan={4} className="px-4 py-1.5 text-xs font-medium uppercase tracking-wide text-muted">
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
                </tr>
              ))}
            <tr className="border-b border-line bg-code/50">
              <td colSpan={4} className="px-4 py-1.5 text-xs font-medium uppercase tracking-wide text-muted">
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
