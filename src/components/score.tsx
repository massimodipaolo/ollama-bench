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

export function fmtNum(n: number | null | undefined, digits = 1) {
  return n == null ? '–' : n.toFixed(digits);
}
