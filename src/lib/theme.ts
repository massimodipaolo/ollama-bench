'use client';

import { useSyncExternalStore } from 'react';
import { THEME_KEY as KEY } from './theme-script';

/**
 * Theme choice: 'system' follows the OS; 'light' / 'dark' force one. Saved in localStorage and applied as
 * data-theme on <html> (globals.css resolves every color from it); THEME_SCRIPT (theme-script.ts) applies it before
 * the first paint.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';

const EVENT = 'themechange';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function readChoice(): ThemeChoice {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system'; // storage blocked (private mode, site data disabled)
  }
}

export function setThemeChoice(choice: ThemeChoice) {
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {}
  if (choice === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', choice);
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(onChange: () => void) {
  const media = window.matchMedia(DARK_QUERY);
  window.addEventListener(EVENT, onChange);
  window.addEventListener('storage', onChange); // another tab changed it
  media.addEventListener('change', onChange); // the OS switched, for 'system'
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener('storage', onChange);
    media.removeEventListener('change', onChange);
  };
}

/** The saved choice ('system' on the server and during hydration). */
export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(subscribe, readChoice, () => 'system');
}

/** The theme actually shown, for things drawn outside CSS (e.g. Mermaid's SVG). */
export function useResolvedTheme(): 'light' | 'dark' {
  return useSyncExternalStore(
    subscribe,
    () => {
      const choice = readChoice();
      return choice === 'system' ? (window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light') : choice;
    },
    () => 'light',
  );
}
