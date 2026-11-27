import { connection, type NextRequest } from 'next/server';
import { promptMaterial } from '@/lib/prompt-preview';

/**
 * What a case gave the model, fetched on demand by the session page's "Prompt" button: the task, the input (system
 * prompt, tools, user message, passages…), attached files (served by ./file) and the reference the judges see.
 */
export async function GET(req: NextRequest, ctx: RouteContext<'/api/sessions/[id]/prompt'>) {
  await connection();
  const { id } = await ctx.params;
  const caseId = req.nextUrl.searchParams.get('case');
  if (!caseId) return Response.json({ error: 'missing ?case=' }, { status: 400 });
  const p = await promptMaterial(id, caseId);
  if (!p.ok) return Response.json({ error: p.error }, { status: p.status });
  const m = p.material;
  return Response.json({
    title: p.title,
    task: m.task,
    input: m.input,
    reference: m.reference ?? null,
    attachments: (m.attachments ?? []).map((a, i) => ({
      name: a.filename ?? `file-${i + 1}`,
      mediaType: a.mediaType,
      bytes: a.data instanceof Uint8Array ? a.data.byteLength : null,
      url: `/api/sessions/${id}/prompt/file?case=${encodeURIComponent(caseId)}&i=${i}`,
    })),
    note: p.note,
  });
}
