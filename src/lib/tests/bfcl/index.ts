import 'server-only';
import { isStepCount, jsonSchema, tool, type ModelMessage, type ToolSet } from 'ai';
import type { TestDefinition, BaseCase } from '../types';
import { runStream, toCaseOutput, type ToolTraceEntry } from '../generate';
import { datasetCases, datasetLanguages } from '../datasets';
import { checkCalls, toJsonSchema, toolName, type BfclFunction, type GroundTruth } from './checker';

/**
 * BFCL v4 (Berkeley Function Calling Leaderboard), single-turn categories, native AI SDK tool calling.
 * Scoring = BFCL's AST checker (ported): the official metric is accuracy, so judges are not used.
 */
interface BfclCase extends BaseCase {
  category: string;
  question: { role: string; content: string }[][];
  functions: BfclFunction[];
  groundTruth: GroundTruth;
}

interface BfclData {
  category: string;
  calls: { name: string; args: Record<string, unknown> }[];
  verdict: string;
}

/** Tools without execute: the model's calls are recorded, nothing runs (BFCL scores the call itself). */
function bfclTools(fns: BfclFunction[]): ToolSet {
  return Object.fromEntries(
    fns.map((f) => [
      toolName(f.name),
      tool({ description: f.description ?? '', inputSchema: jsonSchema(toJsonSchema(f.parameters) as never) }),
    ]),
  );
}

const callsOf = (trace: ToolTraceEntry[]) => trace.map((t) => ({ name: t.toolName, args: (t.input ?? {}) as Record<string, unknown> }));

export const bfcl: TestDefinition<BfclCase> = {
  id: 'bfcl',
  name: 'BFCL (function calling)',
  description:
    'Berkeley Function Calling Leaderboard v4, single-turn: simple, multiple, parallel, parallel-multiple, irrelevance. Scored by the ported BFCL AST checker (accuracy).',
  version: '1',
  requires: ['completion', 'tools'],
  numCtx: 8192,
  judged: false,
  languages: datasetLanguages('bfcl'),
  rubric: { version: 'bfcl-1', instructions: 'Not judged: BFCL accuracy is deterministic.', criteria: [] },
  loadCases: (lang) => datasetCases<BfclCase>('bfcl', lang).map((c) => ({ ...c, title: `${c.category} · ${c.id}` })),

  async run(ctx, c) {
    const messages = (c.question[0] ?? []).map((m) => ({
      role: m.role === 'system' ? 'system' : 'user',
      content: m.content,
    })) as ModelMessage[];
    const r = await runStream(ctx, { messages, tools: bfclTools(c.functions), stopWhen: isStepCount(1), maxOutputTokens: 1024 });
    const calls = callsOf(r.toolTrace);
    const v = checkCalls(c.category, calls, c.groundTruth, c.functions);
    const output = calls.length
      ? calls.map((x) => `${x.name}(${JSON.stringify(x.args)})`).join('\n') + (r.output ? `\n\n${r.output}` : '')
      : r.output || '(no call)';
    return { ...toCaseOutput(r), output, data: { category: c.category, calls, verdict: v.detail } satisfies BfclData };
  },

  check(c, out) {
    const d = out.data as BfclData;
    const v = checkCalls(c.category, d.calls, c.groundTruth, c.functions);
    return [{ name: `BFCL ${c.category}`, pass: v.pass, detail: v.detail }];
  },

  judgeMaterial: (c, out) => ({
    task: c.title,
    input: JSON.stringify(c.question),
    reference: JSON.stringify(c.groundTruth),
    response: out.output,
  }),
};
