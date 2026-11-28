import 'server-only';
import crypto from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb, schema } from '@/db';
import type { SessionConfig, JudgeScores } from '@/db/schema';
import { getTest, isEligible, resolveOptions } from '@/lib/tests/registry';
import { suiteVersion } from '@/lib/tests/fixtures';
import { autoScore } from '@/lib/tests/checks';
import { judgeCaseResult } from '@/lib/judges';
import { listOllamaModels, ollamaVersion, upsertBaselineModel, upsertOllamaModel, warmUp, unload } from '@/lib/ollama';
import { getLanguage } from '@/config/languages';
import type { BaseCase, CaseOutput } from '@/lib/tests/types';
import { createLive, emit, getLive, withOllamaLock } from './events';
import { GenerationError } from '@/lib/tests/generate';
import { sdkVersions } from '@/lib/versions';
import { serverInstance } from './instance';
import { forgetSession, registerSession, releaseSession, type UsedModel } from './residency';

export interface StartSessionInput {
  testId: string;
  lang: string;
  models: string[]; // 1–2 Ollama model names
  config: Partial<SessionConfig>;
  /** add the test's remote baselines (e.g. Cohere) to this session; default true (batch runs add them once) */
  includeBaselines?: boolean;
  /** capability batch this session belongs to */
  batchId?: string;
  /** the caller's next session uses the same model: keep it loaded afterwards (see residency.ts) */
  keepLoaded?: boolean;
}

const avg = (xs: (number | null | undefined)[]) => {
  const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const r1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);

/** num_ctx capped to the smallest maximum context among the selected models (Ollama would cap or fail otherwise). */
function ctxFor(requested: number, maxes: (number | null)[]): { numCtx: number; numCtxRequested?: number } {
  const known = maxes.filter((m): m is number => typeof m === 'number' && m > 0);
  const max = known.length ? Math.min(...known) : Infinity;
  return requested > max ? { numCtx: max, numCtxRequested: requested } : { numCtx: requested };
}

export async function startSession(input: StartSessionInput): Promise<string> {
  const test = getTest(input.testId);
  const lang = getLanguage(input.lang);
  const names = [...new Set(input.models)].filter(Boolean);
  if (names.length < 1 || names.length > 2) throw new Error('Select one or two models');

  const available = await listOllamaModels();
  const picked = names.map((n) => {
    const m = available.find((x) => x.name === n);
    if (!m) throw new Error(`Model not found on Ollama host: ${n}`);
    if (!isEligible(test, m.capabilities))
      throw new Error(
        `${n} lacks the capabilities this test needs (${[...test.requires, ...(test.requiresAny?.length ? [`one of ${test.requiresAny.join('/')}`] : [])].join(', ')})`,
      );
    return m;
  });
  const baselines = input.includeBaselines === false ? [] : (test.baselines?.() ?? []);
  test.loadCases(lang.code); // validate fixtures exist

  const config: SessionConfig = {
    temperature: input.config.temperature ?? 0,
    seed: input.config.seed ?? 42,
    ...ctxFor(
      input.config.numCtx ?? test.numCtx ?? 8192,
      picked.map((m) => m.contextLength),
    ),
    think: input.config.think ?? false,
    subset: input.config.subset ?? 'quick',
    judges: test.judged === false ? [] : (input.config.judges ?? ['openai', 'google', 'anthropic']),
    extra: await resolveOptions(test, input.config.extra),
    ollamaVersion: await ollamaVersion().catch(() => undefined),
    sdk: sdkVersions(),
  };

  const db = getDb();
  const id = crypto.randomUUID();
  db.insert(schema.sessions)
    .values({
      id,
      testId: test.id,
      suiteVersion: suiteVersion(test.id, test.version, test.rubric.version, test.casesFrom ? [test.casesFrom] : []),
      lang: lang.code,
      config,
      status: 'queued',
      batchId: input.batchId,
      instanceId: serverInstance(),
    })
    .run();
  picked.forEach((m, i) => {
    const modelId = upsertOllamaModel(m);
    db.insert(schema.runs)
      .values({ sessionId: id, modelId, blindLabel: String.fromCharCode(65 + i) })
      .run();
  });
  // remote baselines (e.g. Cohere reranker) join every session of the test, blind like any candidate
  baselines.forEach((b, i) => {
    const modelId = upsertBaselineModel(b.provider, b.name, b.capabilities);
    db.insert(schema.runs)
      .values({ sessionId: id, modelId, role: 'baseline', blindLabel: String.fromCharCode(65 + picked.length + i) })
      .run();
  });

  createLive(id);
  registerSession(
    id,
    picked.map((m) => m.name),
    (test.helperModels?.(config) ?? []).map((h) => h.name),
    !!input.keepLoaded,
  );
  void executeSession(id).catch((e) => console.error('[runner] session failed', id, e));
  return id;
}

