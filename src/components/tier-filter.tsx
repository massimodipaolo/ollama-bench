import Link from 'next/link';
import { TIERS, type Tier } from '@/lib/tiers';

/** Size-tier links; keeps the page's other query params (e.g. lang). */
export function TierFilter({ basePath, current, params = {} }: { basePath: string; current: Tier; params?: Record<string, string> }) {
  const href = (tier: Tier) => {
    const q = new URLSearchParams({ ...params, ...(tier === 'all' ? {} : { tier }) });
    const s = q.toString();
    return s ? `${basePath}?${s}` : basePath;
  };
  return (
    <nav className="flex gap-1 text-xs" aria-label="Model size">
      {TIERS.map((t) => (
        <Link
          key={t.id}
          href={href(t.id)}
          aria-current={t.id === current ? 'page' : undefined}
          className={`rounded-md border px-3 py-1 ${t.id === current ? 'border-accent text-accent' : 'border-line text-muted hover:text-fg'}`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
