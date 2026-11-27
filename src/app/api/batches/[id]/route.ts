import { connection } from 'next/server';
import { getBatchDetail } from '@/lib/queries';

export async function GET(_req: Request, ctx: RouteContext<'/api/batches/[id]'>) {
  await connection();
  const { id } = await ctx.params;
  const batch = getBatchDetail(id);
  return batch ? Response.json(batch) : Response.json({ error: 'Batch not found' }, { status: 404 });
}
