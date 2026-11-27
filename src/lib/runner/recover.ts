import { and, inArray, isNull, lt, or } from 'drizzle-orm';
import { getDb, schema } from '@/db';
import { docker } from '@/lib/tests/polyglot/sandbox';
import { LABEL, STALE_MS, serverInstance } from './instance';

/**
 * Sessions live in the memory of the server that runs them. When that server stops, its queued/running sessions can
 * never finish (and a batch containing one would look busy forever). At startup, mark those sessions (and their
 * unfinished runs) as interrupted, and remove the Docker containers that server left behind.
 *
 * Several servers may share the DB: only sessions of servers whose heartbeat stopped (or recorded without an owner,
 * by versions before ownership existed) are touched — never those of a live server.
 * Called once at server start (src/instrumentation.ts), never from CLI scripts.
 */
export async function recoverAbandoned(): Promise<{ sessions: number; containers: number }> {
  const db = getDb();
  const self = serverInstance();
  const cutoff = Date.now() - STALE_MS;
  const dead = db
    .select({ id: schema.serverInstances.id })
    .from(schema.serverInstances)
    .where(lt(schema.serverInstances.heartbeatAt, cutoff))
    .all()
    .map((r) => r.id)
    .filter((id) => id !== self);

  const ownerGone = dead.length
    ? or(isNull(schema.sessions.instanceId), inArray(schema.sessions.instanceId, dead))
    : isNull(schema.sessions.instanceId);
  const stale = db
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(and(inArray(schema.sessions.status, ['queued', 'running']), ownerGone))
    .all()
    .map((s) => s.id);
  if (stale.length) {
    const error = 'interrupted: the server stopped before this finished';
    const finishedAt = Date.now();
    db.update(schema.sessions).set({ status: 'error', error, finishedAt }).where(inArray(schema.sessions.id, stale)).run();
    db.update(schema.runs)
      .set({ status: 'error', error, finishedAt })
      .where(and(inArray(schema.runs.sessionId, stale), inArray(schema.runs.status, ['queued', 'running'])))
      .run();
  }

  // containers of dead servers (Polyglot sandboxes, Terminal-Bench task containers)
  let containers = 0;
  for (const id of dead) {
    const ps = await docker(['ps', '-aq', '--filter', `label=${LABEL}=${id}`], { timeoutMs: 30_000 });
    const ids = ps.code === 0 ? ps.out.split(/\s+/).filter(Boolean) : [];
    if (ids.length) await docker(['rm', '-f', ...ids], { timeoutMs: 120_000 });
    containers += ids.length;
  }
  if (dead.length) db.delete(schema.serverInstances).where(inArray(schema.serverInstances.id, dead)).run();
  return { sessions: stale.length, containers };
}
