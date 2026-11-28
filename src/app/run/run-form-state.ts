/**
 * The /run form's logic, kept out of the component so it can be tested on its own: from what the user picked and what
 * the host offers, which tests run, which models qualify, what the context is capped at, and the request that starts
 * the run. Everything is derived from the current choices (nothing synced through effects), so a choice that stops
 * being valid (a model that can't take the newly picked test) simply drops out.
 */
import { getCapability, type CapabilityDef } from '@/config/capabilities';

export interface TestSummary {
  id: string;
  name: string;
  description: string;
  requires: string[];
  requiresAny: string[];
  judged: boolean;
  cliOnly: boolean;
  languages: string[];
  numCtx: number;
  options: { id: string; label: string; description?: string; choices: { value: string; label: string }[]; default: string }[];
  caseCounts: Record<string, { quick: number; full: number }>;
}
export interface ModelInfo {
  name: string;
  parameterSize: string;
  quantization: string;
  capabilities: string[];
  contextLength: number | null;
}
export interface Meta {
  tests: TestSummary[];
  languages: { code: string; name: string }[];
  judges: { id: string; label: string; modelId: string }[];
}
export type Mode = 'test' | 'capability';

export const fmtCtx = (n: number | null | undefined) => (n == null ? '?' : n >= 1024 ? `${Math.round(n / 1024)}k` : String(n));

/** The model has every capability the test requires, and one of its "any of" ones. */
export const fits = (t: Pick<TestSummary, 'requires' | 'requiresAny'>, m: Pick<ModelInfo, 'capabilities'>) =>
  t.requires.every((c) => m.capabilities.includes(c)) && (!t.requiresAny.length || t.requiresAny.some((c) => m.capabilities.includes(c)));

export interface RunFormChoices {
  mode: Mode;
  testId: string;
  capId: string;
  /** tests the user unchecked, per capability (everything is checked by default) */
  unchecked: Record<string, string[]>;
  lang: string;
  modelA: string;
  modelB: string;
  subset: 'quick' | 'full';
  think: boolean;
  temperature: number;
  seed: number;
  numCtx: number | '';
  judges: string[];
  extra: Record<string, string>;
}

export function deriveRunForm(meta: Meta | null, models: ModelInfo[], c: RunFormChoices) {
  // CLI-only tests (hours per model) can't be started here, even from a ?test= link
  const test = meta?.tests.find((t) => t.id === c.testId && !t.cliOnly);
  const cap = getCapability(c.capId) as CapabilityDef;
  const capTests = cap.tests.map((id) => meta?.tests.find((t) => t.id === id)).filter((t): t is TestSummary => !!t);

  // language: the test's languages, or (capability) any language at least one of its tests has cases in
  const langsAvailable = c.mode === 'test' ? (test?.languages ?? []) : [...new Set(capTests.flatMap((t) => t.languages))];
  const effLang = langsAvailable.includes(c.lang) ? c.lang : (langsAvailable[0] ?? 'en');
  const checked = capTests.filter((t) => !t.cliOnly && t.languages.includes(effLang) && !(c.unchecked[c.capId] ?? []).includes(t.id));
  const runTests = c.mode === 'test' ? (test ? [test] : []) : checked;

  const eligible = runTests.length ? models.filter((m) => runTests.every((t) => fits(t, m))) : [];
  // keep selections valid when the test changes
  const effA = eligible.some((m) => m.name === c.modelA) ? c.modelA : '';
  const effB = eligible.some((m) => m.name === c.modelB) ? c.modelB : '';
  const selected = [effA, effB].filter(Boolean);
  const ctxs = selected
    .map((n) => models.find((m) => m.name === n)?.contextLength)
    .filter((x): x is number => typeof x === 'number' && x > 0);
  const maxCtx = ctxs.length ? Math.min(...ctxs) : null;
  const effExtra: Record<string, string> = Object.fromEntries(
    (test?.options ?? []).map((o) => [o.id, o.choices.some((ch) => ch.value === c.extra[o.id]) ? c.extra[o.id] : o.default]),
  );
  const canThink = selected.length > 0 && selected.every((n) => models.find((m) => m.name === n)?.capabilities.includes('thinking'));
  const anyJudged = runTests.some((t) => t.judged);
  const totalCases = runTests.reduce((a, t) => a + (t.caseCounts[effLang]?.[c.subset] ?? 0), 0) * Math.max(1, selected.length);
  const defaultCtx = c.mode === 'test' ? test?.numCtx : undefined;

  return {
    test,
    cap,
    capTests,
    langsAvailable,
    effLang,
    checked,
    runTests,
    eligible,
    effA,
    effB,
    selected,
    maxCtx,
    effExtra,
    canThink,
    anyJudged,
    totalCases,
    defaultCtx,
  };
}

export type RunFormState = ReturnType<typeof deriveRunForm>;

/** The request that starts the run: one session (POST /api/sessions) or a capability batch (POST /api/batches). */
export function startRequest(c: RunFormChoices, d: RunFormState): { url: string; body: Record<string, unknown> } {
  const config = {
    subset: c.subset,
    think: d.canThink && c.think,
    temperature: c.temperature,
    seed: c.seed,
    judges: c.judges,
    ...(c.numCtx ? { numCtx: c.numCtx } : {}),
  };
  return c.mode === 'test'
    ? { url: '/api/sessions', body: { testId: c.testId, lang: d.effLang, models: d.selected, config: { ...config, extra: d.effExtra } } }
    : {
        url: '/api/batches',
        body: { capability: c.capId, testIds: d.checked.map((t) => t.id), lang: d.effLang, models: d.selected, config },
      };
}
