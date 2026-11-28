'use client';

import { setThemeChoice, useThemeChoice, type ThemeChoice } from '@/lib/theme';

const ICON = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const OPTIONS: { id: ThemeChoice; label: string; icon: React.ReactNode }[] = [
  {
    id: 'system',
    label: 'System',
    icon: (
      <svg {...ICON} aria-hidden="true">
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8M12 16v4" />
      </svg>
    ),
  },
  {
    id: 'light',
    label: 'Light',
    icon: (
      <svg {...ICON} aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    ),
  },
  {
    id: 'dark',
    label: 'Dark',
    icon: (
      <svg {...ICON} aria-hidden="true">
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </svg>
    ),
  },
];

/** System / Light / Dark, in the header. */
export function ThemeSwitch() {
  const choice = useThemeChoice();
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-line" role="radiogroup" aria-label="Theme">
      {OPTIONS.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={choice === o.id}
          aria-label={o.label}
          title={`${o.label} theme`}
          onClick={() => setThemeChoice(o.id)}
          className={`border-l border-line px-2 py-1.5 first:border-l-0 ${choice === o.id ? 'bg-code text-fg' : 'text-muted hover:text-fg'}`}
        >
          {o.icon}
        </button>
      ))}
    </div>
  );
}
