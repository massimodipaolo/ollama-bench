import 'server-only';
import { and, eq } from 'drizzle-orm';
import { ollamaBaseURL, ollamaHeaders } from './providers';
import { getDb, schema } from '@/db';
import { applyOverrides } from '@/config/model-overrides';

export type Capability = 'completion' | 'vision' | 'tools' | 'thinking' | 'embedding' | 'audio' | 'insert' | 'rerank' | 'rerank-llm';

export interface OllamaModelInfo {
  name: string;
  digest: string;
  size: number;
  family: string;
  parameterSize: string;
  quantization: string;
  contextLength: number | null;
  capabilities: Capability[];
  /** capability corrections applied by src/config/model-overrides.ts */
  capabilityNotes: string[];
  modifiedAt: string;
}

async function ollamaFetch<T>(pathname: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const res = await fetch(`${ollamaBaseURL()}${pathname}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...ollamaHeaders(), ...(init?.headers ?? {}) },
    signal: init?.signal ?? AbortSignal.timeout(init?.timeoutMs ?? 15_000),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Ollama ${pathname} → ${res.status} ${await res.text().catch(() => '')}`);
  return (await res.json()) as T;
}

interface TagsResponse {
  models: {
    name: string;
    digest: string;
    size: number;
    modified_at: string;
    details: { family: string; parameter_size: string; quantization_level: string; context_length?: number };
    capabilities?: Capability[];
  }[];
}

