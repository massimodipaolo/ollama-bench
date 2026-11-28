/**
 * Writes rows straight into the test database, shaped as the runner writes them, for tests of the queries behind
 * the pages: exact scores, suite versions, statuses and timings, without running anything.
 */
import crypto from 'node:crypto';
import { getDb, schema } from '@/db';
import type { SessionConfig } from '@/db/schema';
import { listTests } from '@/lib/tests/registry';

let suites: Map<string, string> | undefined;
/** The test's current suite version: results with another one are stale. */
export async function currentSuite(testId: string): Promise<string> {
  suites ??= new Map((await listTests()).map((t) => [t.id, t.suiteVersion]));
  return suites.get(testId) ?? 'unknown-test';
}

export function seedModel(
  name: string,
  o: { capabilities?: string[]; parameterSize?: string; digest?: string; provider?: 'ollama' | 'cohere'; lastSeen?: number } = {},
): number {
  return getDb()
    .insert(schema.models)
    .values({
      provider: o.provider ?? 'ollama',
      name,
      digest: o.digest ?? `sha256:${crypto.createHash('sha1').update(name).digest('hex')}`,
      family: 'llama',
      parameterSize: o.parameterSize ?? '8B',
      quantization: 'Q4_K_M',
      contextLength: 32768,
      capabilities: o.capabilities ?? ['completion'],
      ...(o.lastSeen ? { lastSeen: o.lastSeen } : {}),
    })
    .returning({ id: schema.models.id })
    .get().id;
}

export interface SeedRun {
  modelId: number;
  testId: string;
  /** default: the test's current suite version */
  suiteVersion?: string;
  lang?: string;
  /** session creation time (the run's date in history) */
  at: number;
  status?: 'done' | 'error' | 'running' | 'queued';
  sessionStatus?: 'done' | 'error' | 'running' | 'queued' | 'cancelled';
  role?: 'candidate' | 'baseline';
  judgeAvg?: number | null;
  autoScore?: number | null;
  judgeScores?: Record<string, number | null>;
  avgTokPerSec?: number | null;
  config?: Partial<SessionConfig>;
  startedAt?: number | null;
  finishedAt?: number | null;
  loadMs?: number | null;
  execMs?: number | null;
  /** case results: their execution times (null = recorded before cases were timed) */
  cases?: (number | null)[];
  /** the fixture case ids of those results (default case-0, case-1…): real ids when the test's cases are read back */
  caseIds?: string[];
  batchId?: string;
  sessionId?: string;
}

/** One session with one run (or one more run in an existing session). */
export function seedRun(r: SeedRun & { suiteVersion: string }): { sessionId: string; runId: number; caseIds: number[] } {
  const db = getDb();
  const sessionId = r.sessionId ?? crypto.randomUUID();
  if (!r.sessionId)
    db.insert(schema.sessions)
      .values({
        id: sessionId,
        testId: r.testId,
        suiteVersion: r.suiteVersion,
        lang: r.lang ?? 'en',
        config: { temperature: 0, seed: 42, numCtx: 8192, think: false, subset: 'quick', judges: [], extra: {}, ...r.config },
        status: r.sessionStatus ?? (r.status === 'running' || r.status === 'queued' ? r.status : 'done'),
        createdAt: r.at,
        finishedAt: r.status === 'running' || r.status === 'queued' ? null : (r.finishedAt ?? r.at + 60_000),
        batchId: r.batchId,
      })
      .run();
  const runId = db
    .insert(schema.runs)
    .values({
      sessionId,
      modelId: r.modelId,
      role: r.role ?? 'candidate',
      blindLabel: 'A',
      status: r.status ?? 'done',
      judgeAvg: r.judgeAvg ?? null,
      autoScore: r.autoScore ?? null,
      judgeScores: r.judgeScores ?? null,
      avgTokPerSec: r.avgTokPerSec ?? null,
      startedAt: r.startedAt === undefined ? r.at : r.startedAt,
      finishedAt: r.finishedAt === undefined ? r.at + 60_000 : r.finishedAt,
      loadMs: r.loadMs ?? null,
      execMs: r.execMs ?? null,
    })
    .returning({ id: schema.runs.id })
    .get().id;
  const caseIds = (r.cases ?? []).map(
    (execMs, i) =>
      db
        .insert(schema.caseResults)
        .values({ runId, caseId: r.caseIds?.[i] ?? `case-${i}`, output: 'ok', execMs, autoScore: 5, checks: [] })
        .returning({ id: schema.caseResults.id })
        .get().id,
  );
  return { sessionId, runId, caseIds };
}

export function seedBatch(id: string, capability = 'text') {
  getDb().insert(schema.batches).values({ id, capability, lang: 'en', models: [], testIds: [], config: {} }).run();
}
