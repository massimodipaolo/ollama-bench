/** Helpers for tests that run sessions against the fake Ollama (test/helpers/fake-ollama.ts). */
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@/db';

/** A model as the fake host lists it in /api/tags. */
export function fakeModel(name: string, capabilities = ['completion', 'tools'], contextLength = 32768) {
  return {
    name,
    digest: `sha256:${name.replace(/\W/g, '')}`,
    size: 4_000_000_000,
    modified_at: '2026-11-01T00:00:00Z',
    details: { family: 'llama', parameter_size: '7.6B', quantization_level: 'Q4_K_M', context_length: contextLength },
    capabilities,
  };
}

/** Waits until a session has finished (the runner works in the background after it starts) and returns its row. */
export async function sessionFinished(id: string, timeoutMs = 15_000) {
  const t0 = Date.now();
  for (;;) {
    const s = getDb().select().from(schema.sessions).where(eq(schema.sessions.id, id)).get();
    if (s && s.status !== 'queued' && s.status !== 'running') return s;
    if (Date.now() - t0 > timeoutMs) throw new Error(`session ${id} still ${s?.status ?? 'missing'} after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The arguments Next passes a route handler: the request and the dynamic params. */
export const routeParams = <P extends Record<string, string>>(params: P) => ({ params: Promise.resolve(params) }) as never;
