export const JUDGE_ORDER = ['openai', 'google', 'anthropic'] as const;
export const JUDGE_LABEL: Record<string, string> = { openai: 'OpenAI', google: 'Google', anthropic: 'Anthropic' };

export function scoreColor(s: number | null | undefined) {
  if (s == null) return 'text-muted';
  if (s >= 7.5) return 'text-good';
  if (s >= 5) return 'text-mid';
  return 'text-bad';
}

export function Score({ value, className = '', title }: { value: number | null | undefined; className?: string; title?: string }) {
  return (
    <span title={title} className={`tabular font-semibold ${scoreColor(value)} ${className}`}>
      {value == null ? '–' : value.toFixed(1)}
    </span>
  );
}

export function fmtMs(ms: number | null | undefined) {
  if (ms == null) return '–';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Execution times, from milliseconds to hours: 850 ms · 12.3 s · 4m 05s · 2h 03m */
export function fmtDuration(ms: number | null | undefined) {
  if (ms == null) return '–';
  if (ms < 60_000) return fmtMs(ms);
  const s = Math.round(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return s < 3600 ? `${Math.floor(s / 60)}m ${pad(s % 60)}s` : `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
}

export function fmtNum(n: number | null | undefined, digits = 1) {
  return n == null ? '–' : n.toFixed(digits);
}

/** Background for a 0-10 score cell: one hue (accent), light to dark with the score; the number stays in text ink. */
export const heat = (score: number | null | undefined) =>
  score == null
    ? undefined
    : { backgroundColor: `color-mix(in oklab, var(--accent) ${Math.round(Math.max(0, Math.min(10, score)) * 3)}%, transparent)` };