function selectCases<C extends BaseCase>(cases: C[], subset: SessionConfig['subset']): C[] {
  if (subset === 'full') return cases;
  const q = cases.filter((c) => c.quick);
  return q.length ? q : cases.slice(0, 5);
}

async function executeSession(sessionId: string) {
  const db = getDb();
  const session = db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get()!;
  const test = getTest(session.testId);
  const lang = getLanguage(session.lang);
  const cases = selectCases(test.loadCases(lang.code), session.config.subset);
  const runs = db
    .select({ run: schema.runs, model: schema.models })
    .from(schema.runs)
    .innerJoin(schema.models, eq(schema.runs.modelId, schema.models.id))
    .where(eq(schema.runs.sessionId, sessionId))
    .orderBy(schema.runs.id)
    .all();
  const live = getLive(sessionId)!;
  const signal = live.abort.signal;
  const judging: Promise<unknown>[] = [];

  const setSession = (v: Partial<typeof schema.sessions.$inferInsert>) =>
    db.update(schema.sessions).set(v).where(eq(schema.sessions.id, sessionId)).run();
  const setRun = (id: number, v: Partial<typeof schema.runs.$inferInsert>) =>
    db.update(schema.runs).set(v).where(eq(schema.runs.id, id)).run();

  // Ollama models this session loaded, released at the end of its GPU work (see residency.ts)
  const used: UsedModel[] = (test.helperModels?.(session.config) ?? []).slice();

  try {
    await withOllamaLock(async () => {
      try {
        setSession({ status: 'running' });
        emit(sessionId, { type: 'session', status: 'running' });

        // Models run sequentially, never in parallel, so timings are comparable.
        for (const { run, model } of runs) {
          if (signal.aborted) break;
          setRun(run.id, { status: 'running', startedAt: Date.now() });
          emit(sessionId, { type: 'run-status', runId: run.id, status: 'loading' });
          const isOllama = model.provider === 'ollama';
          const embeddingOnly = model.capabilities.includes('embedding') && !model.capabilities.includes('completion');
          const baseCtx = {
            provider: model.provider,
            modelName: model.name,
            capabilities: model.capabilities,
            lang,
            config: session.config,
            signal,
          };
          let loadMs: number | undefined;
          let shared: unknown;
          // the model's execution time: warm-up + preparation + each case's run; checks, judging and DB writes are
          // left out (see runs.exec_ms)
          let execMs = 0;
          try {
            if (isOllama) {
              const t = performance.now();
              loadMs = await warmUp(
                model.name,
                embeddingOnly ? Math.min(session.config.numCtx, 2048) : session.config.numCtx,
                embeddingOnly,
              );
              execMs += performance.now() - t;
              setRun(run.id, { loadMs });
            }
            if (test.prepare) {
              const t = performance.now();
              const p = await test.prepare({ ...baseCtx, onDelta: () => {} });
              execMs += performance.now() - t;
              shared = p.shared;
              if (p.stats) setRun(run.id, { stats: p.stats });
            }
          } catch (e) {
            const error = `${isOllama && loadMs === undefined ? 'Warm-up' : 'Prepare'} failed: ${(e as Error).message}`;
            setRun(run.id, { status: 'error', error, finishedAt: Date.now() });
            emit(sessionId, { type: 'run-status', runId: run.id, status: 'error', error });
            continue;
          }
          emit(sessionId, { type: 'run-status', runId: run.id, status: 'running', loadMs });

          for (const c of cases) {
            if (signal.aborted) break;
            emit(sessionId, { type: 'case-start', runId: run.id, caseId: c.id, title: c.title });
            const missing = (c.requires ?? []).filter((cap) => !model.capabilities.includes(cap));
            if (missing.length) {
              const error = `skipped: model lacks ${missing.join(', ')}`;
              const cr = db
                .insert(schema.caseResults)
                .values({ runId: run.id, caseId: c.id, error, autoScore: null, checks: [] })
                .returning({ id: schema.caseResults.id })
                .get();
              emit(sessionId, {
                type: 'case-end',
                runId: run.id,
                caseId: c.id,
                caseResultId: cr.id,
                output: '',
                metrics: {},
                checks: [],
                autoScore: null,
                error,
              });
              continue;
            }
            let out: CaseOutput | undefined;
            let error: string | undefined;
            let partial: string | undefined;
            const caseStart = performance.now();
            try {
              out = await test.run(
                { ...baseCtx, shared, onDelta: (text) => emit(sessionId, { type: 'delta', runId: run.id, caseId: c.id, text }) },
                c,
              );
            } catch (e) {
              error = (e as Error).message ?? String(e);
              if (e instanceof GenerationError && e.partialOutput) partial = e.partialOutput;
            }
            // the whole case, failed ones included (time until the failure); the checks below aren't part of it
            const caseExecMs = performance.now() - caseStart;
            execMs += caseExecMs;
            // thinking models can spend the whole output budget on hidden reasoning (some ignore think=false)
            if (out && !out.output.trim() && out.reasoning?.trim()) {
              error = `empty answer: the whole output budget went to reasoning (${out.reasoning.length} chars${session.config.think ? '' : ', although thinking was off'})`;
            }
            const checks = out ? test.check(c, out, lang) : [];
            const auto = out ? autoScore(checks) : 0;
            const cr = db
              .insert(schema.caseResults)
              .values({
                runId: run.id,
                caseId: c.id,
                output: out?.output ?? partial,
                reasoning: out?.reasoning,
                data: out?.data,
                latencyMs: out?.latencyMs,
                ttftMs: out?.ttftMs,
                tokensIn: out?.tokensIn,
                tokensOut: out?.tokensOut,
                reasoningTokens: out?.reasoningTokens,
                tokPerSec: out?.tokPerSec,
                execMs: caseExecMs,
                autoScore: auto,
                checks,
                error,
              })
              .returning({ id: schema.caseResults.id })
              .get();
            emit(sessionId, {
              type: 'case-end',
              runId: run.id,
              caseId: c.id,
              caseResultId: cr.id,
              output: out?.output ?? partial ?? '',
              reasoning: out?.reasoning,
              data: out?.data,
              metrics: {
                latencyMs: out?.latencyMs,
                ttftMs: out?.ttftMs,
                tokensIn: out?.tokensIn,
                tokensOut: out?.tokensOut,
                reasoningTokens: out?.reasoningTokens,
                tokPerSec: out?.tokPerSec,
                execMs: caseExecMs,
              },
              checks,
              autoScore: auto,
              error,
            });

            // Judges run on remote APIs: fire now, in parallel with the next Ollama generation.
            if (out && out.output.trim() && session.config.judges.length) {
              judging.push(
                judgeCaseResult({
                  caseResultId: cr.id,
                  rubric: test.rubric,
                  material: test.judgeMaterial(c, out, lang),
                  lang,
                  responseLanguage: test.responseLanguage ?? 'case',
                  enabled: session.config.judges,
                }).then((outcomes) => {
                  for (const o of outcomes)
                    emit(sessionId, {
                      type: 'judgment',
                      runId: run.id,
                      caseId: c.id,
                      caseResultId: cr.id,
                      judge: o.judge,
                      score: o.score,
                      rationale: o.rationale,
                      cached: o.cached,
                      withoutAttachments: o.withoutAttachments,
                      error: o.error,
                    });
                }),
              );
            }
          }
          if (test.cleanup) await test.cleanup(shared).catch((e) => console.error('[runner] cleanup failed', e));
          setRun(run.id, {
            status: signal.aborted ? 'error' : 'done',
            finishedAt: Date.now(),
            execMs,
            error: signal.aborted ? 'cancelled' : null,
          });
          emit(sessionId, { type: 'run-status', runId: run.id, status: signal.aborted ? 'error' : 'done' });
          if (!isOllama) continue;
          // two models: unload each after its run, so the second never shares the GPU with the first
          if (runs.filter((r) => r.model.provider === 'ollama').length > 1) await unload(model.name, embeddingOnly);
          else used.push({ name: model.name, embedding: embeddingOnly });
        }
      } finally {
        // still inside the GPU lock: free what no queued session needs before the next one loads its model
        const released = await releaseSession(sessionId, used).catch((e) => {
          console.error('[runner] release failed', e);
          return [] as string[];
        });
        if (released.length) console.log(`[runner] unloaded ${released.join(', ')} (nothing queued needs them)`);
      }
    });

    if (judging.length) {
      setSession({ status: 'running' });
      emit(sessionId, { type: 'session', status: 'judging' });
      await Promise.allSettled(judging);
    }

    for (const { run } of runs) {
      const scores = aggregateRun(run.id);
      emit(sessionId, { type: 'run-scores', runId: run.id, ...scores });
    }
    const status = signal.aborted ? 'cancelled' : 'done';
    setSession({ status, finishedAt: Date.now() });
    emit(sessionId, { type: 'session-end', status });
  } catch (e) {
    const error = (e as Error).message;
    setSession({ status: 'error', error, finishedAt: Date.now() });
    emit(sessionId, { type: 'session-end', status: 'error', error });
  } finally {
    forgetSession(sessionId); // no-op when released above
  }
}

