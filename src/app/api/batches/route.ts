import { z } from 'zod';
import { startBatch } from '@/lib/runner/batch';

const body = z.object({
  capability: z.string(),
  testIds: z.array(z.string()).min(1),
  lang: z.string(),
  models: z.array(z.string()).min(1).max(2),
  config: z
    .object({
      temperature: z.number().min(0).max(2).optional(),
      seed: z.number().int().optional(),
      numCtx: z.number().int().min(512).max(1_048_576).optional(),
      think: z.boolean().optional(),
      subset: z.enum(['quick', 'full']).optional(),
      judges: z.array(z.string()).optional(),
    })
    .default({}),
});

/** Start a capability batch: one session per test, run in order. Returns the batch id and its session ids. */
export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  try {
    return Response.json(await startBatch(parsed.data));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
