/**
 * Contract between the app and the AI SDK stack (`ai` + `ai-sdk-ollama` + the `ollama` client): what runStream sends
 * to Ollama and what it reads back. Every test here goes through the real packages and real HTTP, against a fake
 * Ollama server (test/helpers/fake-ollama.ts). Run after updating any of them (pnpm verify): a failure here names
 * the behaviour that changed, before a benchmark run shows wrong scores or speeds.
 */
import { Output, stepCountIs, tool } from 'ai';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getLanguage } from '@/config/languages';
import type { SessionConfig } from '@/db/schema';
import type { RunContext } from '@/lib/tests/types';
import { chatReply, startFakeOllama } from '../helpers/fake-ollama';

const ollama = await startFakeOllama();
process.env.OLLAMA_HOST = ollama.url; // before the provider module reads it
const { runStream, GenerationError } = await import('@/lib/tests/generate');

afterAll(() => ollama.close());
beforeEach(() => ollama.reset());

const config: SessionConfig = { temperature: 0, seed: 42, numCtx: 8192, think: false, subset: 'quick', judges: [] };

function context(over: Partial<RunContext> = {}) {
  const deltas: string[] = [];
  const ctx: RunContext = {
    provider: 'ollama',
    modelName: 'fake-model:7b',
    capabilities: ['completion', 'tools'],
    lang: getLanguage('en'),
    config,
    signal: new AbortController().signal,
    onDelta: (t) => deltas.push(t),
    ...over,
  };
  return { ctx, deltas };
}

const chatRequests = () => ollama.calls('/api/chat');

describe('plain generation', () => {
  it('streams the text and reads usage and decode speed from Ollama', async () => {
    ollama.replies.push(chatReply({ text: 'Hello from the model', pieces: 4, promptEvalCount: 12, evalCount: 20, evalDurationMs: 500 }));
    const { ctx, deltas } = context();
    const r = await runStream(ctx, { system: 'Be brief.', prompt: 'Say hello' });

    expect(r.output).toBe('Hello from the model');
    expect(deltas.join('')).toBe('Hello from the model'); // every delta reached the UI
    expect(deltas.length).toBeGreaterThan(1); // streamed, not delivered at once
    expect(r).toMatchObject({ tokensIn: 12, tokensOut: 20, steps: 1 });
    expect(r.tokPerSec).toBeCloseTo(40); // 20 tokens / 0.5 s of eval_duration (decode only, not wall time)
    expect(r.ttftMs).toBeGreaterThanOrEqual(0);
    expect(r.latencyMs).toBeGreaterThanOrEqual(r.ttftMs!);
  });

  it('sends the session settings to Ollama: model, num_ctx, seed, temperature, keep_alive, think, streaming', async () => {
    const { ctx } = context();
    await runStream(ctx, { system: 'S', prompt: 'P' });
    const [req] = chatRequests();
    expect(req.body).toMatchObject({
      model: 'fake-model:7b',
      stream: true,
      keep_alive: '15m',
      options: expect.objectContaining({ num_ctx: 8192, seed: 42, temperature: 0 }),
    });
    expect(req.body?.think).toBeFalsy();
    expect(req.body?.messages).toEqual([{ role: 'system', content: 'S' }, expect.objectContaining({ role: 'user', content: 'P' })]);
  });

  it('thinking models: think is sent, the reasoning comes back separately from the answer', async () => {
    ollama.replies.push(chatReply({ thinking: 'Let me add 2 and 2.', text: '4' }));
    const { ctx } = context({ config: { ...config, think: true } });
    const r = await runStream(ctx, { prompt: '2+2?' });
    expect(chatRequests()[0].body?.think).toBe(true);
    expect(r.reasoning).toBe('Let me add 2 and 2.');
    expect(r.output).toBe('4');
  });
});