/** Compute and cache a run's aggregate scores: auto mean, per-judge mean, judge average, speed. */
export function aggregateRun(runId: number): { autoScore: number | null; judgeScores: JudgeScores; judgeAvg: number | null } {
  const db = getDb();
  const crs = db.select().from(schema.caseResults).where(eq(schema.caseResults.runId, runId)).all();
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
  const byJudge = new Map<string, number[]>();
  for (const j of js) if (j.score != null) byJudge.set(j.judge, [...(byJudge.get(j.judge) ?? []), j.score]);
  const judgeScores: JudgeScores = {};
  for (const [k, v] of byJudge) judgeScores[k] = r1(avg(v));
  const judgeAvg = r1(avg(Object.values(judgeScores)));
  const auto = r1(avg(crs.map((c) => c.autoScore)));
  db.update(schema.runs)
    .set({
      autoScore: auto,
      judgeScores,
      judgeAvg,
      avgLatencyMs: avg(crs.map((c) => c.latencyMs)),
      avgTtftMs: avg(crs.map((c) => c.ttftMs)),
      avgTokPerSec: avg(crs.map((c) => c.tokPerSec)),
    })
    .where(eq(schema.runs.id, runId))
    .run();
  return { autoScore: auto, judgeScores, judgeAvg };
}

