import { connection, type NextRequest } from 'next/server';
import { promptMaterial } from '@/lib/prompt-preview';

/**
 * One file attached to a case's prompt (?case=…&i=n), served with its media type so images and PDFs open in the
 * browser; other types (DOCX, XLSX, CSV) download. Files come from the fixtures/datasets, never from user input.
 */
export async function GET(req: NextRequest, ctx: RouteContext<'/api/sessions/[id]/prompt/file'>) {
  await connection();
  const { id } = await ctx.params;
  const caseId = req.nextUrl.searchParams.get('case');
  const i = Number(req.nextUrl.searchParams.get('i') ?? 0);
  if (!caseId || !Number.isInteger(i) || i < 0) return Response.json({ error: 'expected ?case=…&i=n' }, { status: 400 });
  const p = await promptMaterial(id, caseId);
  if (!p.ok) return Response.json({ error: p.error }, { status: p.status });
  const a = p.material.attachments?.[i];
  if (!a) return Response.json({ error: 'No such attachment' }, { status: 404 });
  const bytes = a.data instanceof Uint8Array ? a.data : typeof a.data === 'string' ? Buffer.from(a.data, 'base64') : null;
  if (!bytes) return Response.json({ error: 'Attachment is not stored as bytes' }, { status: 500 });
  const name = (a.filename ?? `file-${i + 1}`).replace(/["\\\r\n]/g, '_');
  // inline only for types that can't run script on this origin (no SVG, no HTML); everything else downloads
  const inline = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/(plain|csv|markdown))$/.test(a.mediaType);
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': a.mediaType,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${name}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=300',
    },
  });
}
