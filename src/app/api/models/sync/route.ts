import { syncOllamaModels } from '@/lib/ollama';
import { ollamaBaseURL } from '@/lib/providers';

/** Refresh the model list from the Ollama host (POST: it writes to the DB). */
export async function POST() {
  try {
    return Response.json(await syncOllamaModels(ollamaBaseURL()));
  } catch (e) {
    return Response.json({ error: `Model sync failed (${ollamaBaseURL()}): ${(e as Error).message}` }, { status: 502 });
  }
}
