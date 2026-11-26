import 'server-only';
import { isStepCount } from 'ai';
import type { TestDefinition, BaseCase, CaseOutput } from '../types';
import type { CheckResult } from '@/db/schema';
import { readCases } from '../fixtures';
import { runStream, toCaseOutput, type ToolTraceEntry } from '../generate';
import { runCheck, type CheckSpec } from '../checks';
import { formatTrace } from '../tool-use';
import { ollama } from '@/lib/providers';

/**
 * Agentic web research with ai-sdk-ollama's built-in tools (ollama.tools.webSearch / webFetch). The tools call
 * Ollama's cloud API (https://ollama.com/api/web_search|web_fetch) with OLLAMA_API_KEY; the model deciding what to
 * search runs on the local host.
 */

/** Reference resolved at run time from an authoritative source (answers that change over time). */
type LiveReference = { type: 'npm-latest'; package: string } | { type: 'github-latest-release'; repo: string };

interface WebCase extends BaseCase {
  prompt: string;
  /** static reference answer, or a live one resolved when the run starts */
  reference?: string;
  live?: LiveReference;
  /** "search" | "fetch" | "any" (either) | "none" (restraint: no web tool needed) */
  expectTool: 'search' | 'fetch' | 'any' | 'none';
  answerChecks: CheckSpec[];
  maxSteps?: number;
}

interface WebData {
  trace: ToolTraceEntry[];
  steps: number;
  /** live reference value used for this run (e.g. "4.6.3") */
  liveValue?: string;
  toolErrors: string[];
}

const MAX_STEPS = 8;

const system = (langName: string) =>
  `You are a research assistant with web access. Use webSearch to find current or specific information and webFetch to read a page when the search snippets are not enough. Do not search for things you already know reliably. Base factual claims on what you found, mention the source URL(s) you used, and answer concisely in ${langName}.`;

