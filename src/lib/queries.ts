import 'server-only';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb, schema } from '@/db';
import type { Batch, CaseResult, Judgment, Model, Run, Session } from '@/db/schema';
import { customCtx, getTest, isEligible, isKnownTest, listTests, sessionVariant, TESTS } from '@/lib/tests/registry';
import { CAPABILITIES, getCapability } from '@/config/capabilities';
import { inTier, type Tier } from '@/lib/tiers';
import { sdkLabel } from '@/lib/versions';
import { runExecMs, sessionExecMs } from '@/lib/timing';

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
  batchId: string | null;
  /** total execution time (see lib/timing.ts); null until the session has finished */
  execMs: number | null;
  runs: { model: string; judgeAvg: number | null; autoScore: number | null; avgTokPerSec: number | null }[];
}

export function recentSessions(limit = 20, testId?: string): SessionListItem[] {
  const db = getDb();
  const sessions = db
    .select()
    .from(schema.sessions)
    .where(
      testId
        ? eq(schema.sessions.testId, testId)
        : inArray(
            schema.sessions.testId,
            TESTS.map((t) => t.id),
          ),
    )
    .orderBy(desc(schema.sessions.createdAt))
    .limit(limit)
    .all();
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
  return sessions.map((s) => {
    const mine = runs.filter((r) => r.run.sessionId === s.id);
    return {
      id: s.id,
      testId: s.testId,
      lang: s.lang,
      status: s.status,
      createdAt: s.createdAt,
      subset: s.config.subset,
      variant: sessionVariant(s.testId, s.config),
      batchId: s.batchId,
      execMs: sessionExecMs(
        s,
        mine.map((r) => r.run),
      ),
      runs: mine.map((r) => ({
        model: r.model.name,
        judgeAvg: r.run.judgeAvg,
        autoScore: r.run.autoScore,
        avgTokPerSec: r.run.avgTokPerSec,
      })),
    };
  });
}

export interface LeaderboardRow {
  modelId: number;
  /** session of the run shown (the latest judged one) */
  sessionId: string;
  runId: number;
  suiteVersion: string;
  capabilities: string[];
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
  /** execution time of the run shown (see lib/timing.ts), on its case set */
  execMs: number | null;
  subset: string;
  /** num_ctx when it isn't the test's default (the num_ctx part of `variant`) */
  numCtx: number | null;
  /** set by bestPerModel: the model's other leaderboard rows (languages, variants, digests) folded into this one */
  others?: number;
}

/**
 * One row per model name: its best leaderboard row (judge average, else the automatic score). Results of the test's
 * current suite version win over older ones, then judged results over unjudged ones (as in leaderboard(): a high
 * auto score from an unjudged quick run shouldn't hide the judges' verdict), then the higher score, then the most
 * recent. Sorted best first, baselines last.
 */
