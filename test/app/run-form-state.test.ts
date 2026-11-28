/**
 * The /run form's logic (src/app/run/run-form-state.ts): which tests run, which models qualify, the selections that
 * stay valid, the context cap, thinking, case counts, and the request that starts a session or a batch.
 */
import { describe, expect, it } from 'vitest';
import {
  deriveRunForm,
  fits,
  fmtCtx,
  startRequest,
  type Meta,
  type ModelInfo,
  type RunFormChoices,
  type TestSummary,
} from '@/app/run/run-form-state';

const t = (id: string, o: Partial<TestSummary> = {}): TestSummary => ({
  id,
  name: id,
  description: '',
  requires: ['completion'],
  requiresAny: [],
  judged: true,
  cliOnly: false,
  languages: ['en', 'it'],
  numCtx: 8192,
  options: [],
  caseCounts: { en: { quick: 4, full: 9 }, it: { quick: 3, full: 8 } },
  ...o,
});
const meta: Meta = {
  tests: [
    t('text-generation'),
    t('structured-output', {
      options: [
        {
          id: 'mode',
          label: 'Mode',
          choices: [
            { value: 'native', label: 'N' },
            { value: 'prompt', label: 'P' },
          ],
          default: 'native',
        },
      ],
    }),
    t('doc-to-markdown', { numCtx: 40960, languages: ['en'] }),
    t('rag', { judged: true }),
    t('image-recognition', { requires: ['completion', 'vision'] }),
    t('embeddings', { requires: ['embedding'], judged: false }),
    t('reranking', { requires: [], requiresAny: ['embedding', 'completion', 'rerank-llm'], judged: false }),
    t('terminal-bench', { requires: ['completion', 'tools'], cliOnly: true, languages: ['en'] }),
  ],
  languages: [
    { code: 'en', name: 'English' },
    { code: 'it', name: 'Italiano' },
  ],
  judges: [{ id: 'openai', label: 'OpenAI', modelId: 'gpt' }],
};
const m = (name: string, capabilities: string[], contextLength: number | null = 32768): ModelInfo => ({
  name,
  parameterSize: '7B',
  quantization: 'Q4',
  capabilities,
  contextLength,
});
const models = [
  m('chat:7b', ['completion', 'tools', 'thinking'], 131072),
  m('vision:7b', ['completion', 'vision'], 8192),
  m('embed:1b', ['embedding'], 512),
  m('old:7b', ['completion'], null),
];
const choices = (o: Partial<RunFormChoices> = {}): RunFormChoices => ({
  mode: 'test',
  testId: 'text-generation',
  capId: 'text',
  unchecked: {},
  lang: 'en',
  modelA: '',
  modelB: '',
  subset: 'quick',
  think: false,
  temperature: 0,
  seed: 42,
  numCtx: '',
  judges: ['openai'],
  extra: {},
  ...o,
});
const derive = (o: Partial<RunFormChoices> = {}) => deriveRunForm(meta, models, choices(o));
const names = (ms: ModelInfo[]) => ms.map((x) => x.name);

describe('helpers', () => {
  it('fits: every required capability, and one of the "any of" ones', () => {
    expect(fits({ requires: ['completion', 'vision'], requiresAny: [] }, models[1])).toBe(true);
    expect(fits({ requires: ['completion', 'vision'], requiresAny: [] }, models[0])).toBe(false);
    expect(fits({ requires: [], requiresAny: ['embedding', 'rerank-llm'] }, models[2])).toBe(true);
    expect(fits({ requires: [], requiresAny: ['rerank-llm'] }, models[2])).toBe(false);
  });

  it('fmtCtx', () => {
    expect([fmtCtx(131072), fmtCtx(512), fmtCtx(null)]).toEqual(['128k', '512', '?']);
  });
});

