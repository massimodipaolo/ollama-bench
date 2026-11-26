/** Model size tiers by parameter count (as reported by Ollama: "566.70M", "8.8B", "123.6B"; MoE = total params). */
export type Tier = 'all' | 'small' | 'medium' | 'large';

export const TIERS: { id: Tier; label: string }[] = [
  { id: 'all', label: 'All sizes' },
  { id: 'small', label: '< 10B' },
  { id: 'medium', label: '10–50B' },
  { id: 'large', label: '> 50B' },
];

export function parseTier(v: unknown): Tier {
  return TIERS.some((t) => t.id === v) ? (v as Tier) : 'all';
}

/** Parameter count in billions, or null when unknown (remote baselines). */
export function paramsB(size: string | null | undefined): number | null {
  const m = size?.trim().match(/^([\d.]+)\s*([KMBT])?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? 'B').toUpperCase();
  return unit === 'K' ? n / 1e6 : unit === 'M' ? n / 1e3 : unit === 'T' ? n * 1e3 : n;
}

export function tierOf(size: string | null | undefined): Exclude<Tier, 'all'> | null {
  const b = paramsB(size);
  if (b == null) return null;
  return b < 10 ? 'small' : b <= 50 ? 'medium' : 'large';
}

/** Models of unknown size (remote baselines such as Cohere) stay visible in every tier as a reference. */
export function inTier(size: string | null | undefined, tier: Tier): boolean {
  if (tier === 'all') return true;
  const t = tierOf(size);
  return t === null || t === tier;
}