export function bestPerModel(rows: LeaderboardRow[], currentSuite: string): LeaderboardRow[] {
  const score = (r: LeaderboardRow) => r.judgeAvg ?? r.autoScore ?? -1;
  const key = (r: LeaderboardRow) => [Number(r.suiteVersion === currentSuite), Number(r.judgeAvg != null), score(r), r.lastRunAt];
  const better = (a: LeaderboardRow, b: LeaderboardRow) => {
    const [x, y] = [key(a), key(b)];
    const i = x.findIndex((v, n) => v !== y[n]);
    return i >= 0 && x[i] > y[i];
  };
  const best = new Map<string, LeaderboardRow>();
  const count = new Map<string, number>();
  for (const r of rows) {
    count.set(r.model, (count.get(r.model) ?? 0) + 1);
    const cur = best.get(r.model);
    if (!cur || better(r, cur)) best.set(r.model, r);
  }
  return [...best.values()]
    .map((r) => ({ ...r, others: count.get(r.model)! - 1 }))
    .sort((a, b) => Number(a.provider !== 'ollama') - Number(b.provider !== 'ollama') || score(b) - score(a));
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
      sessionId: session.id,
      runId: run.id,
      suiteVersion: session.suiteVersion,
      capabilities: model.capabilities,
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
      execMs: runExecMs(run),
      subset: session.config.subset,
      numCtx: customCtx(session.testId, session.config),
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
  /** execution time of the run (see lib/timing.ts) */
  execMs: number | null;
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
        (filter.testId ? r.session.testId === filter.testId : isKnownTest(r.session.testId)) &&
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
      execMs: runExecMs(run),
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
  /** mixture-of-experts: total / active per token (latest version of the model; null = dense or unknown) */
  experts: number | null;
  expertsActive: number | null;
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
      experts: m.experts,
      expertsActive: m.expertsActive,
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

// ---------- capabilities ----------

export interface CapabilityCell {
  score: number | null;
  sessionId: string;
  runId: number;
  lastRunAt: number;
  /** from an older suite version of the test (cases changed since): shown, but not counted */
  stale: boolean;
  /** generation throughput of that run; null for tests that don't generate text (embeddings, reranking) */
  tokPerSec: number | null;
  /** the run's variant when it isn't the default one (test options, num_ctx), e.g. "num_ctx=32768" */
  variant: string | null;
  /** num_ctx of that run when it isn't the test's default */
  numCtx: number | null;
}
export interface CapabilityRow {
  model: string;
  provider: string;
  parameterSize: string | null;
  quantization: string | null;
  cells: Record<string, CapabilityCell | undefined>;
  /** mean of the current (non-stale) cells, 0-10 */
  score: number | null;
  /** current results among the tests this model can take */
  covered: number;
  /** tests this model can take (by its Ollama capabilities) that anyone has run in this language */
  required: number;
  /** remote reference (e.g. Cohere): shown, never ranked */
  baseline: boolean;
  /** has a current result on every test it can take; baselines are never ranked */
  ranked: boolean;
  avgTokPerSec: number | null;
}
export interface CapabilityBoard {
  capability: { id: string; label: string; description: string };
  tests: { id: string; name: string; hasResults: boolean }[];
  rows: CapabilityRow[];
}

const mainScore = (r: Pick<LeaderboardRow, 'judgeAvg' | 'autoScore'>) => r.judgeAvg ?? r.autoScore;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * One row per model name: for each of the capability's tests, the model's best result in one language (judge average,
 * else the automatic score) over every variant and digest, as the dashboard's per-test tables (bestPerModel).
 * Only results from the test's current suite version count; older ones are shown as stale.
 * Ranking needs a current result on every test the model can take (by its Ollama capabilities: an embedding model
 * can't run RAG, a chat model can't run the embeddings test) among those anyone has run, so one strong result
 * doesn't top the table, and a test nobody has run yet (e.g. web search without credits) counts against no one.
 */
export async function capabilityBoard(capabilityId: string, lang: string, tier: Tier = 'all'): Promise<CapabilityBoard | null> {
  const cap = getCapability(capabilityId);
  if (!cap) return null;
  const summaries = await listTests();
  const tests = cap.tests.map((id) => summaries.find((t) => t.id === id)).filter((t): t is NonNullable<typeof t> => !!t);

  const byModel = new Map<string, CapabilityRow & { tok: number[]; caps: string[] }>();
  const hasResults = new Set<string>();
  for (const t of tests) {
    // per model name: its best run in this language, in any variant (options, num_ctx) or digest; the cell names a
    // non-default variant. Current-suite results win over stale ones, judged over unjudged (see bestPerModel).
    for (const r of bestPerModel(leaderboard(t.id, lang), t.suiteVersion)) {
      const stale = r.suiteVersion !== t.suiteVersion;
      if (!stale) hasResults.add(t.id);
      if (!inTier(r.parameterSize, tier)) continue;
      let row = byModel.get(r.model);
      if (!row) {
        row = {
          model: r.model,
          provider: r.provider,
          parameterSize: r.parameterSize,
          quantization: r.quantization,
          cells: {},
          score: null,
          covered: 0,
          required: 0,
          baseline: r.provider !== 'ollama',
          ranked: false,
          avgTokPerSec: null,
          tok: [],
          caps: r.capabilities,
        };
        byModel.set(r.model, row);
      }
      row.cells[t.id] = {
        score: mainScore(r),
        sessionId: r.sessionId,
        runId: r.runId,
        lastRunAt: r.lastRunAt,
        stale,
        tokPerSec: r.avgTokPerSec,
        variant: r.variant || null,
        numCtx: r.numCtx,
      };
      if (!stale && r.avgTokPerSec != null) row.tok.push(r.avgTokPerSec);
    }
  }
  const rows: CapabilityRow[] = [...byModel.values()].map(({ tok, caps, ...row }) => {
    const current = Object.values(row.cells).filter((c): c is CapabilityCell => !!c && !c.stale);
    const scores = current.map((c) => c.score).filter((x): x is number => typeof x === 'number');
    // baselines only join their own tests: their "required" set is what they have
    const required = tests.filter((t) => hasResults.has(t.id) && (row.baseline ? !!row.cells[t.id] : isEligible(t, caps))).map((t) => t.id);
    const covered = required.filter((id) => row.cells[id] && !row.cells[id]!.stale).length;
    return {
      ...row,
      score: mean(scores),
      covered,
      required: required.length,
      ranked: !row.baseline && required.length > 0 && covered === required.length,
      avgTokPerSec: mean(tok),
    };
  });
  rows.sort((a, b) => Number(b.ranked) - Number(a.ranked) || Number(a.baseline) - Number(b.baseline) || (b.score ?? -1) - (a.score ?? -1));
  return {
    capability: { id: cap.id, label: cap.label, description: cap.description },
    tests: tests.map((t) => ({ id: t.id, name: t.name, hasResults: hasResults.has(t.id) })),
    rows,
  };
}

export interface OverviewCell {
  score: number | null;
  ranked: boolean;
  covered: number;
  required: number;
}
export interface OverviewRow {
  model: string;
  provider: string;
  parameterSize: string | null;
  baseline: boolean;
  scores: Record<string, OverviewCell | undefined>;
  /** mean of the ranked capability scores (the table's sort key); null when no capability is ranked */
  overall: number | null;
  /** labels of the capabilities in `overall` */
  overallOf: string[];
  /** mean tokens/s over the model's current results, each test once (RAG sits in two capabilities) */
  avgTokPerSec: number | null;
}

/** Model x capability matrix (each capability's score as in capabilityBoard), best ranked mean first. */
export async function capabilityOverview(lang: string, tier: Tier = 'all'): Promise<OverviewRow[]> {
  const boards = (await Promise.all(CAPABILITIES.map((c) => capabilityBoard(c.id, lang, tier)))).filter((b): b is CapabilityBoard => !!b);
  const rows = new Map<string, OverviewRow>();
  const tok = new Map<string, Map<string, number>>(); // model -> test -> tokens/s
  for (const b of boards)
    for (const r of b.rows) {
      const row = rows.get(r.model) ?? {
        model: r.model,
        provider: r.provider,
        parameterSize: r.parameterSize,
        baseline: r.baseline,
        scores: {},
        overall: null,
        overallOf: [],
        avgTokPerSec: null,
      };
      row.scores[b.capability.id] = { score: r.score, ranked: r.ranked, covered: r.covered, required: r.required };
      if (r.ranked && r.score != null) row.overallOf.push(b.capability.label);
      rows.set(r.model, row);
      const t = tok.get(r.model) ?? new Map<string, number>();
      for (const [testId, c] of Object.entries(r.cells)) if (c && !c.stale && c.tokPerSec != null) t.set(testId, c.tokPerSec);
      tok.set(r.model, t);
    }
  for (const row of rows.values()) {
    row.overall = mean(
      Object.values(row.scores)
        .filter((x): x is OverviewCell => !!x && x.ranked && x.score != null)
        .map((x) => x.score!),
    );
    row.avgTokPerSec = mean([...(tok.get(row.model)?.values() ?? [])]);
  }
  return [...rows.values()].sort(
    (a, b) => Number(a.baseline) - Number(b.baseline) || (b.overall ?? -1) - (a.overall ?? -1) || a.model.localeCompare(b.model),
  );
}

// ---------- batches ----------

export interface BatchCell {
  status: string;
  score: number | null;
  judgeAvg: number | null;
  autoScore: number | null;
}
export interface BatchDetail extends Batch {
  sessions: { id: string; testId: string; status: Session['status']; error: string | null; variant: string }[];
  /** model name -> test id -> candidate run */
  cells: Record<string, Record<string, BatchCell | undefined>>;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
}

export function getBatchDetail(id: string): BatchDetail | null {
  const db = getDb();
  const batch = db.select().from(schema.batches).where(eq(schema.batches.id, id)).get();
  if (!batch) return null;
  const ss = db.select().from(schema.sessions).where(eq(schema.sessions.batchId, id)).orderBy(schema.sessions.createdAt).all();
  const runs = ss.length
    ? db
        .select({ run: schema.runs, model: schema.models })
        .from(schema.runs)
        .innerJoin(schema.models, eq(schema.runs.modelId, schema.models.id))
        .where(
          inArray(
            schema.runs.sessionId,
            ss.map((s) => s.id),
          ),
        )
        .all()
    : [];
  const cells: BatchDetail['cells'] = {};
  for (const { run, model } of runs) {
    if (run.role !== 'candidate') continue;
    const testId = ss.find((s) => s.id === run.sessionId)!.testId;
    (cells[model.name] ??= {})[testId] = {
      status: run.status,
      score: run.judgeAvg ?? run.autoScore,
      judgeAvg: run.judgeAvg,
      autoScore: run.autoScore,
    };
  }
  const st = ss.map((s) => s.status);
  const active = st.some((x) => x === 'running') || (st.some((x) => x === 'queued') && st.some((x) => x !== 'queued'));
  const status: BatchDetail['status'] = active
    ? 'running'
    : st.length && st.every((x) => x === 'queued')
      ? 'queued'
      : st.includes('error')
        ? 'error'
        : st.includes('cancelled')
          ? 'cancelled'
          : 'done';
  return {
    ...batch,
    sessions: ss.map((s) => ({
      id: s.id,
      testId: s.testId,
      status: s.status,
      error: s.error,
      variant: sessionVariant(s.testId, s.config),
    })),
    cells,
    status,
  };
}

// ---------- what is running now ----------

export interface ActiveSession {
  id: string;
  testId: string;
  testName: string;
  lang: string;
  subset: string;
  variant: string;
  status: Session['status'];
  createdAt: number;
  batchId: string | null;
  runs: { model: string; role: string; status: string }[];
  /** case results recorded so far / cases x runs */
  done: number;
  total: number;
}

/**
 * Sessions queued or running, oldest first (the order the GPU lock serves them). Reliable because sessions a stopped
 * server left behind are marked interrupted at startup (src/lib/runner/recover.ts).
 */
export function activeSessions(): ActiveSession[] {
  const db = getDb();
  const ss = db
    .select()
    .from(schema.sessions)
    .where(inArray(schema.sessions.status, ['queued', 'running']))
    .orderBy(schema.sessions.createdAt)
    .all();
  if (!ss.length) return [];
  const runs = db
    .select({ run: schema.runs, model: schema.models })
    .from(schema.runs)
    .innerJoin(schema.models, eq(schema.runs.modelId, schema.models.id))
    .where(
      inArray(
        schema.runs.sessionId,
        ss.map((s) => s.id),
      ),
    )
    .orderBy(schema.runs.id)
    .all();
  const crs = runs.length
    ? db
        .select({ runId: schema.caseResults.runId })
        .from(schema.caseResults)
        .where(
          inArray(
            schema.caseResults.runId,
            runs.map((r) => r.run.id),
          ),
        )
        .all()
    : [];
  return ss.map((s) => {
    const test = getTest(s.testId);
    // same selection as the runner: the quick subset is the cases marked quick, else the first five
    const cases = test.loadCases(s.lang);
    const perRun = s.config.subset === 'full' ? cases.length : cases.filter((c) => c.quick).length || Math.min(5, cases.length);
    const rs = runs.filter((r) => r.run.sessionId === s.id);
    const ids = new Set(rs.map((r) => r.run.id));
    return {
      id: s.id,
      testId: s.testId,
      testName: test.name,
      lang: s.lang,
      subset: s.config.subset,
      variant: sessionVariant(s.testId, s.config),
      status: s.status,
      createdAt: s.createdAt,
      batchId: s.batchId,
      runs: rs.map((r) => ({ model: r.model.name, role: r.run.role, status: r.run.status })),
      done: crs.filter((c) => ids.has(c.runId)).length,
      total: perRun * rs.length,
    };
  });
}

// ---------- compare two models ----------

export interface ComparePoint {
  t: number;
  score: number | null;
  judgeAvg: number | null;
  autoScore: number | null;
  digest: string;
  sessionId: string;
}
export interface CompareSide<T> {
  a: T | undefined;
  b: T | undefined;
}
/** Speed of a result: generation throughput and how long one case takes on average. */
export interface SpeedCell {
  /** tokens/s; null for tests that don't generate text (embeddings, reranking) */
  tokPerSec: number | null;
  /** average execution time of one case (case_results.exec_ms: checks and judging excluded) */
  caseMs: number | null;
  /**
   * caseMs estimated for runs recorded before cases were timed: (run start → end − model load) / cases. Close, but it
   * includes the test's preparation (e.g. a RAG index build) and the automatic checks.
   */
  approx: boolean;
}

export interface ModelComparison {
  models: [ModelIndexRow, ModelIndexRow];
  /** Ollama capabilities both models have */
  commonCapabilities: string[];
  lang: string;
  /** capability scores (as on the dashboard's capability view); speed: mean over the capability's current results */
  capabilities: ({ id: string; label: string; speed: CompareSide<SpeedCell> } & CompareSide<OverviewCell>)[];
  /** latest current-suite, default-variant score per test (as in the capability tables), and that run's speed */
  tests: ({ id: string; name: string; speed: CompareSide<SpeedCell> } & CompareSide<CapabilityCell>)[];
  /** every run of either model, per (test, language, variant) */
  history: ({ key: string; testId: string; testName: string; lang: string; variant: string } & { a: ComparePoint[]; b: ComparePoint[] })[];
}

/**
 * Average execution time of one case, per run: the mean of the measured case times (case_results.exec_ms), or, for
 * runs recorded before cases were timed, (run start → end − model load) / cases, flagged as approximate.
 */
function avgCaseExecByRun(runIds: number[]): Map<number, { ms: number; approx: boolean }> {
  const out = new Map<number, { ms: number; approx: boolean }>();
  if (!runIds.length) return out;
  const db = getDb();
  const agg = new Map(
    db
      .select({
        runId: schema.caseResults.runId,
        avg: sql<number | null>`avg(${schema.caseResults.execMs})`, // nulls (skipped cases, old results) left out
        cases: sql<number>`count(*)`,
      })
      .from(schema.caseResults)
      .where(inArray(schema.caseResults.runId, runIds))
      .groupBy(schema.caseResults.runId)
      .all()
      .map((a) => [a.runId, a]),
  );
  for (const run of db.select().from(schema.runs).where(inArray(schema.runs.id, runIds)).all()) {
    const a = agg.get(run.id);
    if (a?.avg != null) {
      out.set(run.id, { ms: a.avg, approx: false });
      continue;
    }
    const total = runExecMs(run);
    if (total != null && a?.cases) out.set(run.id, { ms: Math.max(0, total - (run.loadMs ?? 0)) / a.cases, approx: true });
  }
  return out;
}

/** Everything the compare page shows for two models; null when either name is unknown. */
export async function compareModels(aName: string, bName: string, lang: string): Promise<ModelComparison | null> {
  const index = modelIndex();
  const a = index.find((m) => m.name === aName);
  const b = index.find((m) => m.name === bName);
  if (!a || !b) return null;
  const summaries = await listTests();
  const testName = (id: string) => summaries.find((t) => t.id === id)?.name ?? id;

  const overview = await capabilityOverview(lang);
  const boards = new Map<string, CapabilityBoard | null>();
  for (const c of CAPABILITIES) boards.set(c.id, await capabilityBoard(c.id, lang));

  // average case time of every run the comparison shows
  const shownRuns = [...boards.values()].flatMap((bd) =>
    (bd?.rows ?? [])
      .filter((r) => r.model === aName || r.model === bName)
      .flatMap((r) => Object.values(r.cells).map((c) => c?.runId))
      .filter((id): id is number => id != null),
  );
  const caseTimes = avgCaseExecByRun([...new Set(shownRuns)]);
  const speedOf = (c: CapabilityCell | undefined): SpeedCell | undefined =>
    c && { tokPerSec: c.tokPerSec, caseMs: caseTimes.get(c.runId)?.ms ?? null, approx: !!caseTimes.get(c.runId)?.approx };

  const tests: ModelComparison['tests'] = [];
  for (const c of CAPABILITIES) {
    const board = boards.get(c.id);
    for (const t of board?.tests ?? []) {
      if (tests.some((x) => x.id === t.id)) continue; // a test can sit in two capabilities (rag)
      const cell = (m: string) => board!.rows.find((r) => r.model === m)?.cells[t.id];
      tests.push({ id: t.id, name: t.name, a: cell(aName), b: cell(bName), speed: { a: speedOf(cell(aName)), b: speedOf(cell(bName)) } });
    }
  }

  // a capability's speed: the mean over its current (non-stale) results, like its score
  const capSpeed = (capId: string, m: string): SpeedCell | undefined => {
    const row = boards.get(capId)?.rows.find((r) => r.model === m);
    const speeds = Object.values(row?.cells ?? {})
      .filter((c): c is CapabilityCell => !!c && !c.stale)
      .map(speedOf)
      .filter((s): s is SpeedCell => !!s);
    if (!speeds.length) return undefined;
    const pick = (k: 'tokPerSec' | 'caseMs') => mean(speeds.map((s) => s[k]).filter((x): x is number => x != null));
    return { tokPerSec: pick('tokPerSec'), caseMs: pick('caseMs'), approx: speeds.some((s) => s.approx && s.caseMs != null) };
  };
  const capabilities = CAPABILITIES.map((c) => ({
    id: c.id,
    label: c.label,
    a: overview.find((r) => r.model === aName)?.scores[c.id],
    b: overview.find((r) => r.model === bName)?.scores[c.id],
    speed: { a: capSpeed(c.id, aName), b: capSpeed(c.id, bName) },
  }));

  const point = (r: RunRow): ComparePoint => ({
    t: r.date,
    score: r.judgeAvg ?? r.autoScore,
    judgeAvg: r.judgeAvg,
    autoScore: r.autoScore,
    digest: r.digest.slice(0, 8),
    sessionId: r.sessionId,
  });
  const groups = new Map<string, ModelComparison['history'][number]>();
  for (const [side, name] of [
    ['a', aName],
    ['b', bName],
  ] as const) {
    for (const r of runRows({ model: name })) {
      if (r.status !== 'done' || r.role !== 'candidate') continue;
      const key = `${r.testId}|${r.lang}|${r.variant}`;
      const g = groups.get(key) ?? { key, testId: r.testId, testName: testName(r.testId), lang: r.lang, variant: r.variant, a: [], b: [] };
      g[side].push(point(r));
      groups.set(key, g);
    }
  }
  // tests both models ran first, then the rest; alphabetical within
  const history = [...groups.values()].sort(
    (x, y) => Number(!!y.a.length && !!y.b.length) - Number(!!x.a.length && !!x.b.length) || x.key.localeCompare(y.key),
  );

  return {
    models: [a, b],
    commonCapabilities: a.capabilities.filter((c) => b.capabilities.includes(c)),
    lang,
    capabilities,
    tests,
    history,
  };
}
