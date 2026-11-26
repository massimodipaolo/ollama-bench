import { rejudgeSession } from '@/lib/runner';
import { getLive } from '@/lib/runner/events';

/**
 * Starts re-judging in the background; follow progress on /api/sessions/[id]/events.
 * Body (optional): { judges?: string[]; caseResultIds?: number[] }: omit both to re-judge the whole session; pass
 * them to replace only those judges' verdicts on those cases (e.g. one broken judgment).
 */
export async function POST(req: Request, ctx: RouteContext<'/api/sessions/[id]/rejudge'>) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { judges?: string[]; caseResultIds?: number[] };
  const live = getLive(id);
  if (live && !live.done) return Response.json({ error: 'Session is still running' }, { status: 409 });
  const ids = Array.isArray(body.caseResultIds) ? body.caseResultIds.filter((n) => Number.isInteger(n)) : undefined;
  void rejudgeSession(id, body.judges, ids).catch((e) => console.error('[rejudge]', id, e));
  return Response.json({ ok: true });
}
