'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CAPABILITIES, getCapability } from '@/config/capabilities';

interface TestSummary {
  id: string;
  name: string;
  description: string;
  requires: string[];
  requiresAny: string[];
  judged: boolean;
  cliOnly: boolean;
  languages: string[];
  numCtx: number;
  options: { id: string; label: string; description?: string; choices: { value: string; label: string }[]; default: string }[];
  caseCounts: Record<string, { quick: number; full: number }>;
}
interface ModelInfo {
  name: string;
  parameterSize: string;
  quantization: string;
  capabilities: string[];
  contextLength: number | null;
}

const fmtCtx = (n: number | null | undefined) => (n == null ? '?' : n >= 1024 ? `${Math.round(n / 1024)}k` : String(n));

interface HostContext {
  defaultContext: number;
  model: string;
  cappedByModel: boolean;
  error?: string;
}
interface Meta {
  tests: TestSummary[];
  languages: { code: string; name: string }[];
  judges: { id: string; label: string; modelId: string }[];
}

const field = 'w-full rounded-md border border-line bg-panel px-3 py-2 outline-none focus:border-accent';
const label = 'mb-1 block text-xs font-medium uppercase tracking-wide text-muted';

const fits = (t: Pick<TestSummary, 'requires' | 'requiresAny'>, m: ModelInfo) =>
  t.requires.every((c) => m.capabilities.includes(c)) && (!t.requiresAny.length || t.requiresAny.some((c) => m.capabilities.includes(c)));

type Mode = 'test' | 'capability';

