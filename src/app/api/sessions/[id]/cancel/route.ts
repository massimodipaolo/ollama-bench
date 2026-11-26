import { cancelSession } from '@/lib/runner';

export async function POST(_req: Request, ctx: RouteContext<'/api/sessions/[id]/cancel'>) {
  const { id } = await ctx.params;
  cancelSession(id);
  return Response.json({ ok: true });
}
