import 'server-only';
import { desc, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from '@/db';
import type { CaseResult, Judgment, Model, Run, Session } from '@/db/schema';
import { sessionVariant } from '@/lib/tests/registry';
import { sdkLabel } from '@/lib/versions';

export interface RunDetail extends Run {
  model: Model;
  cases: (CaseResult & { judgments: Judgment[] })[];
}
export interface SessionDetail extends Session {
  runs: RunDetail[];
}

export function getSessionDetail(id: string): SessionDetail | null {
  const db = getDb();
  const session = db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get();
  if (!session) return null;
  const runs = db
    .select({ run: schema.runs, model: schema.models })
    .from(schema.runs)
    .innerJoin(schema.models, eq(schema.runs.modelId, schema.models.id))
    .where(eq(schema.runs.sessionId, id))
    .orderBy(schema.runs.id)
    .all();
  const runIds = runs.map((r) => r.run.id);
  const crs = runIds.length
    ? db.select().from(schema.caseResults).where(inArray(schema.caseResults.runId, runIds)).orderBy(schema.caseResults.id).all()
    : [];
  const js = crs.length
    ? db
        .select()
        .from(schema.judgments)
        .where(
          inArray(
            schema.judgments.caseResultId,
            crs.map((c) => c.id),
          ),
        )
        .all()
    : [];
  return {
    ...session,
    runs: runs.map(({ run, model }) => ({
      ...run,
      model,
      cases: crs.filter((c) => c.runId === run.id).map((c) => ({ ...c, judgments: js.filter((j) => j.caseResultId === c.id) })),
    })),
  };
}

export interface SessionListItem {
  id: string;
  testId: string;
  lang: string;
  status: Session['status'];
  createdAt: number;
  subset: string;
  variant: string;
  runs: { model: string; judgeAvg: number | null; autoScore: number | null; avgTokPerSec: number | null }[];
}

export function recentSessions(limit = 20, testId?: string): SessionListItem[] {
  const db = getDb();
  const q = db.select().from(schema.sessions);
  const sessions = (testId ? q.where(eq(schema.sessions.testId, testId)) : q).orderBy(desc(schema.sessions.createdAt)).limit(limit).all();
  if (!sessions.length) return [];
  const runs = db
    .select({ run: schema.runs, model: schema.models })
    .from(schema.runs)
    .innerJoin(schema.models, eq(schema.runs.modelId, schema.models.id))
    .where(
      inArray(
        schema.runs.sessionId,
        sessions.map((s) => s.id),
      ),
    )
    .orderBy(schema.runs.id)
    .all();
  return sessions.map((s) => ({
    id: s.id,
    testId: s.testId,
    lang: s.lang,
    status: s.status,
    createdAt: s.createdAt,
    subset: s.config.subset,
    variant: sessionVariant(s.testId, s.config),
    runs: runs
      .filter((r) => r.run.sessionId === s.id)
      .map((r) => ({ model: r.model.name, judgeAvg: r.run.judgeAvg, autoScore: r.run.autoScore, avgTokPerSec: r.run.avgTokPerSec })),
  }));
}

export interface LeaderboardRow {
  modelId: number;
  lang: string;
  variant: string;
  model: string;
  provider: string;
  digest: string;
  quantization: string | null;
  parameterSize: string | null;
  runs: number;
  lastRunAt: number;
  judgeScores: Record<string, number | null>;
  judgeAvg: number | null;
  autoScore: number | null;
  avgTokPerSec: number | null;
  avgLatencyMs: number | null;
}

/** Latest completed run per (model digest, language) for a test: what the model scores *now*. */
export function leaderboard(testId: string, lang?: string): LeaderboardRow[] {
  const db = getDb();
  const rows = db
    .select({ run: schema.runs, model: schema.models, session: schema.sessions })
    .from(schema.runs)
    .innerJoin(schema.sessions, eq(schema.runs.sessionId, schema.sessions.id))
    .innerJoin(schema.models, eq(schema.runs.modelId, schema.models.id))
    .where(eq(schema.sessions.testId, testId))
    .orderBy(desc(schema.runs.id))
    .all()
    .filter((r) => r.run.status === 'done' && (!lang || r.session.lang === lang));

  // prefer the latest run that was judged; a later unjudged quick run should not blank the scores
  rows.sort((a, b) => Number(b.run.judgeAvg != null) - Number(a.run.judgeAvg != null) || b.run.id - a.run.id);
  const byModel = new Map<string, LeaderboardRow>();
  for (const { run, model, session } of rows) {
    const variant = sessionVariant(session.testId, session.config);
    const key = `${model.id}|${session.lang}|${variant}`;
    const existing = byModel.get(key);
    if (existing) {
      existing.runs++;
      continue;
    }
    byModel.set(key, {
      modelId: model.id,
      lang: session.lang,
      variant,
      model: model.name,
      provider: model.provider,
      digest: model.digest.slice(0, 12),
      quantization: model.quantization,
      parameterSize: model.parameterSize,
      runs: 1,
      lastRunAt: run.finishedAt ?? 0,
      judgeScores: run.judgeScores ?? {},
      judgeAvg: run.judgeAvg,
      autoScore: run.autoScore,
      avgTokPerSec: run.avgTokPerSec,
      avgLatencyMs: run.avgLatencyMs,
    });
  }
  return [...byModel.values()].sort(
    (a, b) => a.lang.localeCompare(b.lang) || (b.judgeAvg ?? b.autoScore ?? -1) - (a.judgeAvg ?? a.autoScore ?? -1),
  );
}

export interface RunRow {
  runId: number;
  sessionId: string;
  date: number;
  testId: string;
  lang: string;
  variant: string;
  subset: string;
  think: boolean;
  suiteVersion: string;
  modelId: number;
  model: string;
  provider: string;
  digest: string;
  quantization: string | null;
  parameterSize: string | null;
  role: string;
  status: string;
  judgeScores: Record<string, number | null>;
  judgeAvg: number | null;
  autoScore: number | null;
  avgLatencyMs: number | null;
  avgTtftMs: number | null;
  avgTokPerSec: number | null;
  loadMs: number | null;
  stats: Record<string, number | string> | null;
  ollamaVersion: string | null;
  sdk: Record<string, string>;
  /** "ai 7.0.183 · ai-sdk-ollama 4.6.3" ('' for sessions recorded before versions were tracked) */
  sdkLabel: string;
}

/** Every run (oldest first), optionally for one test and/or one model name (all digests). */
export function runRows(filter: { testId?: string; model?: string; includeUnfinished?: boolean } = {}): RunRow[] {
  const db = getDb();
  return db
    .select({ run: schema.runs, model: schema.models, session: schema.sessions })
    .from(schema.runs)
    .innerJoin(schema.sessions, eq(schema.runs.sessionId, schema.sessions.id))
    .innerJoin(schema.models, eq(schema.runs.modelId, schema.models.id))
    .orderBy(schema.sessions.createdAt, schema.runs.id)
    .all()
    .filter(
      (r) =>
        (!filter.testId || r.session.testId === filter.testId) &&
        (!filter.model || r.model.name === filter.model) &&
        (filter.includeUnfinished || r.run.status === 'done'),
    )
    .map(({ run, model, session }) => ({
      runId: run.id,
      sessionId: session.id,
      date: session.createdAt,
      testId: session.testId,
      lang: session.lang,
      variant: sessionVariant(session.testId, session.config),
      subset: session.config.subset,
      think: session.config.think,
      suiteVersion: session.suiteVersion,
      modelId: model.id,
      model: model.name,
      provider: model.provider,
      digest: model.digest,
      quantization: model.quantization,
      parameterSize: model.parameterSize,
      role: run.role,
      status: run.status,
      judgeScores: run.judgeScores ?? {},
      judgeAvg: run.judgeAvg,
      autoScore: run.autoScore,
      avgLatencyMs: run.avgLatencyMs,
      avgTtftMs: run.avgTtftMs,
      avgTokPerSec: run.avgTokPerSec,
      loadMs: run.loadMs,
      stats: run.stats ?? null,
      ollamaVersion: session.config.ollamaVersion ?? null,
      sdk: session.config.sdk ?? {},
      sdkLabel: sdkLabel(session.config.sdk),
    }));
}

export interface ModelIndexRow {
  name: string;
  provider: string;
  family: string | null;
  parameterSize: string | null;
  quantization: string | null;
  capabilities: string[];
  digests: number;
  runs: number;
  tests: number;
  lastRunAt: number | null;
}

/** Every model ever benchmarked, grouped by name (digests counted). */
export function modelIndex(): ModelIndexRow[] {
  const db = getDb();
  const models = db.select().from(schema.models).orderBy(desc(schema.models.lastSeen)).all(); // newest version first
  const runs = runRows();
  const byName = new Map<string, ModelIndexRow>();
  for (const m of models) {
    const row = byName.get(m.name) ?? {
      name: m.name,
      provider: m.provider,
      family: m.family,
      parameterSize: m.parameterSize,
      quantization: m.quantization,
      capabilities: m.capabilities,
      digests: 0,
      runs: 0,
      tests: 0,
      lastRunAt: null,
    };
    row.digests++;
    byName.set(m.name, row);
  }
  for (const row of byName.values()) {
    const rs = runs.filter((r) => r.model === row.name);
    row.runs = rs.length;
    row.tests = new Set(rs.map((r) => r.testId)).size;
    row.lastRunAt = rs.length ? Math.max(...rs.map((r) => r.date)) : null;
  }
  return [...byName.values()].sort((a, b) => (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0) || a.name.localeCompare(b.name));
}