export async function listOllamaModels(): Promise<OllamaModelInfo[]> {
  const { models } = await ollamaFetch<TagsResponse>('/api/tags');
  return models
    .map((m) => {
      const o = applyOverrides({ name: m.name, family: m.details.family, capabilities: m.capabilities ?? [] });
      return {
        name: m.name,
        digest: m.digest,
        size: m.size,
        family: m.details.family,
        parameterSize: m.details.parameter_size,
        quantization: m.details.quantization_level,
        contextLength: m.details.context_length ?? null,
        capabilities: o.capabilities as Capability[],
        capabilityNotes: o.notes,
        modifiedAt: m.modified_at,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function ollamaVersion(): Promise<string> {
  return (await ollamaFetch<{ version: string }>('/api/version')).version;
}

/** Upsert an Ollama model (keyed by name + digest) and return its DB id. */
export function upsertOllamaModel(m: OllamaModelInfo): number {
  const db = getDb();
  const existing = db
    .select({ id: schema.models.id })
    .from(schema.models)
    .where(and(eq(schema.models.provider, 'ollama'), eq(schema.models.name, m.name), eq(schema.models.digest, m.digest)))
    .get();
  if (existing) {
    db.update(schema.models).set({ lastSeen: Date.now(), capabilities: m.capabilities }).where(eq(schema.models.id, existing.id)).run();
    return existing.id;
  }
  return db
    .insert(schema.models)
    .values({
      provider: 'ollama',
      name: m.name,
      digest: m.digest,
      family: m.family,
      parameterSize: m.parameterSize,
      quantization: m.quantization,
      contextLength: m.contextLength,
      capabilities: m.capabilities,
    })
    .returning({ id: schema.models.id })
    .get().id;
}

/** Upsert a non-Ollama baseline model (e.g. Cohere reranker). */
export function upsertBaselineModel(provider: 'cohere', name: string, capabilities: string[]): number {
  const db = getDb();
  const existing = db
    .select({ id: schema.models.id })
    .from(schema.models)
    .where(and(eq(schema.models.provider, provider), eq(schema.models.name, name)))
    .get();
  if (existing) return existing.id;
  return db.insert(schema.models).values({ provider, name, capabilities }).returning({ id: schema.models.id }).get().id;
}

/**
 * Load a model into memory with the same num_ctx used by the test (otherwise Ollama reloads on the first call).
 * Returns the load time in ms as reported by Ollama.
 */
export async function warmUp(model: string, numCtx: number, embedding = false): Promise<number> {
  const t0 = Date.now();
  if (embedding) {
    await ollamaFetch('/api/embed', {
      method: 'POST',
      body: JSON.stringify({ model, input: 'warm up', keep_alive: '15m', options: { num_ctx: numCtx } }),
      timeoutMs: 600_000,
    });
    return Date.now() - t0;
  }
  // A real 1-token chat (not just a load) so the compute graph / KV cache is allocated before measuring.
  await ollamaFetch('/api/chat', {
    method: 'POST',
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Hi' }],
      stream: false,
      keep_alive: '15m',
      options: { num_ctx: numCtx, num_predict: 1 },
    }),
    timeoutMs: 600_000,
  });
  return Date.now() - t0;
}

/** Evict a model so the next one measured gets the whole GPU. */
export async function unload(model: string, embedding = false): Promise<void> {
  try {
    await ollamaFetch(embedding ? '/api/embed' : '/api/generate', {
      method: 'POST',
      body: JSON.stringify(embedding ? { model, input: '', keep_alive: 0 } : { model, keep_alive: 0 }),
      timeoutMs: 60_000,
    });
  } catch {
    /* best effort */
  }
}

export interface SyncResult {
  host: string;
  total: number;
  added: string[];
  /** names already known whose digest changed (re-pulled / re-quantized → a new version row) */
  updated: string[];
}

/** Upsert every model on the Ollama host (new pulls, new digests, capability overrides) and report what changed. */
export async function syncOllamaModels(host: string): Promise<SyncResult> {
  const db = getDb();
  const live = await listOllamaModels();
  const known = db
    .select({ name: schema.models.name, digest: schema.models.digest })
    .from(schema.models)
    .where(eq(schema.models.provider, 'ollama'))
    .all();
  const added: string[] = [];
  const updated: string[] = [];
  for (const m of live) {
    const sameName = known.filter((k) => k.name === m.name);
    if (!sameName.length) added.push(m.name);
    else if (!sameName.some((k) => k.digest === m.digest)) updated.push(m.name);
    upsertOllamaModel(m);
  }
  return { host, total: live.length, added, updated };
}

export interface HostContext {
  /** context length Ollama gives a model loaded without num_ctx (the host default, e.g. OLLAMA_CONTEXT_LENGTH) */
  defaultContext: number;
  /** model used for the probe */
  model: string;
  /** true when the result equals the probe model's own maximum (the real default may be higher) */
  cappedByModel: boolean;
  detectedAt: number;
}

const hc = globalThis as unknown as { __benchHostCtx?: HostContext };
export const cachedHostContext = () => hc.__benchHostCtx ?? null;

/**
 * Infer the host's default context: load a small completion model WITHOUT num_ctx, read the context Ollama chose
 * from /api/ps, then unload it. Ollama doesn't expose its environment, so this is the only way. Runs under the GPU
 * lock so it never overlaps a benchmark.
 */
export async function detectHostContext(): Promise<HostContext> {
  const { withOllamaLock } = await import('./runner/events');
  return withOllamaLock(async () => {
    const models = (await listOllamaModels()).filter((m) => m.capabilities.includes('completion') && m.contextLength);
    if (!models.length) throw new Error('No completion model on the host to probe with');
    // smallest model whose own maximum can't hide a large default (prefer max ≥ 256k)
    const probe = [...models].sort(
      (a, b) => Number((b.contextLength ?? 0) >= 262_144) - Number((a.contextLength ?? 0) >= 262_144) || a.size - b.size,
    )[0];
    await ollamaFetch('/api/generate', {
      method: 'POST',
      body: JSON.stringify({ model: probe.name, prompt: '', keep_alive: '30s' }),
      timeoutMs: 600_000,
    });
    const ps = await ollamaFetch<{ models: { name: string; context_length?: number }[] }>('/api/ps');
    const loaded = ps.models.find((m) => m.name === probe.name);
    await unload(probe.name);
    if (!loaded?.context_length) throw new Error(`Ollama did not report a context length for ${probe.name}`);
    const result: HostContext = {
      defaultContext: loaded.context_length,
      model: probe.name,
      cappedByModel: loaded.context_length === probe.contextLength,
      detectedAt: Date.now(),
    };
    hc.__benchHostCtx = result;
    return result;
  });
}
