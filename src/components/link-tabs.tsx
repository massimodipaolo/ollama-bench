import Link from 'next/link';

export interface LinkTab {
  id: string;
  label: string;
  href: string;
  /** small secondary text, e.g. a count */
  hint?: string;
  title?: string;
}

/**
 * URL-driven tabs (state lives in the query string, so views are linkable and work with the back button).
 * "segmented" = joined buttons for a mode switch; "chips" = separate pills for a choice among several.
 */
export function LinkTabs({
  items,
  current,
  label,
  variant = 'chips',
}: {
  items: LinkTab[];
  current: string;
  label: string;
  variant?: 'segmented' | 'chips';
}) {
  if (variant === 'segmented')
    return (
      <nav aria-label={label} className="inline-flex overflow-hidden rounded-md border border-line text-xs">
        {items.map((t) => (
          <Link
            key={t.id}
            href={t.href}
            title={t.title}
            aria-current={t.id === current ? 'page' : undefined}
            className={`border-l border-line px-3 py-1.5 first:border-l-0 ${
              t.id === current ? 'bg-accent font-medium text-accent-fg' : 'bg-panel text-muted hover:text-fg'
            }`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
    );
  return (
    <nav aria-label={label} className="flex flex-wrap gap-1.5 text-xs">
      {items.map((t) => (
        <Link
          key={t.id}
          href={t.href}
          title={t.title}
          aria-current={t.id === current ? 'page' : undefined}
          className={`rounded-full border px-3 py-1 ${t.id === current ? 'border-accent text-accent' : 'border-line text-muted hover:text-fg'}`}
        >
          {t.label}
          {t.hint && <span className="ml-1.5 tabular opacity-70">{t.hint}</span>}
        </Link>
      ))}
    </nav>
  );
}

/** Build a URL on basePath from params, dropping empty values. */
export function hrefWith(basePath: string, params: Record<string, string | undefined>) {
  const q = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1]));
  const s = q.toString();
  return s ? `${basePath}?${s}` : basePath;
}
