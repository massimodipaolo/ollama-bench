import { cancelBatch } from '@/lib/runner/batch';

export async function POST(_req: Request, ctx: RouteContext<'/api/batches/[id]/cancel'>) {
  const { id } = await ctx.params;
  cancelBatch(id);
  return Response.json({ ok: true });
}