describe('single test', () => {
  it('only models with the test capabilities are offered', () => {
    expect(names(derive({ testId: 'image-recognition' }).eligible)).toEqual(['vision:7b']);
    expect(names(derive({ testId: 'reranking' }).eligible)).toEqual(['chat:7b', 'vision:7b', 'embed:1b', 'old:7b']);
  });

  it('a CLI-only test cannot be started here, even from a ?test= link', () => {
    const d = derive({ testId: 'terminal-bench', modelA: 'chat:7b' });
    expect(d.test).toBeUndefined();
    expect(d.eligible).toEqual([]);
    expect(d.selected).toEqual([]);
  });

  it('a selected model that cannot take the newly chosen test drops out', () => {
    const d = derive({ testId: 'image-recognition', modelA: 'vision:7b', modelB: 'chat:7b' });
    expect([d.effA, d.effB]).toEqual(['vision:7b', '']);
  });

  it('the language falls back to one the test has cases in', () => {
    expect(derive({ testId: 'doc-to-markdown', lang: 'it' }).effLang).toBe('en');
    expect(derive({ lang: 'it' }).effLang).toBe('it');
  });

  it('context: the smallest maximum among the selected models, and the test default', () => {
    expect(derive({ modelA: 'chat:7b', modelB: 'vision:7b' }).maxCtx).toBe(8192);
    expect(derive({ modelA: 'old:7b' }).maxCtx).toBeNull(); // unknown maximum
    expect(derive({ testId: 'doc-to-markdown' }).defaultCtx).toBe(40960);
  });

  it('thinking only when every selected model supports it', () => {
    expect(derive({ modelA: 'chat:7b' }).canThink).toBe(true);
    expect(derive({ modelA: 'chat:7b', modelB: 'old:7b' }).canThink).toBe(false);
    expect(derive().canThink).toBe(false);
  });

  it('options: an invalid or missing choice falls back to the default', () => {
    expect(derive({ testId: 'structured-output', extra: { mode: 'prompt' } }).effExtra).toEqual({ mode: 'prompt' });
    expect(derive({ testId: 'structured-output', extra: { mode: 'bogus' } }).effExtra).toEqual({ mode: 'native' });
  });

  it('case count: the set size for the language, times the models', () => {
    expect(derive({ modelA: 'chat:7b', modelB: 'old:7b' }).totalCases).toBe(8);
    expect(derive({ subset: 'full', lang: 'it' }).totalCases).toBe(8);
  });

  it('the request: one session with the resolved language, models, options; thinking only if allowed', () => {
    const c = choices({ testId: 'structured-output', modelA: 'old:7b', think: true, numCtx: 16384, extra: { mode: 'prompt' } });
    expect(startRequest(c, deriveRunForm(meta, models, c))).toEqual({
      url: '/api/sessions',
      body: {
        testId: 'structured-output',
        lang: 'en',
        models: ['old:7b'],
        config: { subset: 'quick', think: false, temperature: 0, seed: 42, judges: ['openai'], numCtx: 16384, extra: { mode: 'prompt' } },
      },
    });
  });
});

describe('capability batch', () => {
  it('runs every checked test of the capability; models must fit all of them', () => {
    const d = derive({ mode: 'capability', capId: 'text' });
    expect(d.runTests.map((x) => x.id)).toEqual(['text-generation', 'structured-output', 'doc-to-markdown', 'rag']);
    expect(names(d.eligible)).toEqual(['chat:7b', 'vision:7b', 'old:7b']);
    expect(d.anyJudged).toBe(true);
  });

  it('unchecking a test, or a language a test lacks, leaves it out', () => {
    expect(derive({ mode: 'capability', capId: 'text', unchecked: { text: ['rag'] } }).checked.map((x) => x.id)).not.toContain('rag');
    expect(derive({ mode: 'capability', capId: 'text', lang: 'it' }).checked.map((x) => x.id)).not.toContain('doc-to-markdown');
  });

  it('CLI-only tests never join a batch', () => {
    expect(derive({ mode: 'capability', capId: 'coding' }).checked).toEqual([]);
  });

  it('a model must fit every checked test: an embedding model qualifies for retrieval only once RAG is unchecked', () => {
    // retrieval = embeddings, reranking, RAG; RAG needs a chat model, embeddings an embedding model: nobody fits all
    expect(derive({ mode: 'capability', capId: 'retrieval' }).eligible).toEqual([]);
    expect(names(derive({ mode: 'capability', capId: 'retrieval', unchecked: { retrieval: ['rag'] } }).eligible)).toEqual(['embed:1b']);
  });

  it('the request: a batch with the checked tests and no per-test options', () => {
    const c = choices({ mode: 'capability', capId: 'retrieval', unchecked: { retrieval: ['rag'] }, modelA: 'embed:1b' });
    const d = deriveRunForm(meta, models, c);
    expect(d.checked.map((x) => x.id)).toEqual(['embeddings', 'reranking']);
    expect(startRequest(c, d)).toEqual({
      url: '/api/batches',
      body: {
        capability: 'retrieval',
        testIds: d.checked.map((x) => x.id),
        lang: 'en',
        models: ['embed:1b'],
        config: { subset: 'quick', think: false, temperature: 0, seed: 42, judges: ['openai'] },
      },
    });
  });
});
