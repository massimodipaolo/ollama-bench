import { connection } from 'next/server';
import { getSessionDetail } from '@/lib/queries';
import { getLive } from '@/lib/runner/events';
import { getTest } from '@/lib/tests/registry';
import { judges } from '@/lib/providers';

export async function GET(_req: Request, ctx: RouteContext<'/api/sessions/[id]'>) {
  const { id } = await ctx.params;
  await connection();
  const s = getSessionDetail(id);
  if (!s) return Response.json({ error: 'not found' }, { status: 404 });
  const live = getLive(id);
  let testName = s.testId;
  let cases: { id: string; title: string }[] = [];
  try {
    const t = getTest(s.testId);
    testName = t.name;
    cases = t.loadCases(s.lang).map((c) => ({ id: c.id, title: c.title }));
  } catch {}
  return Response.json({
    ...s,
    testName,
    cases,
    judges: judges().map(({ id, label, modelId }) => ({ id, label, modelId })),
    live: !!live && !live.done,
  });
}
