import { z } from 'zod';
import { listOllamaModels, unload } from '@/lib/ollama';
import { modelsInUse } from '@/lib/runner/residency';

const body = z.object({ model: z.string().min(1) });

/** Free a model from the Ollama host's memory now. Refused while a session of this server needs it. */
export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'expected { model }' }, { status: 400 });
  const { model } = parsed.data;
  if (modelsInUse().has(model)) return Response.json({ error: `${model} is in use by a queued or running session` }, { status: 409 });
  // embedding-only models can't be unloaded through /api/generate
  const info = (await listOllamaModels().catch(() => [])).find((m) => m.name === model);
  const embedding = !!info && info.capabilities.includes('embedding') && !info.capabilities.includes('completion');
  await unload(model, embedding);
  return Response.json({ ok: true });
}
