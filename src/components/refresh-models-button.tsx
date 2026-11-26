'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

interface SyncResult {
  total: number;
  added: string[];
  updated: string[];
  error?: string;
}

/** Syncs the model list from the Ollama host, then re-renders the page. */
export function RefreshModelsButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);

  async function refresh() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/models/sync', { method: 'POST' });
      const r = (await res.json()) as SyncResult;
      if (!res.ok) throw new Error(r.error ?? `HTTP ${res.status}`);
      const parts = [`${r.total} models on the host`];
      if (r.added.length) parts.push(`new: ${r.added.join(', ')}`);
      if (r.updated.length) parts.push(`new digest: ${r.updated.join(', ')}`);
      if (!r.added.length && !r.updated.length) parts.push('no changes');
      setMsg({ text: parts.join(' · ') });
      startTransition(() => router.refresh());
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  }

  const working = busy || pending;
  return (
    <span className="flex items-center gap-3 text-xs">
      {msg && <span className={msg.bad ? 'text-bad' : 'text-muted'}>{msg.text}</span>}
      <button
        onClick={refresh}
        disabled={working}
        className="rounded-md border border-line px-2.5 py-1 hover:border-accent hover:text-accent disabled:opacity-50"
        title="Read the model list from the Ollama host and add new or re-pulled models"
      >
        {working ? 'Refreshing…' : '↻ Refresh model list'}
      </button>
    </span>
  );
}
