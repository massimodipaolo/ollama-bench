import 'server-only';
import { readInstalledVersions } from './sdk-versions';

export { TRACKED_PACKAGES } from './sdk-versions';

/**
 * Versions read when the app was built (next.config.ts `env`). The standalone server (Docker image) has no
 * package.json for these libraries: Turbopack compiles them into the server code.
 */
const BUILT_WITH: Record<string, string> = (() => {
  try {
    return JSON.parse(process.env.BENCH_BUILD_SDK_VERSIONS ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
})();

/**
 * The SDK versions the server runs: what node_modules holds now (dev server, `next start`: always current, even after
 * an update without a rebuild), else what it was built with (standalone).
 */
export function sdkVersions(): Record<string, string> {
  return { ...BUILT_WITH, ...readInstalledVersions(process.cwd()) };
}

/** Compact label for tables: "ai 7.0.183 · ai-sdk-ollama 4.6.3". */
export function sdkLabel(v: Record<string, string> | undefined): string {
  if (!v) return '';
  return ['ai', 'ai-sdk-ollama']
    .filter((k) => v[k])
    .map((k) => `${k} ${v[k]}`)
    .join(' · ');
}
