/**
 * A fake Ollama server for tests: a real HTTP server on a random local port, speaking Ollama's API closely enough for
 * the real `ai-sdk-ollama` provider (and the `ollama` JS client under it) and the app's own calls (warm-up, unload,
 * /api/show, /api/ps…). It records every request, so a test can check what the app sends (num_ctx, seed, think,
 * tools, format…), and answers /api/chat from a queue of scripted replies.
 *
 * Point the app at it before importing any module that reads OLLAMA_HOST (src/lib/providers.ts reads it at import):
 *
 *   const ollama = await startFakeOllama();
 *   process.env.OLLAMA_HOST = ollama.url;
 *   const { runStream } = await import('@/lib/tests/generate');
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  /** parsed JSON body (undefined for GET) */
  body: Record<string, unknown> | undefined;
}

/** One streamed /api/chat answer: the NDJSON chunks Ollama would send, in order. */
export type ChatReply = Record<string, unknown>[];

export interface FakeOllama {
  url: string;
  /** every request received, oldest first */
  requests: RecordedRequest[];
  /** requests to one path */
  calls(path: string): RecordedRequest[];
  /** scripted /api/chat (streaming) answers, used in order; when empty, a plain "ok" answer */
  replies: ChatReply[];
  /**
   * Override an endpoint: return the JSON body to send, or throw to answer HTTP 500 with the message. Streamed
   * /api/chat always comes from `replies`; an override of /api/chat applies to the non-streamed calls (the warm-up).
   */
  routes: Record<string, (body: Record<string, unknown> | undefined) => unknown>;
  reset(): void;
  close(): Promise<void>;
}

export interface ReplySpec {
  /** answer text, streamed in `pieces` chunks */
  text?: string;
  pieces?: number;
  /** thinking (reasoning) text, streamed before the answer */
  thinking?: string;
  /** tool calls in the final chunk, as Ollama sends them */
  toolCalls?: { name: string; arguments: Record<string, unknown> }[];
  promptEvalCount?: number;
  evalCount?: number;
  /** decode time: tokens/s = evalCount / evalDurationMs */
  evalDurationMs?: number;
  doneReason?: string;
  /** an Ollama error line after the text (e.g. its repeat limit): the client throws mid-stream */
  errorAfterText?: string;
}

const msg = (m: Record<string, unknown>) => ({ model: 'fake', created_at: new Date().toISOString(), ...m });

/** The NDJSON chunks of one streamed chat answer. */
export function chatReply(spec: ReplySpec = {}): ChatReply {
  const chunks: ChatReply = [];
  if (spec.thinking) chunks.push(msg({ message: { role: 'assistant', content: '', thinking: spec.thinking }, done: false }));
  const text = spec.text ?? '';
  const n = Math.max(1, Math.min(spec.pieces ?? 3, text.length || 1));
  const size = Math.ceil(text.length / n);
  for (let i = 0; i < text.length; i += size)
    chunks.push(msg({ message: { role: 'assistant', content: text.slice(i, i + size) }, done: false }));
  if (spec.errorAfterText) {
    chunks.push({ error: spec.errorAfterText });
    return chunks;
  }
  chunks.push(
    msg({
      message: {
        role: 'assistant',
        content: '',
        ...(spec.toolCalls ? { tool_calls: spec.toolCalls.map((t) => ({ function: { name: t.name, arguments: t.arguments } })) } : {}),
      },
      done: true,
      done_reason: spec.doneReason ?? 'stop',
      total_duration: 2_000_000_000,
      load_duration: 1_000_000,
      prompt_eval_count: spec.promptEvalCount ?? 12,
      prompt_eval_duration: 100_000_000,
      eval_count: spec.evalCount ?? 20,
      eval_duration: (spec.evalDurationMs ?? 500) * 1_000_000,
    }),
  );
  return chunks;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
}

const json = (res: ServerResponse, value: unknown, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
};

/** Answers for the endpoints the app calls besides streamed chat. */
const DEFAULT_ROUTES: FakeOllama['routes'] = {
  '/api/version': () => ({ version: '0.40.0-fake' }),
  '/api/tags': () => ({ models: [] }),
  '/api/ps': () => ({ models: [] }),
  '/api/show': () => ({ model_info: {}, capabilities: ['completion'] }),
  '/api/generate': () => msg({ response: '', done: true }), // unload (keep_alive: 0)
  '/api/embed': (body) => ({ model: 'fake', embeddings: [].concat((body?.input ?? '') as never).map(() => [0.1, 0.2, 0.3]) }),
  // non-streamed chat: the warm-up's 1-token call
  '/api/chat': () =>
    msg({ message: { role: 'assistant', content: 'H' }, done: true, done_reason: 'length', eval_count: 1, eval_duration: 1_000_000 }),
};

export async function startFakeOllama(): Promise<FakeOllama> {
  const fake: FakeOllama = {
    url: '',
    requests: [],
    calls: (path) => fake.requests.filter((r) => r.path === path),
    replies: [],
    routes: {},
    reset() {
      fake.requests.length = 0;
      fake.replies.length = 0;
      fake.routes = {};
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };

  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const body = req.method === 'GET' ? undefined : await readBody(req);
    fake.requests.push({ method: req.method ?? 'GET', path, body });

    if (path === '/api/chat' && body?.stream !== false) {
      const chunks = fake.replies.shift() ?? chatReply({ text: 'ok' });
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      for (const c of chunks) res.write(`${JSON.stringify(c)}\n`);
      return res.end();
    }

    const override = fake.routes[path];
    if (override) {
      try {
        return json(res, override(body));
      } catch (e) {
        return json(res, { error: (e as Error).message }, 500);
      }
    }
    const route = DEFAULT_ROUTES[path];
    if (route) return json(res, route(body));
    json(res, { error: `fake ollama: no route for ${req.method} ${path}` }, 404);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
