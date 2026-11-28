import type { FilePart } from 'ai';
import type { Capability } from '@/lib/ollama';
import type { CheckResult, SessionConfig } from '@/db/schema';
import type { LanguageConfig } from '@/config/languages';

export interface BaseCase {
  id: string;
  title: string;
  /** included in the "quick" subset */
  quick?: boolean;
  /** extra capabilities this case needs (e.g. vision): models without them skip the case (not scored) */
  requires?: Capability[];
}

export interface CaseMetrics {
  latencyMs?: number;
  ttftMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  reasoningTokens?: number;
  tokPerSec?: number;
  /** wall time of the whole case: set by the runner, not by tests (see case_results.exec_ms) */
  execMs?: number;
}

export interface CaseOutput extends CaseMetrics {
  /** main textual output shown in UI and given to judges */
  output: string;
  reasoning?: string;
  /** structured, test-specific payload (tool calls, retrieved chunks, parsed object…) */
  data?: unknown;
}

export interface RunContext {
  /** who serves the model: an Ollama model under test, or a remote baseline (e.g. the Cohere reranker) */
  provider: 'ollama' | 'cohere';
  modelName: string;
  /** Ollama capabilities of the model (empty for baselines) */
  capabilities: string[];
  /** whatever the test's prepare() returned for this run (e.g. a vector index) */
  shared?: unknown;
  lang: LanguageConfig;
  config: SessionConfig;
  signal: AbortSignal;
  /** stream partial text to the UI */
  onDelta: (text: string) => void;
}

/** What judges see. Never contains model names. */
export interface JudgeMaterial {
  task: string;
  input: string;
  reference?: string;
  response: string;
  /** files the judges receive natively (images, PDFs) to check the answer against the source */
  attachments?: FilePart[];
}

export interface Rubric {
  version: string;
  /** what a perfect answer looks like for this kind of test */
  instructions: string;
  criteria: { name: string; description: string }[];
}

/** A test-specific run option shown in the run form (stored in session config.extra). */
export interface TestOption {
  id: string;
  label: string;
  description?: string;
  choices: { value: string; label: string }[];
  default: string;
}

export interface PrepareResult {
  shared?: unknown;
  /** run-level metrics shown on the run card (e.g. index build time) */
  stats?: Record<string, number | string>;
}

/** A non-Ollama model that joins every session of a test as a blind baseline. */
export interface BaselineSpec {
  provider: 'cohere';
  name: string;
  capabilities: string[];
}

export interface TestDefinition<C extends BaseCase = BaseCase> {
  id: string;
  name: string;
  description: string;
  /** bump when run/check/prompt logic changes (fixtures are hashed automatically) */
  version: string;
  /** model must have ALL of these Ollama capabilities */
  requires: Capability[];
  /** …and at least ONE of these (e.g. reranking: an embedding model or a chat model) */
  requiresAny?: Capability[];
  /** cases live in fixtures/<casesFrom>/… (shared query sets); also hashed into the suite version */
  casesFrom?: string;
  /** languages with cases, when they don't come from fixtures/<id>/cases (e.g. downloaded benchmark datasets) */
  languages?: () => string[];
  /** false: deterministic benchmark metric only, judges are not called (default true) */
  judged?: boolean;
  /**
   * started from the CLI only (pnpm bench, naming the test or its capability), not offered in the run form and skipped
   * by a plain `pnpm bench`: hours-long benchmarks, and tests that start Docker containers themselves, which the app
   * can't do when it runs in a container (no Docker client or daemon there). Run those against the app on the host.
   */
  cliOnly?: boolean;
  /** Ollama models the test loads besides the model under test (e.g. RAG's embedder): released like the model */
  helperModels?: (config: SessionConfig) => { name: string; embedding: boolean }[];
  rubric: Rubric;
  /** default num_ctx for this test */
  numCtx?: number;
  /** static list, or computed at request time (e.g. from the models available on the Ollama host) */
  options?: TestOption[] | (() => Promise<TestOption[]>);
  /** remote baselines added to every session (blind, judged like any candidate) */
  baselines?: () => BaselineSpec[];
  /** once per run, after warm-up and before the cases (timed separately) */
  prepare?: (ctx: RunContext) => Promise<PrepareResult>;
  /** once per run, after the cases (or on failure): release what prepare() opened (e.g. an MCP server process) */
  cleanup?: (shared: unknown) => Promise<void>;
  /** 'case' (default): answers must be in the case language; 'source': keep the source document's language */
  responseLanguage?: 'case' | 'source';
  loadCases(lang: string): C[];
  run(ctx: RunContext, c: C): Promise<CaseOutput>;
  check(c: C, out: CaseOutput, lang: LanguageConfig): CheckResult[];
  judgeMaterial(c: C, out: CaseOutput, lang: LanguageConfig): JudgeMaterial;
  /**
   * What the model receives for a case (the session page's "Prompt" overlay). Default: the judge material without the
   * response, which already describes the input for judged tests. Define it when that material is thinner than the
   * real prompt (unjudged benchmarks) or depends on the session's options.
   */
  promptPreview?(
    c: C,
    lang: LanguageConfig,
    extra: Record<string, unknown>,
  ): Omit<JudgeMaterial, 'response'> | Promise<Omit<JudgeMaterial, 'response'>>;
}
