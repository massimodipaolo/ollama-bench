import 'server-only';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '@/db';
import type { SessionConfig } from '@/db/schema';
import { getCapability } from '@/config/capabilities';
import { cancelSession, startSession } from './index';

export interface StartBatchInput {
  capability: string;
  testIds: string[];
  lang: string;
  models: string[];
  /** shared config; test options stay at each test's defaults so results count toward the capability score */
  config: Partial<Omit<SessionConfig, 'extra'>>;
}

/**
 * Creates the batch and one session per test, in the order given. Each session takes the GPU lock when it starts
 * executing, and the lock is first come, first served, so the sessions run one after another in this order.
 * Validation (eligibility, models on the host) happens per session; the first failure aborts the remaining ones.
 */
export async function startBatch(input: StartBatchInput): Promise<{ id: string; sessions: string[] }> {
  const cap = getCapability(input.capability);
  if (!cap) throw new Error(`Unknown capability: ${input.capability}`);
  const testIds = [...new Set(input.testIds)];
  const unknown = testIds.filter((t) => !cap.tests.includes(t));
  if (!testIds.length) throw new Error('Select at least one test');
  if (unknown.length) throw new Error(`Not part of ${cap.label}: ${unknown.join(', ')}`);
  const testOrder = cap.tests.filter((t) => testIds.includes(t));

  const db = getDb();
  const id = crypto.randomUUID();
  db.insert(schema.batches)
    .values({ id, capability: cap.id, lang: input.lang, models: input.models, testIds: testOrder, config: input.config })
    .run();

  const sessions: string[] = [];
  try {
    for (const testId of testOrder) {
      sessions.push(await startSession({ testId, lang: input.lang, models: input.models, config: input.config, batchId: id }));
    }
  } catch (e) {
    // nothing half-started: cancel what was queued and drop the batch if it has no session at all
    for (const s of sessions) cancelSession(s);
    if (!sessions.length) db.delete(schema.batches).where(eq(schema.batches.id, id)).run();
    throw e;
  }
  return { id, sessions };
}

/** Cancel every session of the batch that has not finished yet (queued ones end as cancelled when they get the lock). */
export function cancelBatch(batchId: string) {
  const db = getDb();
  const ss = db.select().from(schema.sessions).where(eq(schema.sessions.batchId, batchId)).all();
  for (const s of ss) if (s.status === 'queued' || s.status === 'running') cancelSession(s.id);
}