describe('tool calling', () => {
  const tools = {
    add: tool({
      description: 'Add two numbers',
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => a + b,
    }),
  };

  it('runs the loop: tool call → execution → result back to the model → final answer', async () => {
    ollama.replies.push(
      chatReply({ toolCalls: [{ name: 'add', arguments: { a: 2, b: 3 } }], evalCount: 10, evalDurationMs: 250 }),
      chatReply({ text: 'The sum is 5.', evalCount: 10, evalDurationMs: 250 }),
    );
    const { ctx, deltas } = context();
    const r = await runStream(ctx, { prompt: 'What is 2+3?', tools, stopWhen: stepCountIs(4) });

    expect(r.toolTrace).toEqual([{ step: 1, toolName: 'add', input: { a: 2, b: 3 }, output: 5 }]);
    expect(r.steps).toBe(2);
    expect(r.output).toBe('The sum is 5.'); // the last step's text, not the tool-call chatter
    expect(r.tokensOut).toBe(20); // usage summed over steps
    expect(r.tokPerSec).toBeCloseTo(40); // 20 tokens / (0.25 + 0.25 s): eval_duration summed over steps
    expect(deltas.join('')).toContain('→ add(');

    const [first, second] = chatRequests();
    expect(first.body?.tools).toEqual([expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'add' }) })]);
    // the tool's result goes back as a tool message in the second request
    expect(second.body?.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: 'tool', content: expect.stringContaining('5') })]),
    );
  });

  it('a failing tool is recorded as an error and the model still answers', async () => {
    ollama.replies.push(chatReply({ toolCalls: [{ name: 'boom', arguments: {} }] }), chatReply({ text: 'Sorry.' }));
    const failing = {
      boom: tool({
        inputSchema: z.object({}),
        execute: async (): Promise<string> => {
          throw new Error('service down');
        },
      }),
    };
    const { ctx } = context();
    const r = await runStream(ctx, { prompt: 'x', tools: failing, stopWhen: stepCountIs(3) });
    expect(r.toolTrace).toEqual([expect.objectContaining({ toolName: 'boom', error: 'service down' })]);
    expect(r.output).toBe('Sorry.');
  });
});

describe('structured output', () => {
  const schema = z.object({ city: z.string(), population: z.number() });

  it('sends the JSON schema as Ollama format and parses the answer', async () => {
    ollama.replies.push(chatReply({ text: '{"city":"Rome","population":2800000}' }));
    const { ctx } = context();
    const r = await runStream<z.infer<typeof schema>>(ctx, { prompt: 'Biggest Italian city?', output: Output.object({ schema }) });
    expect(r.object).toEqual({ city: 'Rome', population: 2800000 });
    expect(r.objectError).toBeUndefined();
    expect(chatRequests()[0].body?.format).toMatchObject({
      type: 'object',
      properties: { city: expect.anything(), population: expect.anything() },
    });
  });

  it('an answer that does not fit the schema is reported, not thrown', async () => {
    ollama.replies.push(chatReply({ text: '{"city":"Rome"}' }));
    const { ctx } = context();
    const r = await runStream(ctx, { prompt: 'x', output: Output.object({ schema }) });
    expect(r.object).toBeUndefined();
    expect(r.objectError).toBeTruthy();
    expect(r.output).toBe('{"city":"Rome"}');
  });
});

describe('failures', () => {
  it('an Ollama error mid-stream keeps what was generated before it', async () => {
    ollama.replies.push(chatReply({ text: 'partial answer', pieces: 3, errorAfterText: 'repeat limit reached' }));
    const { ctx } = context();
    const err = await runStream(ctx, { prompt: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(GenerationError);
    expect(err.message).toMatch(/repeat limit/);
    // a prefix of the answer: when the stream errors, chunks already received but not yet read are discarded
    // (WHATWG streams). Here the reply arrives in one burst, so the last piece is lost; over a real network, less.
    expect(err.partialOutput.length).toBeGreaterThan(0);
    expect('partial answer'.startsWith(err.partialOutput)).toBe(true);
  });

  it('a cancelled session aborts the generation (the AI SDK AbortError, recorded by the runner as the case error)', async () => {
    const abort = new AbortController();
    abort.abort();
    const { ctx } = context({ signal: abort.signal });
    await expect(runStream(ctx, { prompt: 'x' })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
