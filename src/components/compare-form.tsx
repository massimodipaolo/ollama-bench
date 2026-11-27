'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface CompareModelOption {
  name: string;
  capabilities: string[];
  parameterSize: string | null;
}

const field = 'min-w-0 flex-1 rounded-md border border-line bg-panel px-3 py-1.5 text-sm outline-none focus:border-accent';
const shared = (x: CompareModelOption, y: CompareModelOption) => x.capabilities.filter((c) => y.capabilities.includes(c));

/** Pick model A, then a model B that shares at least one Ollama capability with it, and open the comparison. */
export function CompareForm({
  models,
  initialA = '',
  initialB = '',
  lang,
}: {
  models: CompareModelOption[];
  initialA?: string;
  initialB?: string;
  lang?: string;
}) {
  const router = useRouter();
  const [a, setA] = useState(initialA);
  const [b, setB] = useState(initialB);
  const ma = models.find((m) => m.name === a);
  const candidates = ma ? models.filter((m) => m.name !== a && shared(ma, m).length > 0) : [];
  // keep B valid when A changes (derived, not synced through an effect)
  const effB = candidates.some((m) => m.name === b) ? b : '';
  const mb = models.find((m) => m.name === effB);
  const common = ma && mb ? shared(ma, mb) : [];
  const label = (m: CompareModelOption) => `${m.name}${m.parameterSize ? ` (${m.parameterSize})` : ''}`;

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!a || !effB) return;
        const q = new URLSearchParams({ a, b: effB, ...(lang ? { lang } : {}) });
        router.push(`/models/compare?${q}`);
      }}
    >
      <span className="text-xs font-medium uppercase tracking-wide text-muted">Compare</span>
      <select className={field} value={a} onChange={(e) => setA(e.target.value)} aria-label="First model">
        <option value="">First model…</option>
        {models.map((m) => (
          <option key={m.name} value={m.name}>
            {label(m)}
          </option>
        ))}
      </select>
      <span className="text-xs text-muted">vs</span>
      <select className={field} value={effB} onChange={(e) => setB(e.target.value)} disabled={!ma} aria-label="Second model">
        <option value="">{ma ? `Second model (${candidates.length} share a capability)…` : 'Pick the first model'}</option>
        {candidates.map((m) => (
          <option key={m.name} value={m.name}>
            {label(m)} · {shared(ma!, m).join(', ')}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={!a || !effB}
        className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg disabled:opacity-40"
      >
        Compare →
      </button>
      {common.length > 0 && <span className="w-full text-[11px] text-muted">Shared capabilities: {common.join(', ')}</span>}
    </form>
  );
}
