import 'server-only';
import { streamText, type ModelMessage, type ToolSet, type StopCondition, type OutputInterface } from 'ai';
import { ollama } from '@/lib/providers';
import type { CaseOutput, RunContext } from './types';

export function ollamaModel(ctx: RunContext) {
  return ollama(ctx.modelName, {
    think: ctx.config.think,
    keep_alive: '15m',
    options: {
      num_ctx: ctx.config.numCtx,
      seed: ctx.config.seed,
      temperature: ctx.config.temperature,
    },
  });
}

interface OllamaMeta {
  eval_duration?: number;
}

/** A generation that failed midway (e.g. Ollama's repeat limit): keeps what was produced before the failure. */
export class GenerationError extends Error {
  constructor(
    message: string,
    readonly partialOutput: string,
  ) {
    super(message);
    this.name = 'GenerationError';
  }
}

export interface ToolTraceEntry {
  step: number;
  toolName: string;
  input: unknown;
  output?: unknown;
  error?: string;
}

export interface StreamRunResult<O = unknown> extends CaseOutput {
  /** parsed structured output when `output` was requested and parsing succeeded */
  object?: O;
  objectError?: string;
  toolTrace: ToolTraceEntry[];
  steps: number;
}

const short = (v: unknown, n = 160) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n)}…` : s;
};

/**
 * Stream from the Ollama model under test, forwarding text (and tool-call lines) to the UI, and collect
 * latency, TTFT, tokens/s (decode speed from Ollama's eval_duration, summed over steps), tool trace and
 * structured output.
 */
export async function runStream<O = unknown>(
  ctx: RunContext,
  input: {
    system?: string;
    prompt?: string;
    messages?: ModelMessage[];
    maxOutputTokens?: number;
    tools?: ToolSet;
    stopWhen?: StopCondition<ToolSet>;
    output?: OutputInterface;
  },
): Promise<StreamRunResult<O>> {
  const t0 = performance.now();
  let ttft: number | undefined;
  const toolTrace: ToolTraceEntry[] = [];
  let step = 0;

  const result = streamText({
    model: ollamaModel(ctx),
    system: input.system,
    ...(input.messages ? { messages: input.messages } : { prompt: input.prompt ?? '' }),
    maxOutputTokens: input.maxOutputTokens ?? 4096,
    temperature: ctx.config.temperature,
    seed: ctx.config.seed,
    abortSignal: ctx.signal,
    ...(input.tools ? { tools: input.tools, stopWhen: input.stopWhen } : {}),
    ...(input.output ? { output: input.output } : {}),
  });

  let partial = '';
  try {
    for await (const part of result.fullStream) {
      const first = part.type === 'text-delta' || part.type === 'reasoning-delta' || part.type === 'tool-call';
      if (first && ttft === undefined) ttft = performance.now() - t0;
      switch (part.type) {
        case 'text-delta':
          partial += part.text;
          ctx.onDelta(part.text);
          break;
        case 'start-step':
          step++;
          break;
        case 'tool-call':
          toolTrace.push({ step, toolName: part.toolName, input: part.input });
          ctx.onDelta(`\n→ ${part.toolName}(${short(part.input)})\n`);
          break;
        case 'tool-result': {
          const e = [...toolTrace].reverse().find((t) => t.toolName === part.toolName && t.output === undefined && !t.error);
          if (e) e.output = part.output;
          ctx.onDelta(`← ${short(part.output)}\n`);
          break;
        }
        case 'tool-error': {
          const e = [...toolTrace].reverse().find((t) => t.toolName === part.toolName && t.output === undefined && !t.error);
          if (e) e.error = String((part.error as Error)?.message ?? part.error);
          ctx.onDelta(`← error: ${String((part.error as Error)?.message ?? part.error)}\n`);
          break;
        }
        case 'error':
          throw part.error instanceof Error ? part.error : new Error(String(part.error));
      }
    }
  } catch (e) {
    if (e instanceof GenerationError) throw e;
    throw new GenerationError((e as Error)?.message ?? String(e), partial);
  }

  const [text, reasoning, usage, steps] = await Promise.all([result.text, result.reasoningText, result.totalUsage, result.steps]);
  let object: O | undefined;
  let objectError: string | undefined;
  if (input.output) {
    try {
      object = (await result.output) as O;
    } catch (e) {
      objectError = (e as Error).message;
    }
  }

  const latencyMs = performance.now() - t0;
  const evalNs = steps.reduce((s, st) => s + (((st.providerMetadata?.ollama ?? {}) as OllamaMeta).eval_duration ?? 0), 0);
  const out = usage.outputTokens ?? undefined;
  const tokPerSec = evalNs && out ? out / (evalNs / 1e9) : out ? out / (latencyMs / 1000) : undefined;
  // final answer = text of the last step (earlier steps' text is tool-call chatter)
  const finalText = steps.length ? (steps[steps.length - 1].text ?? text) : text;

  return {
    output: finalText,
    reasoning: reasoning || undefined,
    latencyMs,
    ttftMs: ttft,
    tokensIn: usage.inputTokens ?? undefined,
    tokensOut: out,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? undefined,
    tokPerSec,
    object,
    objectError,
    toolTrace,
    steps: steps.length,
  };
}

/** The CaseOutput part (text + metrics) of a stream result. */
export function toCaseOutput(r: StreamRunResult): CaseOutput {
  return {
    output: r.output,
    reasoning: r.reasoning,
    latencyMs: r.latencyMs,
    ttftMs: r.ttftMs,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    reasoningTokens: r.reasoningTokens,
    tokPerSec: r.tokPerSec,
  };
}

/** Helper for plain text tests. */
export async function streamWithMetrics(
  ctx: RunContext,
  input: {
    system?: string;
    prompt?: string;
    messages?: ModelMessage[];
    maxOutputTokens?: number;
  },
): Promise<CaseOutput> {
  return toCaseOutput(await runStream(ctx, input));
}
