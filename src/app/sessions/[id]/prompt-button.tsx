'use client';

import { useRef, useState } from 'react';

interface PromptInfo {
  title: string;
  task: string;
  input: string;
  reference: string | null;
  attachments: { name: string; mediaType: string; bytes: number | null; url: string }[];
  note?: string;
  error?: string;
}

const kb = (n: number | null) => (n == null ? '' : n < 1024 ? `${n} B` : `${(n / 1024).toFixed(0)} KB`);

/** "Prompt" button on a case card: opens an overlay with what the case gave the model (loaded on first open). */
export function PromptButton({ sessionId, caseId }: { sessionId: string; caseId: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [info, setInfo] = useState<PromptInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  async function open() {
    dialog.current?.showModal();
    if (info && !info.error) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/prompt?case=${encodeURIComponent(caseId)}`);
      const data = (await res.json()) as PromptInfo;
      setInfo(res.ok ? data : { ...data, error: data.error ?? `HTTP ${res.status}` });
    } catch (e) {
      setInfo({ title: caseId, task: '', input: '', reference: null, attachments: [], error: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }

  async function copy() {
    if (!info) return;
    await navigator.clipboard.writeText(info.input);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <>
      <button
        type="button"
        onClick={open}
        className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-xs font-normal text-muted hover:border-accent hover:text-accent"
        title="Show the prompt this case gave the model"
        aria-haspopup="dialog"
      >
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" strokeLinejoin="round" />
          <path d="M5 6.25h6M5 8.25h4" strokeLinecap="round" />
        </svg>
        Prompt
      </button>
      <dialog
        ref={dialog}
        // click on the backdrop (the dialog element itself, outside its content box) closes it
        onClick={(e) => e.target === dialog.current && dialog.current?.close()}
        className="m-auto w-[min(56rem,calc(100vw-2rem))] max-h-[85vh] rounded-lg border border-line bg-panel p-0 text-fg backdrop:bg-black/50"
      >
        <div className="flex max-h-[85vh] flex-col">
          <header className="flex items-start gap-3 border-b border-line px-4 py-3">
            <div className="min-w-0">
              <h2 className="font-semibold">{info?.title ?? caseId}</h2>
              <p className="font-mono text-xs text-muted">{caseId}</p>
            </div>
            <button
              type="button"
              onClick={() => dialog.current?.close()}
              className="ml-auto rounded-md px-2 py-0.5 text-muted hover:bg-code hover:text-fg"
              aria-label="Close"
            >
              ✕
            </button>
          </header>
          <div className="space-y-4 overflow-y-auto px-4 py-3 text-sm">
            {loading && <p className="text-muted">Loading…</p>}
            {info?.error && <p className="text-bad">{info.error}</p>}
            {info && !info.error && (
              <>
                {info.note && <p className="text-xs text-mid">{info.note}</p>}
                <div>
                  <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Task</h3>
                  <p>{info.task}</p>
                </div>
                <div>
                  <div className="mb-1 flex items-center gap-2">
                    <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Input given to the model</h3>
                    <button
                      type="button"
                      onClick={copy}
                      className="ml-auto rounded border border-line px-1.5 py-0.5 text-[11px] text-muted hover:text-fg"
                    >
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <pre className="max-h-[45vh] overflow-auto whitespace-pre-wrap rounded-md bg-code p-3 font-mono text-xs leading-relaxed">
                    {info.input}
                  </pre>
                </div>
                {info.attachments.length > 0 && (
                  <div>
                    <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Attached files</h3>
                    <ul className="space-y-0.5 text-xs">
                      {info.attachments.map((a, i) => (
                        <li key={i}>
                          <a
                            href={a.url}
                            target="_blank"
                            rel="noopener"
                            className="font-mono text-accent underline underline-offset-2 hover:no-underline"
                          >
                            {a.name}
                          </a>{' '}
                          <span className="text-muted">{[a.mediaType, kb(a.bytes)].filter(Boolean).join(' · ')}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {info.reference && (
                  <details>
                    <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide text-muted">
                      Reference (judges only, never shown to the model)
                    </summary>
                    <pre className="mt-1 max-h-[30vh] overflow-auto whitespace-pre-wrap rounded-md bg-code p-3 font-mono text-xs">
                      {info.reference}
                    </pre>
                  </details>
                )}
              </>
            )}
          </div>
        </div>
      </dialog>
    </>
  );
}