async function resolveLive(ref: LiveReference, signal: AbortSignal): Promise<string> {
  if (ref.type === 'npm-latest') {
    const r = await fetch(`https://registry.npmjs.org/${ref.package}/latest`, { signal });
    if (!r.ok) throw new Error(`npm registry ${r.status}`);
    return ((await r.json()) as { version: string }).version;
  }
  const r = await fetch(`https://api.github.com/repos/${ref.repo}/releases/latest`, {
    signal,
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!r.ok) throw new Error(`GitHub API ${r.status}`);
  return ((await r.json()) as { tag_name: string }).tag_name.replace(/^v/, '');
}

// note: the result count is a tool *argument* the model picks (maxResults 1-10, default 5), not a factory option
// (ai-sdk-ollama 4.6.3: the README's webSearch({ maxResults }) is ignored / a type error)
const tools = () => ({
  webSearch: ollama.tools.webSearch(),
  webFetch: ollama.tools.webFetch({ maxContentLength: 4000 }),
});

/** Tool results carry failures as data ({ error }) as well as exceptions: collect both. */
function toolErrors(trace: ToolTraceEntry[]): string[] {
  return trace.flatMap((t) => {
    const outErr = (t.output as { error?: string } | undefined)?.error;
    return [t.error, outErr].filter((x): x is string => !!x).map((e) => `${t.toolName}: ${e.slice(0, 160)}`);
  });
}

export const webSearch: TestDefinition<WebCase> = {
  id: 'web-search',
  name: 'Web search (ai-sdk-ollama tools)',
  description:
    "Agentic research with ai-sdk-ollama's built-in webSearch/webFetch tools (Ollama cloud API): live facts checked against the npm/GitHub APIs at run time, stable published facts, and restraint when no search is needed.",
  version: '1',
  requires: ['completion', 'tools'],
  numCtx: 32768,
  rubric: {
    version: 'web-1',
    instructions:
      'The candidate is an agent with webSearch and webFetch tools. You see its tool calls (with results) and its final answer. Judge whether the answer is correct with respect to the reference (for live facts the reference was fetched at run time), grounded in what the tools returned (no invented facts or URLs), cites its sources, and whether it searched sensibly (no needless searches when the answer is common knowledge). If the tools returned errors, a candidate that says it could not verify is better than one that guesses.',
    criteria: [
      { name: 'Correctness', description: 'The answer matches the reference.' },
      { name: 'Grounding', description: 'Claims follow from the tool results; no invented facts or URLs.' },
      { name: 'Search strategy', description: 'Sensible queries, fetches when snippets are insufficient, no needless calls.' },
      { name: 'Sources & clarity', description: 'Mentions the source URL(s); concise answer in the required language.' },
    ],
  },
  loadCases: (lang) => readCases<WebCase>('web-search', lang),

  /** Preflight: one real search, so a missing key or credits fails the run up front instead of every case. */
  async prepare(ctx) {
    const t0 = performance.now();
    try {
      const exec = tools().webSearch.execute as (i: unknown, o: unknown) => Promise<unknown>;
      await exec({ query: 'ollama' }, { toolCallId: 'preflight', messages: [], abortSignal: ctx.signal });
    } catch (e) {
      throw new Error(`Ollama web search unavailable (${(e as Error).message.replace(/\s+/g, ' ').slice(0, 200)})`);
    }
    return { stats: { preflightMs: Math.round(performance.now() - t0) } };
  },

  async run(ctx, c) {
    let liveValue: string | undefined;
    if (c.live) liveValue = await resolveLive(c.live, ctx.signal);
    const r = await runStream(ctx, {
      system: system(ctx.lang.englishName),
      prompt: c.prompt,
      tools: tools(),
      stopWhen: isStepCount(c.maxSteps ?? MAX_STEPS),
      maxOutputTokens: 2048,
    });
    const data: WebData = { trace: r.toolTrace, steps: r.steps, liveValue, toolErrors: toolErrors(r.toolTrace) };
    return { ...toCaseOutput(r), data };
  },

  check(c, out, lang) {
    const d = out.data as WebData;
    const checks: CheckResult[] = [];
    const used = (n: string) => d.trace.some((t) => t.toolName === n);
    if (c.expectTool === 'none')
      checks.push({
        name: 'no web tools needed',
        pass: d.trace.length === 0,
        detail: d.trace.length ? `${d.trace.length} calls` : undefined,
      });
    if (c.expectTool === 'search') checks.push({ name: 'uses webSearch', pass: used('webSearch') });
    if (c.expectTool === 'fetch') checks.push({ name: 'uses webFetch', pass: used('webFetch') });
    if (c.expectTool === 'any') checks.push({ name: 'uses a web tool', pass: used('webSearch') || used('webFetch') });
    if (c.expectTool !== 'none')
      checks.push({ name: 'mentions a source URL', pass: /https?:\/\/\S+|\b[\w-]+\.(?:com|org|gov|io|dev)\b/i.test(out.output) });
    if (d.toolErrors.length) checks.push({ name: 'no tool errors', pass: false, detail: d.toolErrors.slice(0, 2).join(' | ') });
    if (d.liveValue) checks.push({ name: `answer = ${d.liveValue} (live)`, pass: out.output.includes(d.liveValue) });
    for (const s of c.answerChecks) checks.push(runCheck(s, out.output, lang));
    return checks;
  },

  judgeMaterial: (c, out: CaseOutput, lang) => {
    const d = out.data as WebData;
    return {
      task: `${c.title}: answer using the web tools when needed.`,
      input: `System: ${system(lang.englishName)}\n\nUser: ${c.prompt}`,
      reference: [c.reference, d.liveValue ? `Live value fetched when the run started: ${d.liveValue}` : ''].filter(Boolean).join('\n'),
      response: `Tool calls:\n${formatTrace(d.trace)}\n\nFinal answer:\n${out.output || '(empty)'}`,
    };
  },
};
