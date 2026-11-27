'use client';

import { useCallback, useEffect, useState } from 'react';

interface Loaded {
  name: string;
  sizeVram: number;
  contextLength: number | null;
  expiresAt: string;
  inUse: boolean;
}

const gb = (b: number) => `${(b / 1e9).toFixed(1)} GB`;
const ctx = (n: number | null) => (n == null ? '' : n >= 1024 ? `${Math.round(n / 1024)}k ctx` : `${n} ctx`);
const until = (iso: string) => {
  const ms = new Date(iso).getTime() - Date.now();
  return ms <= 0 ? 'expiring' : ms < 3_600_000 ? `unloads in ${Math.ceil(ms / 60_000)} min` : `until ${new Date(iso).toLocaleString()}`;
};

/**
 * What the Ollama host holds in memory right now. Models nothing queued needs are freed automatically after each
 * session (see runner/residency.ts); this lists leftovers (e.g. from another app or a stopped server) with an
 * Unload button. Models a queued/running session needs can't be unloaded.
 */
export function HostMemory() {
  const [models, setModels] = useState<Loaded[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      fetch('/api/ollama/loaded', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((m: Loaded[] | null) => setModels(m))
        .catch(() => {}),
    [],
  );

  useEffect(() => {
    load();
    const t = setInterval(() => document.visibilityState === 'visible' && load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  async function unload(name: string) {
    setBusy(name);
    setError(null);
    const r = await fetch('/api/ollama/unload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name }),
    });
    if (!r.ok) setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
    setBusy(null);
    load();
  }

  if (!models?.length) return null;
  const total = models.reduce((a, m) => a + m.sizeVram, 0);
  return (
    <section className="rounded-lg border border-line bg-panel text-sm">
      <div className="flex items-baseline gap-3 border-b border-line px-4 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">Loaded on the Ollama host</span>
        <span className="text-xs text-muted tabular">{gb(total)} in use</span>
      </div>
      <ul>
        {models.map((m) => (
          <li key={m.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-1.5 last:border-0">
            <span className="font-medium">{m.name}</span>
            <span className="text-xs text-muted tabular">
              {gb(m.sizeVram)}
              {m.contextLength ? ` · ${ctx(m.contextLength)}` : ''} · {m.inUse ? 'needed by a session' : until(m.expiresAt)}
            </span>
            <button
              type="button"
              onClick={() => unload(m.name)}
              disabled={m.inUse || busy === m.name}
              title={m.inUse ? 'A queued or running session uses this model' : 'Free its memory now'}
              className="ml-auto rounded-md border border-line px-2 py-0.5 text-xs text-muted hover:border-bad hover:text-bad disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === m.name ? 'Unloading…' : 'Unload'}
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="border-t border-line px-4 py-1.5 text-xs text-bad">{error}</p>}
    </section>
  );
}
