import 'server-only';
import path from 'node:path';
import { isStepCount, type ToolSet } from 'ai';
import { createMCPClient, mcpAppClientCapabilities, splitMCPAppTools, readMCPAppResource, fingerprintMCPAppResource } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import type { TestDefinition, CaseOutput } from '../types';
import { readCases } from '../fixtures';
import { runStream, toCaseOutput } from '../generate';
import { toolUse, toolUseSystem, formatTrace, type ToolCase, type ToolData } from '../tool-use';

/**
 * The tool-use cases, with the tools served by a local MCP server (scripts/mcp/benchmark-server.mjs) through
 * @ai-sdk/mcp instead of native AI SDK tools, so MCP and native scores are directly comparable. Adds MCP Apps cases:
 * the client connects with mcpAppClientCapabilities and gives the model only splitMCPAppTools(...).modelVisible, so
 * the app-only refreshDashboardData tool must never reach the model.
 */

const MAX_STEPS = 8;
const SERVER = path.join(process.cwd(), 'scripts', 'mcp', 'benchmark-server.mjs');
const DASHBOARD_URI = 'ui://benchmark/dashboard';

type MCPClient = Awaited<ReturnType<typeof createMCPClient>>;
interface Shared {
  client: MCPClient;
  tools: ToolSet;
  catalog: string;
}

export const mcp: TestDefinition<ToolCase> = {
  id: 'mcp',
  name: 'MCP tools (@ai-sdk/mcp)',
  description:
    'The tool-use cases with tools served over MCP (stdio server, @ai-sdk/mcp client): compare with native tool calling. Plus MCP Apps: only model-visible tools reach the model, a ui:// dashboard tool, an app-only tool that must stay hidden.',
  version: '1',
  requires: ['completion', 'tools'],
  casesFrom: 'tool-use',
  numCtx: 16384,
  rubric: { ...toolUse.rubric, version: 'mcp-1' },
  loadCases: (lang) => [...toolUse.loadCases(lang), ...readCases<ToolCase>('mcp', lang)],

  async prepare() {
    const t0 = performance.now();
    const client = await createMCPClient({
      transport: new Experimental_StdioMCPTransport({ command: process.execPath, args: [SERVER], cwd: process.cwd() }),
      clientName: 'ollama-benchmark',
      capabilities: mcpAppClientCapabilities,
    });
    try {
      const connectMs = performance.now() - t0;
      const defs = await client.listTools();
      const { modelVisible, appVisible } = splitMCPAppTools(defs);
      const appOnly = appVisible.tools.filter((t) => !modelVisible.tools.some((m) => m.name === t.name)).map((t) => t.name);
      const tools = client.toolsFromDefinitions(modelVisible) as ToolSet;
      if (appOnly.some((n) => n in tools)) throw new Error(`app-only tool exposed to the model: ${appOnly.join(', ')}`);
      const ui = await readMCPAppResource({ client, uri: DASHBOARD_URI });
      const catalog = modelVisible.tools.map((t) => `- ${t.name}: ${t.description ?? ''}`).join('\n');
      return {
        shared: { client, tools, catalog } satisfies Shared,
        stats: {
          server: `${client.serverInfo.name} ${client.serverInfo.version}`,
          connectMs: Math.round(connectMs),
          modelTools: modelVisible.tools.length,
          appOnlyTools: appOnly.join(',') || 'none',
          uiResource: `${ui.html.length} chars · ${(await fingerprintMCPAppResource(ui)).slice(0, 12)}`,
        },
      };
    } catch (e) {
      await client.close().catch(() => {});
      throw e;
    }
  },

  async cleanup(shared) {
    await (shared as Shared | undefined)?.client.close();
  },

  async run(ctx, c) {
    const { tools } = ctx.shared as Shared;
    const r = await runStream(ctx, {
      system: toolUseSystem(ctx.lang.englishName),
      prompt: c.prompt,
      tools,
      stopWhen: isStepCount(MAX_STEPS),
      maxOutputTokens: 2048,
    });
    return { ...toCaseOutput(r), data: { trace: r.toolTrace, steps: r.steps } satisfies ToolData };
  },

  check: (c, out, lang) => toolUse.check(c, out, lang),

  judgeMaterial: (c, out: CaseOutput, lang) => {
    const d = out.data as ToolData;
    return {
      task: `${c.title}: answer the user's request using the available (MCP) tools as needed.`,
      input: `System: ${toolUseSystem(lang.englishName)}\n\nAvailable tools (from the MCP server, model-visible only):\n${mcpCatalogNote}\n\nUser: ${c.prompt}`,
      reference: c.reference,
      response: `Tool calls:\n${formatTrace(d.trace)}\n\nFinal answer:\n${out.output || '(empty)'}`,
    };
  },
};

const mcpCatalogNote =
  'lookupInstitution, searchInstitutions, refundTimeline, addDays, calculator (same semantics as the native tool-use test), showDashboard (opens a ui:// dashboard of institutions by country). refreshDashboardData exists on the server but is app-only and is NOT available to the model.';
