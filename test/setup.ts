/**
 * Runs before every test file (vitest.config.mts setupFiles), in that file's own process:
 * - a fresh temporary database (migrations applied on first use), removed afterwards;
 * - no judge or baseline API keys, and Ollama pointed at a port nothing listens on: no test can spend money or reach
 *   a real model by accident. A test that needs a provider fakes it explicitly.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, vi } from 'vitest';

// Route handlers call connection() to opt out of prerendering; outside a Next request it throws. Tests call handlers
// directly, so it's a no-op here; everything else in next/server (NextRequest, NextResponse…) stays real.
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  connection: async () => {},
}));

const dir = mkdtempSync(join(tmpdir(), 'ollama-bench-test-'));
process.env.BENCH_DB_PATH = join(dir, 'bench.db');

for (const k of [
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GOOGLE_MODEL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'COHERE_API_KEY',
  'COHERE_MODEL',
  'OLLAMA_API_KEY',
])
  delete process.env[k];
process.env.OLLAMA_HOST = 'http://127.0.0.1:9'; // discard port: connections are refused at once

afterAll(() => {
  // close the database before removing it (Windows can't delete an open file)
  const g = globalThis as unknown as { __benchDb?: { $client?: { close(): void } } };
  g.__benchDb?.$client?.close();
  delete g.__benchDb;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // a leftover temp dir is harmless
  }
});
