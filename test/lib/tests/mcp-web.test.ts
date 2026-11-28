/**
 * The two MCP-based tests against the fake Ollama:
 * - mcp: end to end with the real MCP server (scripts/mcp/benchmark-server.mjs, spawned over stdio as in the app),
 *   including the MCP Apps rule that an app-only tool never reaches the model;
 * - web-search: run() and scoring with stand-in search/fetch tools (its prepare() needs Docker and the live web).
 */
import { tool } from 'ai';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getLanguage } from '@/config/languages';
import { autoScore } from '@/lib/tests/checks';
import { chatReply, startFakeOllama } from '../../helpers/fake-ollama';
import { caseOf, runContext } from '../../helpers/context';

const ollama = await startFakeOllama();
process.env.OLLAMA_HOST = ollama.url;
const { mcp } = await import('@/lib/tests/mcp');
const { webSearch } = await import('@/lib/tests/web-search');

const en = getLanguage('en');
beforeEach(() => ollama.reset());
afterAll(() => ollama.close()); // file level: both describe blocks use it

describe('mcp (real MCP server)', () => {
  const { ctx } = runContext();
  let prepared: Awaited<ReturnType<NonNullable<typeof mcp.prepare>>>;
  afterAll(() => mcp.cleanup?.(prepared?.shared)); // closes the client, which stops the server process

  it('prepare connects, exposes only model-visible tools, and reads the ui:// dashboard', async () => {
    prepared = await mcp.prepare!({ ...ctx, onDelta: () => {} });
    expect(prepared.stats).toMatchObject({ server: expect.any(String), modelTools: 6, appOnlyTools: 'refreshDashboardData' });
    const tools = Object.keys((prepared.shared as { tools: object }).tools).sort();
    expect(tools).toEqual(['addDays', 'calculator', 'lookupInstitution', 'refundTimeline', 'searchInstitutions', 'showDashboard']);
  });

  it('a tool-use case runs over MCP and scores like the native test', async () => {
    const c = caseOf(mcp.loadCases('en'), 'single-lookup');
    ollama.replies.push(
      chatReply({ toolCalls: [{ name: 'lookupInstitution', arguments: { giin: '234BCD.00004.SB.132' } }] }),
      chatReply({ text: 'The institution is Sponsored Subsidiary Two - Branch, located in Cape Verdi.' }),
    );
    const out = await mcp.run({ ...ctx, shared: prepared.shared }, c);
    // the MCP server really ran the lookup: its result (from the CSV) went back to the model
    const second = ollama.calls('/api/chat')[1].body?.messages as { role: string; content: string }[];
    expect(second.find((m) => m.role === 'tool')?.content).toContain('Sponsored Subsidiary Two - Branch');
    expect(autoScore(mcp.check(c, out, en))).toBe(10);
  });

  it('the app-only tool is never offered to the model', async () => {
    const c = caseOf(mcp.loadCases('en'), 'app-only-tool-hidden');
    ollama.replies.push(chatReply({ text: 'I cannot refresh the dashboard data.' }));
    await mcp.run({ ...ctx, shared: prepared.shared }, c);
    const offered = (ollama.calls('/api/chat')[0].body?.tools as { function: { name: string } }[]).map((t) => t.function.name);
    expect(offered).toContain('showDashboard');
    expect(offered).not.toContain('refreshDashboardData');
  });
});

describe('web-search (stand-in tools)', () => {
  const searches: unknown[] = [];
  const mcpText = (text: string) => ({ content: [{ type: 'text', text }] });
  const tools = {
    search: tool({
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        searches.push(query);
        return query.includes('nothing')
          ? mcpText('No results were found for your search query.')
          : mcpText('1. IRS Form 1095-A — https://www.irs.gov/forms-pubs/about-form-1095-a — due January 31, 2027');
      },
    }),
    fetch_content: tool({ inputSchema: z.object({ url: z.string() }), execute: async () => mcpText('Page text') }),
  };
  const shared = { tools };
  const cases = webSearch.loadCases('en');

  it('searches, cites the source and answers: every check passes', async () => {
    const c = caseOf(cases, 'fact-1095a-deadline');
    ollama.replies.push(
      chatReply({ toolCalls: [{ name: 'search', arguments: { query: 'Form 1095-A deadline 2027' } }] }),
      chatReply({ text: 'Form 1095-A must be furnished by January 31, 2027 (source: https://www.irs.gov/forms-pubs/about-form-1095-a).' }),
    );
    const out = await webSearch.run({ ...runContext().ctx, shared }, c);
    expect(webSearch.check(c, out, en).filter((x) => !x.pass)).toEqual([]);
    expect(webSearch.judgeMaterial(c, out, en).response).toContain(
      'https://www.irs.gov/forms-pubs/about-form-1095-a — due January 31, 2027',
    );
  });

  it('restraint: answering common knowledge without searching passes; searching fails it', async () => {
    const c = caseOf(cases, 'restraint');
    ollama.replies.push(chatReply({ text: 'Paris.' }));
    expect(webSearch.check(c, await webSearch.run({ ...runContext().ctx, shared }, c), en).filter((x) => !x.pass)).toEqual([]);
    ollama.replies.push(
      chatReply({ toolCalls: [{ name: 'search', arguments: { query: 'capital of France' } }] }),
      chatReply({ text: 'Paris.' }),
    );
    const searched = webSearch.check(c, await webSearch.run({ ...runContext().ctx, shared }, c), en);
    expect(searched.find((x) => x.name === 'no web tools needed')).toMatchObject({ pass: false, detail: '1 calls' });
  });

  it('empty searches are infrastructure problems, shown to the judges, not model faults', async () => {
    const c = caseOf(cases, 'fact-1095a-deadline');
    ollama.replies.push(
      chatReply({ toolCalls: [{ name: 'search', arguments: { query: 'nothing here' } }] }),
      chatReply({ text: 'I could not verify it.' }),
    );
    const out = await webSearch.run({ ...runContext().ctx, shared }, c);
    expect((out.data as { toolProblems: string[] }).toolProblems).toEqual(['search: no results ({"query":"nothing here"})']);
    expect(webSearch.judgeMaterial(c, out, en).response).toContain("Tool problems (infrastructure, not the candidate's fault)");
  });

  it('a live reference is checked against the value fetched when the run started', () => {
    const c = caseOf(cases, 'live-npm-ai-sdk-ollama');
    const out = (answer: string) => ({
      output: answer,
      data: { trace: [{ step: 1, toolName: 'search', input: {} }], steps: 2, liveValue: '4.6.3', toolProblems: [] },
    });
    const live = (answer: string) => webSearch.check(c, out(answer), en).find((x) => x.name === 'answer = 4.6.3 (live)')!;
    expect(live('The latest version is 4.6.3 (npmjs.com).').pass).toBe(true);
    expect(live('The latest version is 4.5.0 (npmjs.com).').pass).toBe(false);
  });
});
