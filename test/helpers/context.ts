/** The RunContext a benchmark test's run() receives, as the runner builds it, for tests that call run() directly. */
import { getLanguage } from '@/config/languages';
import type { SessionConfig } from '@/db/schema';
import type { RunContext } from '@/lib/tests/types';

export const testConfig: SessionConfig = { temperature: 0, seed: 42, numCtx: 8192, think: false, subset: 'quick', judges: [] };

export function runContext(over: Partial<RunContext> = {}) {
  const deltas: string[] = [];
  const ctx: RunContext = {
    provider: 'ollama',
    modelName: 'fake-model:7b',
    capabilities: ['completion', 'tools', 'vision'],
    lang: getLanguage('en'),
    config: testConfig,
    signal: new AbortController().signal,
    onDelta: (t) => deltas.push(t),
    ...over,
  };
  return { ctx, deltas };
}

/** A case by id from the test's fixtures. */
export function caseOf<C extends { id: string }>(cases: C[], id: string): C {
  const c = cases.find((x) => x.id === id);
  if (!c) throw new Error(`no case ${id} in the fixtures`);
  return c;
}
