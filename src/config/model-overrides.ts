/**
 * Corrections to the capabilities Ollama reports in /api/tags, applied when models are listed (model pickers,
 * eligibility checks, the DB). Ollama labels some model types wrongly; a wrong label makes a model selectable for
 * tests it cannot run.
 */
export interface CapabilityOverride {
  /** matched against the model name (e.g. "qllama/bge-reranker-v2-m3:latest") */
  name?: RegExp;
  /** matched against the model family from /api/tags (e.g. "bert") */
  family?: RegExp;
  add?: string[];
  remove?: string[];
  /** why: shown next to the model in the UI */
  note: string;
}

export const MODEL_OVERRIDES: CapabilityOverride[] = [
  {
    // BERT-family models are encoders (embeddings, cross-encoders): they cannot generate text
    family: /^bert$/i,
    remove: ['completion', 'tools', 'thinking', 'vision'],
    note: 'BERT encoder: cannot generate text (Ollama may list it as "completion").',
  },
  {
    // encoder cross-encoders, e.g. qllama/bge-reranker-v2-m3: Ollama 0.40 has no rerank endpoint, refuses embeddings
    // and logits for it, so it can't take any test
    name: /reranker/i,
    family: /^bert$/i,
    add: ['rerank'],
    remove: ['completion', 'embedding'],
    note: 'Cross-encoder reranker: Ollama cannot run it yet (no rerank endpoint; embeddings and logits unsupported for this model).',
  },
  {
    // decoder rerankers, e.g. Qwen3-Reranker: scored by P("yes") of the next token (logprobs) in the reranking test;
    // kept out of the chat tests (not a general chat model)
    name: /reranker/i,
    family: /^(?!bert$)/i,
    add: ['rerank-llm'],
    remove: ['completion', 'embedding', 'tools', 'thinking', 'vision'],
    note: 'LLM reranker: used only in the reranking test, scored with yes/no log-probabilities.',
  },
];

export function applyOverrides(m: { name: string; family: string; capabilities: string[] }): { capabilities: string[]; notes: string[] } {
  let caps = [...m.capabilities];
  const notes: string[] = [];
  for (const o of MODEL_OVERRIDES) {
    if (o.name && !o.name.test(m.name)) continue;
    if (o.family && !o.family.test(m.family ?? '')) continue;
    const before = caps.join(',');
    caps = caps.filter((c) => !o.remove?.includes(c));
    for (const a of o.add ?? []) if (!caps.includes(a)) caps.push(a);
    if (caps.join(',') !== before) notes.push(o.note);
  }
  return { capabilities: caps, notes };
}
