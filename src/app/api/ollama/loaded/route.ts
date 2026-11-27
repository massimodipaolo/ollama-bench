import { connection } from 'next/server';
import { loadedModels } from '@/lib/ollama';
import { modelsInUse } from '@/lib/runner/residency';

/** Models in the Ollama host's memory, flagged when a queued/running session of this server still needs them. */
export async function GET() {
  await connection();
  try {
    const inUse = modelsInUse();
    return Response.json((await loadedModels()).map((m) => ({ ...m, inUse: inUse.has(m.name) })));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
