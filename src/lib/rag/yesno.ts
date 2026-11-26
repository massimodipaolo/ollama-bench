import 'server-only';
import { ollamaBaseURL, ollamaHeaders } from '@/lib/providers';

/**
 * Pointwise LLM relevance via next-token log-probabilities: score = P(yes) / (P(yes) + P(no)) for the first answer
 * token. Ollama exposes logprobs on /api/chat and /api/generate (ai-sdk-ollama 4.6.3 does not), so this calls the API
 * directly.
 *
 * - Chat models: /api/chat with a yes/no instruction, thinking off.
 * - Qwen3-Reranker builds: /api/generate raw, with the model card's exact prompt format.
 */

interface TopLogprob {
  token: string;
  logprob: number;
}
interface LogprobsResponse {
  logprobs?: { token: string; logprob: number; top_logprobs?: TopLogprob[] }[];
  error?: string;
}

export interface YesNoScore {
  score: number;
  pYes: number;
  pNo: number;
  /** neither "yes" nor "no" among the top tokens (e.g. thinking tokens, a broken model) */
  missing: boolean;
}

const TOP = 20;
const QWEN3_RERANKER_SYSTEM =
  'Judge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".';
const INSTRUCT = 'Given a question, retrieve passages of tax documentation that answer it';

function score(r: LogprobsResponse): YesNoScore {
  if (r.error) throw new Error(r.error);
  const top = r.logprobs?.[0]?.top_logprobs ?? [];
  const p = (w: string) => top.filter((t) => t.token.trim().toLowerCase() === w).reduce((s, t) => s + Math.exp(t.logprob), 0);
  const pYes = p('yes');
  const pNo = p('no');
  return { score: pYes + pNo > 0 ? pYes / (pYes + pNo) : 0, pYes, pNo, missing: pYes + pNo === 0 };
}

async function post(path: string, body: unknown, signal?: AbortSignal): Promise<LogprobsResponse> {
  const res = await fetch(`${ollamaBaseURL()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ollamaHeaders() },
    body: JSON.stringify(body),
    signal,
  });
  const j = (await res.json()) as LogprobsResponse;
  if (!res.ok) throw new Error(j.error ?? `Ollama ${path} → ${res.status}`);
  return j;
}

export async function yesNoRelevance(opts: {
  model: string;
  query: string;
  document: string;
  /** Qwen3-Reranker prompt format (raw) instead of a chat instruction */
  rerankerFormat: boolean;
  numCtx: number;
  canThink: boolean;
  signal?: AbortSignal;
}): Promise<YesNoScore> {
  const options = { num_predict: 1, temperature: 0, num_ctx: opts.numCtx };
  if (opts.rerankerFormat) {
    const prompt = `<|im_start|>system\n${QWEN3_RERANKER_SYSTEM}<|im_end|>\n<|im_start|>user\n<Instruct>: ${INSTRUCT}\n<Query>: ${opts.query}\n<Document>: ${opts.document}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;
    return score(
      await post(
        '/api/generate',
        { model: opts.model, prompt, raw: true, stream: false, logprobs: true, top_logprobs: TOP, keep_alive: '15m', options },
        opts.signal,
      ),
    );
  }
  return score(
    await post(
      '/api/chat',
      {
        model: opts.model,
        stream: false,
        ...(opts.canThink ? { think: false } : {}),
        logprobs: true,
        top_logprobs: TOP,
        keep_alive: '15m',
        options,
        messages: [
          {
            role: 'system',
            content:
              'Judge whether the Document answers the Query. The Query may be in a different language from the Document. Answer only "yes" or "no".',
          },
          { role: 'user', content: `<Query>: ${opts.query}\n<Document>: ${opts.document}` },
        ],
      },
      opts.signal,
    ),
  );
}