export function cancelSession(sessionId: string) {
  getLive(sessionId)?.abort.abort();
}

/**
 * Re-run the judges on an existing session (e.g. after changing judge models or rubrics): deletes the session's
 * judgments, judges every case result again (identical inputs are still served from the cache), re-aggregates.
 * Progress is streamed on the session's live channel.
 */
export async function rejudgeSession(sessionId: string, judgeIds?: string[], caseResultIds?: number[]): Promise<void> {
  const db = getDb();
  const existing = getLive(sessionId);
  if (existing && !existing.done) throw new Error('Session is still running');
  const session = db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
  if (!session) throw new Error('Session not found');
  const test = getTest(session.testId);
  const lang = getLanguage(session.lang);
  const cases = new Map(test.loadCases(lang.code).map((c) => [c.id, c]));
  const enabled = judgeIds ?? session.config.judges;
  const targeted = !!caseResultIds?.length;
  const runs = db.select().from(schema.runs).where(eq(schema.runs.sessionId, sessionId)).all();
  const crs = (
    runs.length
      ? db
          .select()
          .from(schema.caseResults)
          .where(
            inArray(
              schema.caseResults.runId,
              runs.map((r) => r.id),
            ),
          )
          .all()
      : []
  ).filter((c) => !targeted || caseResultIds!.includes(c.id));

  createLive(sessionId);
  emit(sessionId, { type: 'session', status: 'judging' });
  try {
    // only the selected judges' verdicts on the selected cases are replaced; other judgments stay
    if (crs.length)
      db.delete(schema.judgments)
        .where(
          and(
            inArray(
              schema.judgments.caseResultId,
              crs.map((c) => c.id),
            ),
            inArray(schema.judgments.judge, enabled),
          ),
        )
        .run();
    // a targeted re-judge (one case / one judge) must not change the session's judge list
    if (!targeted)
      db.update(schema.sessions)
        .set({ config: { ...session.config, judges: enabled } })
        .where(eq(schema.sessions.id, sessionId))
        .run();
    const todo = crs.filter((cr) => cr.output != null && !cr.error && cases.has(cr.caseId));
    // a few cases at a time: judge APIs run in parallel per case already
    for (let i = 0; i < todo.length; i += 4) {
      await Promise.allSettled(
        todo.slice(i, i + 4).map(async (cr) => {
          const c = cases.get(cr.caseId)!;
          const out: CaseOutput = { output: cr.output ?? '', reasoning: cr.reasoning ?? undefined, data: cr.data ?? undefined };
          const outcomes = await judgeCaseResult({
            caseResultId: cr.id,
            rubric: test.rubric,
            material: test.judgeMaterial(c, out, lang),
            lang,
            responseLanguage: test.responseLanguage ?? 'case',
            enabled,
          });
          for (const o of outcomes)
            emit(sessionId, {
              type: 'judgment',
              runId: cr.runId,
              caseId: cr.caseId,
              caseResultId: cr.id,
              judge: o.judge,
              score: o.score,
              rationale: o.rationale,
              cached: o.cached,
              withoutAttachments: o.withoutAttachments,
              error: o.error,
            });
        }),
      );
    }
    for (const r of runs) emit(sessionId, { type: 'run-scores', runId: r.id, ...aggregateRun(r.id) });
    emit(sessionId, { type: 'session-end', status: 'done' });
  } catch (e) {
    emit(sessionId, { type: 'session-end', status: 'error', error: (e as Error).message });
    throw e;
  }
}
