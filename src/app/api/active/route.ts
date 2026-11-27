import { connection } from 'next/server';
import { activeSessions } from '@/lib/queries';

/** Sessions queued or running right now, oldest first (the order they get the GPU). */
export async function GET() {
  await connection();
  return Response.json(activeSessions());
}
