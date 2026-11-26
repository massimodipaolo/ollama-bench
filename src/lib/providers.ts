import 'server-only';
import { createOllama } from 'ai-sdk-ollama';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createCohere } from '@ai-sdk/cohere';
import type { LanguageModel, generateText } from 'ai';

export type JudgeProviderOptions = NonNullable<Parameters<typeof generateText>[0]['providerOptions']>;

/** OLLAMA_HOST may be "host", "host:port" or a full URL. Normalize to http(s)://host:port */
export function ollamaBaseURL(): string {
  const raw = (process.env.OLLAMA_HOST ?? 'localhost').trim().replace(/\/+$/, '');
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  const url = new URL(withScheme);
  if (!url.port && url.protocol === 'http:') url.port = '11434';
  return url.origin;
}

export const ollama = createOllama({
  baseURL: ollamaBaseURL(),
  ...(process.env.OLLAMA_API_KEY ? { apiKey: process.env.OLLAMA_API_KEY } : {}),
});

export function ollamaHeaders(): HeadersInit {
  return process.env.OLLAMA_API_KEY ? { Authorization: `Bearer ${process.env.OLLAMA_API_KEY}` } : {};
}

export type JudgeId = 'openai' | 'google' | 'anthropic';
export const JUDGE_IDS: JudgeId[] = ['openai', 'google', 'anthropic'];

export interface Judge {
  id: JudgeId;
  label: string;
  modelId: string;
  model: LanguageModel;
  providerOptions?: JudgeProviderOptions;
}

/** Judges configured in .env (a judge without an API key or model is skipped). */
export function judges(): Judge[] {
  const out: Judge[] = [];
  const { OPENAI_API_KEY, OPENAI_MODEL, GOOGLE_GENERATIVE_AI_API_KEY, GOOGLE_MODEL, ANTHROPIC_API_KEY, ANTHROPIC_MODEL } = process.env;
  if (OPENAI_API_KEY && OPENAI_MODEL)
    out.push({ id: 'openai', label: 'OpenAI', modelId: OPENAI_MODEL, model: createOpenAI({ apiKey: OPENAI_API_KEY })(OPENAI_MODEL) });
  if (GOOGLE_GENERATIVE_AI_API_KEY && GOOGLE_MODEL)
    out.push({
      id: 'google',
      label: 'Google',
      modelId: GOOGLE_MODEL,
      model: createGoogleGenerativeAI({ apiKey: GOOGLE_GENERATIVE_AI_API_KEY })(GOOGLE_MODEL),
    });
  if (ANTHROPIC_API_KEY && ANTHROPIC_MODEL)
    out.push({
      id: 'anthropic',
      label: 'Anthropic',
      modelId: ANTHROPIC_MODEL,
      model: createAnthropic({ apiKey: ANTHROPIC_API_KEY })(ANTHROPIC_MODEL),
    });
  return out;
}

/**
 * Cohere rate limit: trial keys allow 10 calls/minute (COHERE_RPM, default 10). Await this before each call; the
 * wait is outside any measured latency.
 */
const rl = globalThis as unknown as { __cohereNext?: number; __cohereChain?: Promise<void> };
export function cohereSlot(): Promise<void> {
  const rpm = Math.max(1, Number(process.env.COHERE_RPM ?? 10));
  const gap = 60_000 / rpm + 100;
  const next = (rl.__cohereChain ?? Promise.resolve()).then(async () => {
    const wait = (rl.__cohereNext ?? 0) - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    rl.__cohereNext = Date.now() + gap;
  });
  rl.__cohereChain = next;
  return next;
}

/** Cohere reranker used as baseline in reranking / RAG tests. */
export function cohereReranker() {
  const { COHERE_API_KEY, COHERE_MODEL } = process.env;
  if (!COHERE_API_KEY || !COHERE_MODEL) return null;
  return { modelId: COHERE_MODEL, model: createCohere({ apiKey: COHERE_API_KEY }).reranking(COHERE_MODEL) };
}