export function RunForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [host, setHost] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);

  const [mode, setMode] = useState<Mode>(params.get('mode') === 'capability' ? 'capability' : 'test');
  const [testId, setTestId] = useState(params.get('test') ?? '');
  const [capId, setCapId] = useState(getCapability(params.get('cap') ?? undefined)?.id ?? CAPABILITIES[0].id);
  /** tests the user unchecked, per capability (everything is checked by default) */
  const [unchecked, setUnchecked] = useState<Record<string, string[]>>({});
  const [lang, setLang] = useState(params.get('lang') ?? 'en');
  const [modelA, setModelA] = useState('');
  const [modelB, setModelB] = useState('');
  const [subset, setSubset] = useState<'quick' | 'full'>('quick');
  const [think, setThink] = useState(false);
  const [temperature, setTemperature] = useState(0);
  const [seed, setSeed] = useState(42);
  const [numCtx, setNumCtx] = useState<number | ''>('');
  const [hostCtx, setHostCtx] = useState<HostContext | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [judges, setJudges] = useState<string[]>([]);
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function detectHostCtx() {
    setDetecting(true);
    try {
      const res = await fetch('/api/models/host-context', { method: 'POST' });
      setHostCtx((await res.json()) as HostContext);
    } finally {
      setDetecting(false);
    }
  }

  useEffect(() => {
    fetch('/api/tests')
      .then((r) => r.json())
      .then((m: Meta) => {
        setMeta(m);
        setJudges(m.judges.map((j) => j.id));
        setTestId((t) => t || m.tests.find((x) => !x.cliOnly)?.id || '');
      });
    fetch('/api/models')
      .then((r) => r.json())
      .then((d) => {
        setHost(d.host);
        if (d.error) setLoadError(d.error);
        setModels(d.models ?? []);
      });
  }, []);

  // CLI-only tests (hours per model) can't be started here, even from a ?test= link
  const test = meta?.tests.find((t) => t.id === testId && !t.cliOnly);
  const cap = getCapability(capId)!;
  const capTests = useMemo(
    () => cap.tests.map((id) => meta?.tests.find((t) => t.id === id)).filter((t): t is TestSummary => !!t),
    [cap, meta],
  );

  // language: the test's languages, or (capability) any language at least one of its tests has cases in
  const langsAvailable = mode === 'test' ? (test?.languages ?? []) : [...new Set(capTests.flatMap((t) => t.languages))];
  const effLang = langsAvailable.includes(lang) ? lang : (langsAvailable[0] ?? 'en');
  const checked = capTests.filter((t) => !t.cliOnly && t.languages.includes(effLang) && !(unchecked[capId] ?? []).includes(t.id));
  const runTests = mode === 'test' ? (test ? [test] : []) : checked;

  const eligible = runTests.length ? models.filter((m) => runTests.every((t) => fits(t, m))) : [];
  // keep selections valid when the test changes (derived, not synced via effects)
  const effA = eligible.some((m) => m.name === modelA) ? modelA : '';
  const effB = eligible.some((m) => m.name === modelB) ? modelB : '';
  const selected = [effA, effB].filter(Boolean);
  const maxCtx = (() => {
    const xs = selected
      .map((n) => models.find((m) => m.name === n)?.contextLength)
      .filter((x): x is number => typeof x === 'number' && x > 0);
    return xs.length ? Math.min(...xs) : null;
  })();
  const effExtra = Object.fromEntries(
    (test?.options ?? []).map((o) => [o.id, o.choices.some((c) => c.value === extra[o.id]) ? extra[o.id] : o.default]),
  );
  const canThink = selected.length > 0 && selected.every((n) => models.find((m) => m.name === n)?.capabilities.includes('thinking'));
  const anyJudged = runTests.some((t) => t.judged);
  const totalCases = runTests.reduce((a, t) => a + (t.caseCounts[effLang]?.[subset] ?? 0), 0) * Math.max(1, selected.length);
  const defaultCtx = mode === 'test' ? test?.numCtx : undefined;

  async function submit() {
    setSubmitting(true);
    setError(null);
    const config = { subset, think: canThink && think, temperature, seed, judges, ...(numCtx ? { numCtx } : {}) };
    const res =
      mode === 'test'
        ? await fetch('/api/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ testId, lang: effLang, models: selected, config: { ...config, extra: effExtra } }),
          })
        : await fetch('/api/batches', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ capability: capId, testIds: checked.map((t) => t.id), lang: effLang, models: selected, config }),
          });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? 'Failed to start');
      setSubmitting(false);
      return;
    }
    router.push(mode === 'test' ? `/sessions/${data.id}` : `/batches/${data.id}`);
  }

  if (!meta) return <p className="text-muted">Loading tests and models…</p>;

  const modelOption = (m: ModelInfo, other: string) => (
    <option key={m.name} value={m.name} disabled={m.name === other}>
      {m.name} ({m.parameterSize}, {m.quantization}, max ctx {fmtCtx(m.contextLength)})
    </option>
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <div className="space-y-6">
        <div className="inline-flex overflow-hidden rounded-md border border-line text-xs" role="tablist" aria-label="Run mode">
          {(
            [
              ['test', 'Single test'],
              ['capability', 'Capability'],
            ] as const
          ).map(([id, text]) => (
            <button
              key={id}
              role="tab"
              aria-selected={mode === id}
              onClick={() => setMode(id)}
              className={`border-l border-line px-3 py-1.5 first:border-l-0 ${mode === id ? 'bg-accent font-medium text-accent-fg' : 'bg-panel text-muted hover:text-fg'}`}
            >
              {text}
            </button>
          ))}
        </div>

        {mode === 'test' ? (
          <section>
            <span className={label}>Test</span>
            <div className="grid gap-2 sm:grid-cols-2">
              {meta.tests.map((t) => (
                <button
                  key={t.id}
                  onClick={() => !t.cliOnly && setTestId(t.id)}
                  disabled={t.cliOnly}
                  title={t.cliOnly ? `Hours per model: start it with "pnpm bench --tests ${t.id}"` : undefined}
                  className={`rounded-lg border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${t.id === testId ? 'border-accent bg-panel ring-1 ring-accent' : 'border-line bg-panel hover:border-muted'}`}
                >
                  <div className="font-medium">
                    {t.name}
                    {t.cliOnly && (
                      <span className="ml-2 rounded bg-code px-1.5 py-0.5 font-mono text-[11px] font-normal text-muted">CLI only</span>
                    )}
                  </div>
                  <div className="mt-1 text-xs text-muted">{t.description}</div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {t.requires.map((c) => (
                      <span key={c} className="rounded bg-code px-1.5 py-0.5 font-mono text-[11px] text-muted">
                        {c}
                      </span>
                    ))}
                    {t.requiresAny.length > 0 && (
                      <span className="rounded bg-code px-1.5 py-0.5 font-mono text-[11px] text-muted">{t.requiresAny.join(' | ')}</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </section>
        ) : (
          <section className="space-y-3">
            <span className={label}>Capability</span>
            <div className="flex flex-wrap gap-1.5 text-xs">
              {CAPABILITIES.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setCapId(c.id)}
                  title={c.description}
                  className={`rounded-full border px-3 py-1 ${c.id === capId ? 'border-accent text-accent' : 'border-line text-muted hover:text-fg'}`}
                >
                  {c.label}
                  <span className="ml-1.5 tabular opacity-70">{c.tests.length}</span>
                </button>
              ))}
            </div>
            <p className="text-xs text-muted">
              {cap.description}. One session per checked test, each with the selected models side by side, run one after another.
            </p>
            <ul className="divide-y divide-line rounded-lg border border-line bg-panel">
              {capTests.map((t) => {
                const available = !t.cliOnly && t.languages.includes(effLang);
                const on = checked.some((x) => x.id === t.id);
                const counts = t.caseCounts[effLang];
                const defaults = t.options.map((o) => `${o.id}=${o.default}`).join(' · ');
                return (
                  <li key={t.id} className={`flex items-start gap-3 px-3 py-2 ${available ? '' : 'opacity-50'}`}>
                    <input
                      type="checkbox"
                      className="mt-1"
                      disabled={!available}
                      checked={on}
                      onChange={(e) =>
                        setUnchecked((u) => {
                          const cur = u[capId] ?? [];
                          return { ...u, [capId]: e.target.checked ? cur.filter((x) => x !== t.id) : [...cur, t.id] };
                        })
                      }
                      aria-label={t.name}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-medium">{t.name}</span>
                        <span className="text-xs text-muted tabular">
                          {t.cliOnly
                            ? `CLI only: pnpm bench --tests ${t.id}`
                            : available
                              ? `${counts?.quick ?? 0} quick / ${counts?.full ?? 0} full`
                              : `no ${effLang.toUpperCase()} cases`}
                        </span>
                        {!t.judged && <span className="text-xs text-muted">· auto-scored</span>}
                      </div>
                      <div className="text-xs text-muted">{t.description}</div>
                      {defaults && <div className="font-mono text-[11px] text-muted">defaults: {defaults}</div>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>

      <aside className="space-y-4 rounded-lg border border-line bg-panel p-4">
        <section className="space-y-3 border-b border-line pb-4">
          <div>
            <label className={label}>Model A</label>
            <select className={field} value={effA} onChange={(e) => setModelA(e.target.value)}>
              <option value="">Select…</option>
              {eligible.map((m) => modelOption(m, effB))}
            </select>
          </div>
          <div>
            <label className={label}>Model B (optional, to compare)</label>
            <select className={field} value={effB} onChange={(e) => setModelB(e.target.value)}>
              <option value="">None</option>
              {eligible.map((m) => modelOption(m, effA))}
            </select>
          </div>
          <p className="text-[11px] text-muted">
            {eligible.length} of {models.length} models on <span className="font-mono">{host}</span> have the capabilities{' '}
            {mode === 'test' ? 'this test needs' : `every checked test needs (uncheck a test to widen the list)`}.
            {mode === 'test' && test && test.languages.length === 0 && (
              <span className="text-mid">
                {' '}
                No cases yet: download the benchmark data with <span className="font-mono">pnpm datasets:fetch {test.id}</span>.
              </span>
            )}
            {loadError && <span className="text-bad"> Could not reach Ollama: {loadError}</span>}
          </p>
        </section>
        <div>
          <label className={label}>Language</label>
          <select className={field} value={effLang} onChange={(e) => setLang(e.target.value)}>
            {meta.languages.map((l) => (
              <option key={l.code} value={l.code} disabled={!langsAvailable.includes(l.code)}>
                {l.name}
                {langsAvailable.includes(l.code) ? '' : ' (no cases)'}
              </option>
            ))}
          </select>
        </div>
        {mode === 'test' ? (
          test?.options.map((o) => (
            <div key={o.id}>
              <span className={label}>{o.label}</span>
              {o.choices.length > 3 ? (
                <select className={field} value={effExtra[o.id]} onChange={(e) => setExtra((x) => ({ ...x, [o.id]: e.target.value }))}>
                  {o.choices.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="flex gap-2">
                  {o.choices.map((c) => (
                    <button
                      key={c.value}
                      onClick={() => setExtra((x) => ({ ...x, [o.id]: c.value }))}
                      className={`flex-1 rounded-md border px-2 py-1.5 text-xs ${effExtra[o.id] === c.value ? 'border-accent text-accent' : 'border-line text-muted'}`}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              )}
              {o.description && <p className="mt-1 text-[11px] text-muted">{o.description}</p>}
            </div>
          ))
        ) : (
          <p className="text-[11px] text-muted">
            Test options stay at each test&apos;s defaults, so the results count toward the capability score.
          </p>
        )}
        <div>
          <span className={label}>Cases</span>
          <div className="flex gap-2">
            {(['quick', 'full'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSubset(s)}
                className={`flex-1 rounded-md border px-3 py-1.5 capitalize ${subset === s ? 'border-accent text-accent' : 'border-line text-muted'}`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <label className={`flex items-center gap-2 ${canThink ? '' : 'opacity-50'}`}>
          <input type="checkbox" disabled={!canThink} checked={canThink && think} onChange={(e) => setThink(e.target.checked)} />
          Thinking {canThink ? '' : '(not supported by every selected model)'}
        </label>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className={label}>Temp</label>
            <input
              className={field}
              type="number"
              step={0.1}
              min={0}
              max={2}
              value={temperature}
              onChange={(e) => setTemperature(Number(e.target.value))}
            />
          </div>
          <div>
            <label className={label}>Seed</label>
            <input className={field} type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} />
          </div>
          <div>
            <label className={label}>num_ctx</label>
            <input
              className={field}
              type="number"
              placeholder={defaultCtx ? String(defaultCtx) : 'per test'}
              value={numCtx}
              onChange={(e) => setNumCtx(e.target.value ? Number(e.target.value) : '')}
            />
          </div>
        </div>
        <div className="-mt-2 space-y-1 text-[11px] text-muted">
          <p>
            {mode === 'test' ? <>Test default {fmtCtx(defaultCtx)}</> : <>Each test uses its own default</>}
            {maxCtx != null && <> · max for the selected models {fmtCtx(maxCtx)}</>}
            {numCtx !== '' && numCtx !== defaultCtx && (
              <>
                {' '}
                · non-default values get their own leaderboard row
                {mode === 'capability' ? ' and don’t count toward the capability score' : ''}
              </>
            )}
          </p>
          {maxCtx != null && (numCtx || defaultCtx || 0) > maxCtx && (
            <p className="text-mid">Above the selected models&apos; maximum: the run will use {fmtCtx(maxCtx)}.</p>
          )}
          <p className="flex flex-wrap items-center gap-2">
            {hostCtx && !hostCtx.error && (
              <span title={`probed with ${hostCtx.model}`}>
                Host default {hostCtx.cappedByModel ? '≥ ' : ''}
                {fmtCtx(hostCtx.defaultContext)}
              </span>
            )}
            {hostCtx?.error && <span className="text-bad">{hostCtx.error}</span>}
            <button
              type="button"
              onClick={detectHostCtx}
              disabled={detecting}
              className="rounded border border-line px-1.5 py-0.5 hover:border-accent hover:text-accent disabled:opacity-50"
              title="Loads a small model without num_ctx for a moment and reads the context Ollama gives it (waits for any running benchmark)"
            >
              {detecting ? 'Detecting…' : 'Detect host default'}
            </button>
            {hostCtx && !hostCtx.error && (
              <button
                type="button"
                onClick={() => setNumCtx(maxCtx != null ? Math.min(hostCtx.defaultContext, maxCtx) : hostCtx.defaultContext)}
                className="rounded border border-line px-1.5 py-0.5 hover:border-accent hover:text-accent"
              >
                Use it
              </button>
            )}
          </p>
        </div>
        <div>
          <span className={label}>Judges (blind)</span>
          {!anyJudged && runTests.length > 0 && (
            <p className="text-xs text-muted">Not judged: this benchmark&apos;s metric is deterministic (accuracy).</p>
          )}
          {(anyJudged || !runTests.length) &&
            meta.judges.map((j) => (
              <label key={j.id} className="flex items-center gap-2 py-0.5">
                <input
                  type="checkbox"
                  checked={judges.includes(j.id)}
                  onChange={(e) => setJudges((js) => (e.target.checked ? [...js, j.id] : js.filter((x) => x !== j.id)))}
                />
                {j.label} <span className="font-mono text-xs text-muted">{j.modelId}</span>
              </label>
            ))}
          {mode === 'capability' && anyJudged && runTests.some((t) => !t.judged) && (
            <p className="mt-1 text-[11px] text-muted">Auto-scored tests in this batch ignore the judges.</p>
          )}
        </div>
        {mode === 'capability' && (
          <p className="text-xs text-muted tabular">
            → {checked.length} session{checked.length === 1 ? '' : 's'} · {selected.length || '1–2'} model{selected.length === 1 ? '' : 's'}{' '}
            · {totalCases} cases
          </p>
        )}
        {error && <p className="text-bad">{error}</p>}
        <button
          disabled={!effA || submitting || !runTests.length}
          onClick={submit}
          className="w-full rounded-md bg-accent px-3 py-2 font-medium text-accent-fg disabled:opacity-40"
        >
          {submitting
            ? 'Starting…'
            : mode === 'capability'
              ? `Start ${cap.label.toLowerCase()} batch`
              : selected.length === 2
                ? 'Run comparison'
                : 'Run'}
        </button>
      </aside>
    </div>
  );
}
