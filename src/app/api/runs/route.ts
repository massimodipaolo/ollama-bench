import { connection, type NextRequest } from 'next/server';
import { runRows } from '@/lib/queries';

/** Run history as JSON (used by the CLI for --skip-existing). Filters: ?testId=…&model=… */
export async function GET(req: NextRequest) {
  await connection();
  const p = req.nextUrl.searchParams;
  return Response.json(runRows({ testId: p.get('testId') ?? undefined, model: p.get('model') ?? undefined }));
}
