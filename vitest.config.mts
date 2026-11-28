import path from 'node:path';
import { defineConfig } from 'vitest/config';

const root = import.meta.dirname;

/**
 * Unit and integration tests (test/, mirroring src/). See scripts/README.md "Tests".
 *   pnpm test            the suite, once
 *   pnpm test:watch      re-runs on change
 *   pnpm test:coverage   + coverage report in .data/coverage/ (index.html)
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.join(root, 'src'),
      // the real package throws outside React Server Components: tests import server modules directly
      'server-only': path.join(root, 'test', 'stubs', 'server-only.ts'),
    },
  },
  test: {
    // .tsx: component tests, which choose the jsdom environment in their first line (// @vitest-environment jsdom)
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'node',
    // per test file: its own temporary database, no judge keys, Ollama pointed nowhere (test/setup.ts)
    setupFiles: ['test/setup.ts'],
    // every file runs in a fresh process: the DB, Mermaid and corpus singletons live on globalThis
    pool: 'forks',
    isolate: true,
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reportsDirectory: '.data/coverage',
      reporter: ['text-summary', 'html', 'json-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts'],
      // a ratchet: the run fails if coverage drops below these, and autoUpdate raises them when it grows
      thresholds: { statements: 74.14, branches: 60.74, functions: 66.25, lines: 75.84, autoUpdate: true },
    },
  },
});
