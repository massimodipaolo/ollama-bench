import { connection } from 'next/server';
import { cachedHostContext, detectHostContext } from '@/lib/ollama';

/** GET: last detected host default context (null if never detected). POST: detect now (loads a small model briefly). */
export async function GET() {
  await connection();
  return Response.json(cachedHostContext());
}

export async function POST() {
  try {
    return Response.json(await detectHostContext());
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
