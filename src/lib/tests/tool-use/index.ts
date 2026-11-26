import 'server-only';
import { isStepCount } from 'ai';
import type { TestDefinition, BaseCase, CaseOutput } from '../types';
import type { CheckResult } from '@/db/schema';
import { readCases } from '../fixtures';
import { runStream, toCaseOutput, type ToolTraceEntry } from '../generate';
import { runCheck, type CheckSpec } from '../checks';
import { compareObjects } from '../compare';
import { benchmarkTools, toolCatalog } from './tools';

interface ExpectedCall {
  tool: string;
  args?: Record<string, unknown>;
}

export interface ToolCase extends BaseCase {
  prompt: string;
  expectCalls: ExpectedCall[];
  expectNoTools?: boolean;
  maxSteps?: number;
  answerChecks: CheckSpec[];
  reference: string;
}

export interface ToolData {
  trace: ToolTraceEntry[];
  steps: number;
}

const MAX_STEPS = 8;

export const toolUseSystem = (langName: string) =>
  `You are an assistant for an international tax office. Use the available tools whenever they are needed to answer accurately; do not guess data that a tool can provide, and do not call tools that are not needed. Base your final answer only on tool results and well-known facts. Answer in ${langName}.`;

function argsMatch(expected: Record<string, unknown> | undefined, actual: unknown): boolean {
  if (!expected) return true;
  const r = compareObjects(expected, actual ?? {});
  return r.matched === r.total;
}

export function formatTrace(trace: ToolTraceEntry[]): string {
  if (!trace.length) return '(no tool calls)';
  return trace
    .map(
      (t, i) =>
        `${i + 1}. [step ${t.step}] ${t.toolName}(${JSON.stringify(t.input)}) → ${t.error ? `ERROR ${t.error}` : JSON.stringify(t.output)?.slice(0, 600)}`,
    )
    .join('\n');
}

export const toolUse: TestDefinition<ToolCase> = {
  id: 'tool-use',
  name: 'Tool use',
  description:
    'Agentic tool calling over the FFI list and refund rules: single/parallel calls, multi-step chains, calculations, missing records, restraint.',
  version: '1',
  requires: ['completion', 'tools'],
  numCtx: 16384,
  rubric: {
    version: 'tu-1',
    instructions:
      'The candidate is an agent with tools. You see the tool calls it made (with results) and its final answer. Judge whether it used the right tools with correct arguments, avoided unnecessary calls, and whether the final answer is correct, complete and grounded in the tool results. Inventing data that a tool should have provided, or contradicting tool results, is severe. If no tool was needed, any tool call is a mild penalty.',
    criteria: [
      { name: 'Tool selection', description: 'Calls the right tools (and only those), in a sensible order.' },
      { name: 'Arguments', description: 'Arguments are correct and well-formed (e.g. English country names, exact GIINs, ISO dates).' },
      { name: 'Answer correctness', description: 'Final answer is correct and complete with respect to the reference.' },
      { name: 'Grounding & honesty', description: 'Answer follows from tool results; missing data is reported, not invented.' },
      { name: 'Language & clarity', description: 'Clear answer in the required language.' },
    ],
  },
  loadCases: (lang) => readCases<ToolCase>('tool-use', lang),

  async run(ctx, c) {
    const r = await runStream(ctx, {
      system: toolUseSystem(ctx.lang.englishName),
      prompt: c.prompt,
      tools: benchmarkTools(),
      stopWhen: isStepCount(MAX_STEPS),
      maxOutputTokens: 2048,
    });
    return { ...toCaseOutput(r), data: { trace: r.toolTrace, steps: r.steps } satisfies ToolData };
  },

  check(c, out, lang) {
    const d = out.data as ToolData;
    const checks: CheckResult[] = [];
    const used = new Set<number>();
    for (const e of c.expectCalls) {
      const idx = d.trace.findIndex((t, i) => !used.has(i) && t.toolName === e.tool && argsMatch(e.args, t.input));
      if (idx >= 0) used.add(idx);
      const sameTool = d.trace.filter((t) => t.toolName === e.tool);
      checks.push({
        name: `calls ${e.tool}${e.args ? `(${Object.values(e.args).join(', ')})` : ''}`,
        pass: idx >= 0,
        detail:
          idx >= 0 ? undefined : sameTool.length ? `called with ${sameTool.map((t) => JSON.stringify(t.input)).join(' / ')}` : 'not called',
      });
    }
    if (c.expectNoTools)
      checks.push({ name: 'no tool calls', pass: d.trace.length === 0, detail: d.trace.length ? `${d.trace.length} calls` : undefined });
    else {
      const extra = d.trace.length - used.size;
      checks.push({ name: 'no redundant calls', pass: extra <= 1, detail: extra > 0 ? `${extra} extra call(s)` : undefined });
    }
    if (c.maxSteps) checks.push({ name: `≤ ${c.maxSteps} steps`, pass: d.steps <= c.maxSteps, detail: `${d.steps} steps` });
    const errors = d.trace.filter((t) => t.error).length;
    if (errors) checks.push({ name: 'no tool errors', pass: false, detail: `${errors} failed call(s)` });
    checks.push({ name: 'non-empty final answer', pass: out.output.trim().length > 0 });
    for (const s of c.answerChecks) checks.push(runCheck(s, out.output, lang));
    return checks;
  },

  judgeMaterial: (c, out: CaseOutput, lang) => {
    const d = out.data as ToolData;
    return {
      task: `${c.title}: answer the user's request using the available tools as needed.`,
      input: `System: ${toolUseSystem(lang.englishName)}\n\nAvailable tools:\n${toolCatalog()}\n\nUser: ${c.prompt}`,
      reference: c.reference,
      response: `Tool calls:\n${formatTrace(d.trace)}\n\nFinal answer:\n${out.output || '(empty)'}`,
    };
  },
};
