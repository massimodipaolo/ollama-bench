import 'server-only';
import type { TestDefinition, BaseCase, TestOption } from './types';
import { embeddings } from './embeddings';
import { reranking } from './reranking';
import { rag } from './rag';
import { webSearch } from './web-search';
import { mcp } from './mcp';
import { omnidocbench } from './omnidocbench';
import { bfcl } from './bfcl';
import { mmmuPro } from './mmmu-pro';
import { textGeneration } from './text-generation';
import { structuredOutput } from './structured-output';
import { toolUse } from './tool-use';
import { imageRecognition } from './image-recognition';
import { docToMarkdown } from './doc-to-markdown';
import { LANGUAGES } from '@/config/languages';
import { hasCases, suiteVersion } from './fixtures';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TESTS: TestDefinition<any>[] = [
  textGeneration,
  structuredOutput,
  toolUse,
  imageRecognition,
  docToMarkdown,
  embeddings,
  reranking,
  rag,
  webSearch,
  mcp,
  omnidocbench,
  bfcl,
  mmmuPro,
];

export function getTest(id: string): TestDefinition<BaseCase> {
  const t = TESTS.find((x) => x.id === id);
  if (!t) throw new Error(`Unknown test: ${id}`);
  return t;
}

export interface TestSummary {
  id: string;
  name: string;
  description: string;
  requires: string[];
  requiresAny: string[];
  languages: string[];
  judged: boolean;
  numCtx: number;
  options: TestOption[];
  /** current suite version (fixtures hash): history rows with another version are a different suite */
  suiteVersion: string;
  /** remote baselines this test adds to its sessions (e.g. the Cohere reranker) */
  baselines: string[];
  /** number of cases per language: { en: { quick, full } } */
  caseCounts: Record<string, { quick: number; full: number }>;
}

export async function testOptions(t: TestDefinition<BaseCase>): Promise<TestOption[]> {
  return typeof t.options === 'function' ? t.options() : (t.options ?? []);
}

export async function listTests(): Promise<TestSummary[]> {
  return Promise.all(
    TESTS.map(async (t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      requires: t.requires,
      requiresAny: t.requiresAny ?? [],
      languages: t.languages ? t.languages() : LANGUAGES.filter((l) => hasCases(t.casesFrom ?? t.id, l.code)).map((l) => l.code),
      judged: t.judged !== false,
      numCtx: t.numCtx ?? 8192,
      options: await testOptions(t),
      baselines: (t.baselines?.() ?? []).map((b) => `${b.provider}:${b.name}`),
      suiteVersion: suiteVersion(t.id, t.version, t.rubric.version, t.casesFrom ? [t.casesFrom] : []),
      caseCounts: Object.fromEntries(
        (t.languages
          ? LANGUAGES.filter((l) => t.languages!().includes(l.code))
          : LANGUAGES.filter((l) => hasCases(t.casesFrom ?? t.id, l.code))
        ).map((l) => {
          const cs = t.loadCases(l.code);
          const quick = cs.filter((c) => c.quick).length;
          return [l.code, { quick: quick || Math.min(5, cs.length), full: cs.length }];
        }),
      ),
    })),
  );
}

/** Can a model with these Ollama capabilities take this test? */
export function isEligible(t: Pick<TestDefinition<BaseCase>, 'requires' | 'requiresAny'>, caps: string[]): boolean {
  return t.requires.every((c) => caps.includes(c)) && (!t.requiresAny?.length || t.requiresAny.some((c) => caps.includes(c)));
}

/** Resolve test options: defaults + validated user choices. */
export async function resolveOptions(t: TestDefinition<BaseCase>, input: Record<string, unknown> = {}): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const o of await testOptions(t)) {
    const v = input[o.id];
    if (v != null && !o.choices.some((c) => c.value === v)) throw new Error(`Invalid value for option "${o.id}": ${String(v)}`);
    out[o.id] = (v as string) ?? o.default;
  }
  return out;
}

/**
 * Variant of a session for leaderboards/history: test options, plus num_ctx when it differs from the test's default
 * (a different context changes memory and speed, so those runs get their own row).
 */
export function sessionVariant(testId: string, config: { extra?: Record<string, unknown>; numCtx?: number }): string {
  const base = variantLabel(config.extra);
  const def = TESTS.find((t) => t.id === testId)?.numCtx ?? 8192;
  const ctx = config.numCtx && config.numCtx !== def ? `num_ctx=${config.numCtx}` : '';
  return [base, ctx].filter(Boolean).join(' · ');
}

/** Human-readable variant label, e.g. "mode=prompt" (empty when the test has no options). */
export function variantLabel(extra: Record<string, unknown> | undefined): string {
  return Object.entries(extra ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(' · ');
}
