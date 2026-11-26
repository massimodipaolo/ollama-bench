'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

interface TestSummary {
  id: string;
  name: string;
  description: string;
  requires: string[];
  requiresAny: string[];
  judged: boolean;
  languages: string[];
  numCtx: number;
  options: { id: string; label: string; description?: string; choices: { value: string; label: string }[]; default: string }[];
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

export function RunForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [host, setHost] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);

  const [testId, setTestId] = useState(params.get('test') ?? '');
  const [lang, setLang] = useState('en');
  const [modelA, setModelA] = useState('');
  const [modelB, setModelB] = useState('');
  const [subset, setSubset] = useState<'quick' | 'full'>('quick');
  const [think, setThink] = useState(false);
  const [temperature, setTemperature] = useState(0);
  const [seed, setSeed] = useState(42);
  const [numCtx, setNumCtx] = useState<number | ''>('');
  const [hostCtx, setHostCtx] = useState<HostContext | null>(null);
  const [detecting, setDetecting] = useState(false);

  async function detectHostCtx() {
    setDetecting(true);
    try {
      const res = await fetch('/api/models/host-context', { method: 'POST' });
      setHostCtx((await res.json()) as HostContext);
    } finally {
      setDetecting(false);
    }
  }
  const [judges, setJudges] = useState<string[]>([]);
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/tests')
      .then((r) => r.json())
      .then((m: Meta) => {
        setMeta(m);
        setJudges(m.judges.map((j) => j.id));
        setTestId((t) => t || m.tests[0]?.id || '');
      });
    fetch('/api/models')
      .then((r) => r.json())
      .then((d) => {
        setHost(d.host);
        if (d.error) setLoadError(d.error);
        setModels(d.models ?? []);
      });
  }, []);

  const test = meta?.tests.find((t) => t.id === testId);
  const eligible = useMemo(
    () =>
      test
        ? models.filter(
            (m) =>
              test.requires.every((c) => m.capabilities.includes(c)) &&
              (!test.requiresAny.length || test.requiresAny.some((c) => m.capabilities.includes(c))),
          )
        : [],
    [models, test],
  );
  // keep selections valid when the test changes (derived, not synced via effects)
  const effLang = test && !test.languages.includes(lang) ? (test.languages[0] ?? 'en') : lang;
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

  async function submit() {
    setSubmitting(true);
    setError(null);
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        testId,
        lang: effLang,
        models: selected,
        config: { subset, think: canThink && think, temperature, seed, judges, extra: effExtra, ...(numCtx ? { numCtx } : {}) },
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? 'Failed to start');
      setSubmitting(false);
      return;
    }
    router.push(`/sessions/${data.id}`);
  }

  if (!meta) return <p className="text-muted">Loading tests and models…</p>;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <div className="space-y-6">
        <section>
          <span className={label}>Test</span>
          <div className="grid gap-2 sm:grid-cols-2">
            {meta.tests.map((t) => (
              <button
                key={t.id}
                onClick={() => setTestId(t.id)}
                className={`rounded-lg border p-3 text-left transition ${t.id === testId ? 'border-accent bg-panel ring-1 ring-accent' : 'border-line bg-panel hover:border-muted'}`}
              >
                <div className="font-medium">{t.name}</div>
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

        <section className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={label}>Model A</label>
            <select className={field} value={effA} onChange={(e) => setModelA(e.target.value)}>
              <option value="">Select…</option>
              {eligible.map((m) => (
                <option key={m.name} value={m.name} disabled={m.name === effB}>
                  {m.name} ({m.parameterSize}, {m.quantization}, max ctx {fmtCtx(m.contextLength)})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={label}>Model B (optional, to compare)</label>
            <select className={field} value={effB} onChange={(e) => setModelB(e.target.value)}>
              <option value="">None</option>
              {eligible.map((m) => (
                <option key={m.name} value={m.name} disabled={m.name === effA}>
                  {m.name} ({m.parameterSize}, {m.quantization}, max ctx {fmtCtx(m.contextLength)})
                </option>
              ))}
            </select>
          </div>
          <p className="text-xs text-muted sm:col-span-2">
            {eligible.length} of {models.length} models on <span className="font-mono">{host}</span> have the capabilities this test needs.
            {test && test.languages.length === 0 && (
              <span className="text-mid">
                {' '}
                No cases yet: download the benchmark data with <span className="font-mono">pnpm datasets:fetch {test.id}</span>.
              </span>
            )}
            {loadError && <span className="text-bad"> Could not reach Ollama: {loadError}</span>}
          </p>
        </section>
      </div>

      <aside className="space-y-4 rounded-lg border border-line bg-panel p-4">
        <div>
          <label className={label}>Language</label>
          <select className={field} value={effLang} onChange={(e) => setLang(e.target.value)}>
            {meta.languages.map((l) => (
              <option key={l.code} value={l.code} disabled={!test?.languages.includes(l.code)}>
                {l.name}
                {test?.languages.includes(l.code) ? '' : ' (no cases)'}
              </option>
            ))}
          </select>
        </div>
        {test?.options.map((o) => (
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
        ))}
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
              placeholder={String(test?.numCtx ?? '')}
              value={numCtx}
              onChange={(e) => setNumCtx(e.target.value ? Number(e.target.value) : '')}
            />
          </div>
        </div>
        <div className="-mt-2 space-y-1 text-[11px] text-muted">
          <p>
            Test default {fmtCtx(test?.numCtx)}
            {maxCtx != null && <> · max for the selected models {fmtCtx(maxCtx)}</>}
            {(numCtx || test?.numCtx || 0) !== (test?.numCtx ?? 0) && <> · non-default values get their own leaderboard row</>}
          </p>
          {maxCtx != null && (numCtx || test?.numCtx || 0) > maxCtx && (
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
          {test && !test.judged && (
            <p className="text-xs text-muted">Not judged: this benchmark&apos;s metric is deterministic (accuracy).</p>
          )}
          {(!test || test.judged) &&
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
        </div>
        {error && <p className="text-bad">{error}</p>}
        <button
          disabled={!testId || !effA || submitting}
          onClick={submit}
          className="w-full rounded-md bg-accent px-3 py-2 font-medium text-accent-fg disabled:opacity-40"
        >
          {submitting ? 'Starting…' : selected.length === 2 ? 'Run comparison' : 'Run'}
        </button>
      </aside>
    </div>
  );
}
