import 'server-only';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isStepCount, type ToolSet } from 'ai';
import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import type { TestDefinition, BaseCase, CaseOutput } from '../types';
import type { CheckResult } from '@/db/schema';
import { readCases } from '../fixtures';
import { runStream, toCaseOutput, type ToolTraceEntry } from '../generate';
import { runCheck, type CheckSpec } from '../checks';
import { docker } from '../polyglot/sandbox';
import { containerLabel } from '@/lib/runner/instance';

/**
 * Agentic web research through an MCP server: DuckDuckGo search + page fetch (Docker's mcp/duckduckgo, see
 * docker/duckduckgo/Dockerfile), connected with @ai-sdk/mcp over stdio. Live facts are checked against the npm /
 * GitHub APIs at run time. Results come from the live web, so scores can move with search rankings and page changes.
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
  /** infrastructure problems (tool errors, searches blocked/empty): shown to judges, not scored as model faults */
  toolProblems: string[];
}

const MAX_STEPS = 8;
const SEARCH = 'search';
const FETCH = 'fetch_content';
const DOCKERFILE = path.join(process.cwd(), 'docker', 'duckduckgo', 'Dockerfile');
const NO_RESULTS = /^No results were found/;

const system = (langName: string) =>
  `You are a research assistant with web access. Use the ${SEARCH} tool to find current or specific information and ${FETCH} to read a page when the search snippets are not enough. Do not search for things you already know reliably. Base factual claims on what you found, mention the source URL(s) you used, and answer concisely in ${langName}.`;

/** Image tag follows the Dockerfile, so any change to it builds a new image. */
const imageTag = () =>
  `ollama-bench-duckduckgo:${crypto.createHash('sha1').update(fs.readFileSync(DOCKERFILE)).digest('hex').slice(0, 12)}`;

async function ensureImage(tag: string) {
  if ((await docker(['image', 'inspect', tag], { timeoutMs: 30_000 })).code === 0) return;
  const r = await docker(['build', '-q', '-t', tag, path.dirname(DOCKERFILE)], { timeoutMs: 15 * 60_000 });
  if (r.code !== 0) throw new Error(`building ${tag} failed: ${r.out.trim().split('\n').slice(-3).join(' ')}`);
}

/** The text of an MCP tool result ({ content: [{ type: 'text', text }], isError }). */
function resultText(output: unknown): { text: string; isError: boolean } {
  const o = output as { content?: { type?: string; text?: string }[]; isError?: boolean } | undefined;
  const text =
    (o?.content ?? []).map((c) => c.text ?? '').join('\n') || (typeof output === 'string' ? output : JSON.stringify(output ?? ''));
  return { text, isError: !!o?.isError };
}

function toolProblems(trace: ToolTraceEntry[]): string[] {
  return trace.flatMap((t) => {
    if (t.error) return [`${t.toolName}: ${t.error.slice(0, 160)}`];
    const r = resultText(t.output);
    if (r.isError) return [`${t.toolName}: ${r.text.slice(0, 160)}`];
    if (t.toolName === SEARCH && NO_RESULTS.test(r.text)) return [`${SEARCH}: no results (${JSON.stringify(t.input)})`];
    return [];
  });
}

/** Tool calls as judges read them: plain result text, not MCP envelopes. */
function formatWebTrace(trace: ToolTraceEntry[]): string {
  if (!trace.length) return '(no tool calls)';
  return trace
    .map((t, i) => {
      const out = t.error ? `ERROR ${t.error}` : resultText(t.output).text;
      return `${i + 1}. [step ${t.step}] ${t.toolName}(${JSON.stringify(t.input)}) →\n${out.slice(0, 1200)}${out.length > 1200 ? ' …' : ''}`;
    })
    .join('\n\n');
}

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

type MCPClient = Awaited<ReturnType<typeof createMCPClient>>;
interface Shared {
  client: MCPClient;
  tools: ToolSet;
}

