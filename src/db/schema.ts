import { sqliteTable, text, integer, real, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

const now = sql`(unixepoch() * 1000)`;

/** Every model that has ever been benchmarked. A re-pulled/re-quantized model (new digest) is a new row. */
export const models = sqliteTable(
  'models',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    provider: text('provider', { enum: ['ollama', 'cohere'] }).notNull(),
    name: text('name').notNull(),
    digest: text('digest').notNull().default(''),
    family: text('family'),
    parameterSize: text('parameter_size'),
    quantization: text('quantization'),
    contextLength: integer('context_length'),
    /** mixture-of-experts: total experts and experts active per token (from /api/show model_info; null = dense) */
    experts: integer('experts'),
    expertsActive: integer('experts_active'),
    capabilities: text('capabilities', { mode: 'json' }).$type<string[]>().notNull().default([]),
    firstSeen: integer('first_seen', { mode: 'number' }).notNull().default(now),
    lastSeen: integer('last_seen', { mode: 'number' }).notNull().default(now),
  },
  (t) => [uniqueIndex('models_provider_name_digest').on(t.provider, t.name, t.digest)],
);

export interface SessionConfig {
  temperature: number;
  seed: number;
  numCtx: number;
  /** set when numCtx was capped to the selected models' maximum context (the value that was requested) */
  numCtxRequested?: number;
  think: boolean;
  subset: 'quick' | 'full';
  judges: string[];
  ollamaVersion?: string;
  /** installed versions of ai, @ai-sdk/*, ai-sdk-ollama, ollama (JS) when the session ran */
  sdk?: Record<string, string>;
  extra?: Record<string, unknown>;
}

/**
 * A capability run: one session per selected test, all with the same 1–2 models, language and config. Sessions run
 * one after another (GPU lock, first come first served); the batch's status is derived from its sessions.
 */
/**
 * App server processes that run sessions. Several can share the DB (e.g. a dev server on :3000 and another on
 * :3311): each heartbeats while alive, and a starting server only recovers sessions (and Docker containers) of
 * servers whose heartbeat stopped.
 */
export const serverInstances = sqliteTable('server_instances', {
  id: text('id').primaryKey(),
  pid: integer('pid').notNull(),
  startedAt: integer('started_at', { mode: 'number' }).notNull().default(now),
  heartbeatAt: integer('heartbeat_at', { mode: 'number' }).notNull().default(now),
});

export const batches = sqliteTable('batches', {
  id: text('id').primaryKey(),
  capability: text('capability').notNull(),
  lang: text('lang').notNull(),
  models: text('models', { mode: 'json' }).$type<string[]>().notNull(),
  testIds: text('test_ids', { mode: 'json' }).$type<string[]>().notNull(),
  config: text('config', { mode: 'json' }).$type<Partial<SessionConfig>>().notNull(),
  createdAt: integer('created_at', { mode: 'number' }).notNull().default(now),
});

/** One "run" click: a test, a language, 1–2 models (+ baselines), shared config. */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    testId: text('test_id').notNull(),
    suiteVersion: text('suite_version').notNull(),
    lang: text('lang').notNull(),
    config: text('config', { mode: 'json' }).$type<SessionConfig>().notNull(),
    status: text('status', { enum: ['queued', 'running', 'done', 'error', 'cancelled'] })
      .notNull()
      .default('queued'),
    error: text('error'),
    createdAt: integer('created_at', { mode: 'number' }).notNull().default(now),
    finishedAt: integer('finished_at', { mode: 'number' }),
    /** set when the session was started as part of a capability batch */
    batchId: text('batch_id').references(() => batches.id, { onDelete: 'set null' }),
    /** server instance executing it (server_instances.id) */
    instanceId: text('instance_id'),
  },
  (t) => [index('sessions_test').on(t.testId, t.createdAt), index('sessions_batch').on(t.batchId)],
);

export type JudgeScores = Record<string, number | null>;

/** One model inside a session. Aggregated scores are cached here once the run completes. */
export const runs = sqliteTable(
  'runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    modelId: integer('model_id')
      .notNull()
      .references(() => models.id),
    role: text('role', { enum: ['candidate', 'baseline'] })
      .notNull()
      .default('candidate'),
    blindLabel: text('blind_label').notNull(),
    status: text('status', { enum: ['queued', 'running', 'done', 'error'] })
      .notNull()
      .default('queued'),
    error: text('error'),
    loadMs: real('load_ms'),
    autoScore: real('auto_score'),
    judgeScores: text('judge_scores', { mode: 'json' }).$type<JudgeScores>(),
    judgeAvg: real('judge_avg'),
    avgLatencyMs: real('avg_latency_ms'),
    avgTtftMs: real('avg_ttft_ms'),
    avgTokPerSec: real('avg_tok_per_sec'),
    /** run-level metrics from the test's prepare() step (e.g. index build time, chunks/s) */
    stats: text('stats', { mode: 'json' }).$type<Record<string, number | string>>(),
    startedAt: integer('started_at', { mode: 'number' }),
    finishedAt: integer('finished_at', { mode: 'number' }),
  },
  (t) => [index('runs_session').on(t.sessionId), index('runs_model').on(t.modelId)],
);

export interface CheckResult {
  name: string;
  pass: boolean;
  detail?: string;
  /** optional 0..1 partial score (e.g. field accuracy); defaults to pass ? 1 : 0 */
  value?: number;
}

export const caseResults = sqliteTable(
  'case_results',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    caseId: text('case_id').notNull(),
    output: text('output'),
    reasoning: text('reasoning'),
    data: text('data', { mode: 'json' }).$type<unknown>(),
    latencyMs: real('latency_ms'),
    ttftMs: real('ttft_ms'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    reasoningTokens: integer('reasoning_tokens'),
    tokPerSec: real('tok_per_sec'),
    autoScore: real('auto_score'),
    checks: text('checks', { mode: 'json' }).$type<CheckResult[]>(),
    error: text('error'),
    createdAt: integer('created_at', { mode: 'number' }).notNull().default(now),
  },
  (t) => [index('case_results_run').on(t.runId)],
);

export interface CriterionScore {
  name: string;
  score: number;
  comment: string;
}

export const judgments = sqliteTable(
  'judgments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    caseResultId: integer('case_result_id')
      .notNull()
      .references(() => caseResults.id, { onDelete: 'cascade' }),
    judge: text('judge').notNull(),
    judgeModel: text('judge_model').notNull(),
    rubricVersion: text('rubric_version').notNull(),
    /** hash of (rubric, judge model, prompt, response): identical inputs reuse the judgment */
    cacheKey: text('cache_key').notNull(),
    score: real('score'),
    criteria: text('criteria', { mode: 'json' }).$type<CriterionScore[]>(),
    rationale: text('rationale'),
    latencyMs: real('latency_ms'),
    cached: integer('cached', { mode: 'boolean' }).notNull().default(false),
    error: text('error'),
    /**
     * The verdict was re-asked without the attached files: with them, the judge returned a "flat" verdict (every
     * criterion the same mid-scale score), a known Gemini failure on image tests. Scored against the reference only.
     */
    withoutAttachments: integer('without_attachments', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'number' }).notNull().default(now),
  },
  (t) => [index('judgments_case').on(t.caseResultId), index('judgments_cache').on(t.cacheKey)],
);

export type Model = typeof models.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Batch = typeof batches.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type CaseResult = typeof caseResults.$inferSelect;
export type Judgment = typeof judgments.$inferSelect;
