import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@/db';

/**
 * This server process's identity. Several app servers can share the DB (a dev server on :3000 and another on :3311,
 * or a production server next to a dev one); each heartbeats, so a starting server only recovers sessions whose
 * owner stopped. Containers started for this server's sessions carry LABEL, so leftovers can be removed too.
 */
export const HEARTBEAT_MS = 20_000;
/** an owner silent for this long is considered gone */
export const STALE_MS = 90_000;
export const LABEL = 'ollama-bench.instance';

const g = globalThis as unknown as { __benchInstance?: { id: string; timer: NodeJS.Timeout } };

/** Register this process (once; survives HMR) and keep its heartbeat going. */
export function serverInstance(): string {
  if (g.__benchInstance) return g.__benchInstance.id;
  const id = crypto.randomUUID();
  const db = getDb();
  db.insert(schema.serverInstances).values({ id, pid: process.pid, startedAt: Date.now(), heartbeatAt: Date.now() }).run();
  const timer = setInterval(() => {
    try {
      db.update(schema.serverInstances).set({ heartbeatAt: Date.now() }).where(eq(schema.serverInstances.id, id)).run();
    } catch (e) {
      console.error('[bench] heartbeat failed', e);
    }
  }, HEARTBEAT_MS);
  timer.unref();
  g.__benchInstance = { id, timer };
  return id;
}

/** docker run arguments that tag a container as belonging to this server. */
export const containerLabel = () => ['--label', `${LABEL}=${serverInstance()}`];
