import { z } from 'zod';
import { startSession } from '@/lib/runner';
import { recentSessions } from '@/lib/queries';
import { connection, type NextRequest } from 'next/server';

const body = z.object({
  testId: z.string(),
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
      extra: z.record(z.string(), z.string()).optional(),
    })
    .default({}),
  includeBaselines: z.boolean().optional(),
});

export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  try {
    const id = await startSession(parsed.data);
    return Response.json({ id });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function GET(req: NextRequest) {
  await connection();
  const testId = req.nextUrl.searchParams.get('testId') ?? undefined;
  return Response.json(recentSessions(50, testId));
}