export const webSearch: TestDefinition<WebCase> = {
  id: 'web-search',
  name: 'Web search (MCP · DuckDuckGo)',
  description:
    'Agentic research with a DuckDuckGo MCP server (search + fetch_content, Docker): live facts checked against the npm/GitHub APIs at run time, stable published facts, and restraint when no search is needed. Live web: results can vary between runs.',
  // v2: DuckDuckGo MCP server instead of ai-sdk-ollama's webSearch/webFetch (Ollama cloud API, no longer free)
  version: '2',
  requires: ['completion', 'tools'],
  numCtx: 32768,
  rubric: {
    version: 'web-2',
    instructions: `The candidate is an agent with two web tools: ${SEARCH} (DuckDuckGo results) and ${FETCH} (reads a page). You see its tool calls (with results) and its final answer. Judge whether the answer is correct with respect to the reference (for live facts the reference was fetched at run time), grounded in what the tools returned (no invented facts or URLs), cites its sources, and whether it searched sensibly (no needless searches when the answer is common knowledge). Search results come from the live web: if the tools returned errors or no results, a candidate that says it could not verify is better than one that guesses.`,
    criteria: [
      { name: 'Correctness', description: 'The answer matches the reference.' },
      { name: 'Grounding', description: 'Claims follow from the tool results; no invented facts or URLs.' },
      { name: 'Search strategy', description: 'Sensible queries, fetches when snippets are insufficient, no needless calls.' },
      { name: 'Sources & clarity', description: 'Mentions the source URL(s); concise answer in the required language.' },
    ],
  },
  loadCases: (lang) => readCases<WebCase>('web-search', lang),

  /**
   * One MCP server container per run (internet on, no host mounts, owner label for recovery). A preflight search
   * fails the run up front if DuckDuckGo is blocking the server, instead of every case.
   */
  async prepare(ctx) {
    const tag = imageTag();
    await ensureImage(tag);
    const t0 = performance.now();
    const name = `bench-ddg-${crypto.randomBytes(3).toString('hex')}`;
    const client = await createMCPClient({
      transport: new Experimental_StdioMCPTransport({
        command: 'docker',
        args: ['run', '-i', '--rm', '--name', name, '--memory', '512m', '--cpus', '1', ...containerLabel(), tag],
        stderr: 'ignore',
      }),
      clientName: 'ollama-benchmark',
    });
    try {
      const connectMs = performance.now() - t0;
      const defs = await client.listTools();
      const missing = [SEARCH, FETCH].filter((n) => !defs.tools.some((t) => t.name === n));
      if (missing.length) throw new Error(`the MCP server has no ${missing.join(', ')} tool`);
      const tools = client.toolsFromDefinitions(defs) as ToolSet;
      const t1 = performance.now();
      const exec = tools[SEARCH].execute as (i: unknown, o: unknown) => Promise<unknown>;
      const probe = resultText(
        await exec({ query: 'ollama', max_results: 1 }, { toolCallId: 'preflight', messages: [], abortSignal: ctx.signal }),
      );
      if (probe.isError || NO_RESULTS.test(probe.text))
        throw new Error(`DuckDuckGo search returned nothing (blocked or rate-limited?): ${probe.text.slice(0, 160)}`);
      return {
        shared: { client, tools } satisfies Shared,
        stats: {
          server: `${client.serverInfo.name} ${client.serverInfo.version}`,
          image: tag.split(':')[1],
          connectMs: Math.round(connectMs),
          preflightMs: Math.round(performance.now() - t1),
        },
      };
    } catch (e) {
      await client.close().catch(() => {});
      throw new Error(`DuckDuckGo MCP server unavailable: ${(e as Error).message.replace(/\s+/g, ' ').slice(0, 240)}`);
    }
  },

  async cleanup(shared) {
    await (shared as Shared | undefined)?.client.close();
  },

  async run(ctx, c) {
    const { tools } = ctx.shared as Shared;
    let liveValue: string | undefined;
    if (c.live) liveValue = await resolveLive(c.live, ctx.signal);
    const r = await runStream(ctx, {
      system: system(ctx.lang.englishName),
      prompt: c.prompt,
      tools,
      stopWhen: isStepCount(c.maxSteps ?? MAX_STEPS),
      maxOutputTokens: 2048,
    });
    const data: WebData = { trace: r.toolTrace, steps: r.steps, liveValue, toolProblems: toolProblems(r.toolTrace) };
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
    if (c.expectTool === 'search') checks.push({ name: `uses ${SEARCH}`, pass: used(SEARCH) });
    if (c.expectTool === 'fetch') checks.push({ name: `uses ${FETCH}`, pass: used(FETCH) });
    if (c.expectTool === 'any') checks.push({ name: 'uses a web tool', pass: used(SEARCH) || used(FETCH) });
    if (c.expectTool !== 'none')
      checks.push({ name: 'mentions a source URL', pass: /https?:\/\/\S+|\b[\w-]+\.(?:com|org|gov|io|dev|it)\b/i.test(out.output) });
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
      response: `Tool calls:\n${formatWebTrace(d.trace)}${d.toolProblems.length ? `\n\nTool problems (infrastructure, not the candidate's fault): ${d.toolProblems.join(' | ')}` : ''}\n\nFinal answer:\n${out.output || '(empty)'}`,
    };
  },
};
