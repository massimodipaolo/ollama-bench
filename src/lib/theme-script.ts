/**
 * Inline in <head> (layout.tsx): applies the saved theme (src/lib/theme.ts) as data-theme on <html> before anything
 * paints, so a forced light or dark theme never flashes. A plain module: the layout is a Server Component, and a value
 * imported from a 'use client' module would reach it as a client reference, not as this string.
 */
export const THEME_KEY = 'theme';

export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;
