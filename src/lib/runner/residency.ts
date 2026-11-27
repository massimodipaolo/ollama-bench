import 'server-only';
import { unload } from '@/lib/ollama';

/**
 * Which Ollama models the sessions of this server still need on the GPU, so a model is unloaded as soon as nothing
 * queued needs it (instead of idling for keep_alive's 15 minutes next to the next model).
 *
 * A session is registered when it's created (queued) and removed when its GPU work ends (judging afterwards only
 * calls remote APIs). `keepLoaded` is the caller's hint that its next session uses the same model: the CLI sends
 * sessions one at a time, so the server can't see the next one yet.
 * keep_alive stays as the safety net: if the server stops mid-run, Ollama still frees the memory by itself.
 */
export interface UsedModel {
  name: string;
  /** embedding-only models are unloaded through /api/embed */
  embedding: boolean;
}
interface Entry {
  models: string[];
  helpers: string[];
  keepLoaded: boolean;
}

const g = globalThis as unknown as { __benchResidency?: Map<string, Entry> };
const pending = (g.__benchResidency ??= new Map<string, Entry>());

export function registerSession(sessionId: string, models: string[], helpers: string[], keepLoaded: boolean) {
  pending.set(sessionId, { models, helpers, keepLoaded });
}

/** Models (and helper models) that queued or running sessions of this server will use on the GPU. */
export function modelsInUse(): Set<string> {
  return new Set([...pending.values()].flatMap((e) => [...e.models, ...e.helpers]));
}

/**
 * End of a session's GPU work: unload each of `used` that no other queued session needs (and that the caller didn't
 * ask to keep), then forget the session. Returns the models unloaded.
 */
export async function releaseSession(sessionId: string, used: UsedModel[]): Promise<string[]> {
  const me = pending.get(sessionId);
  pending.delete(sessionId);
  const needed = modelsInUse();
  const released: string[] = [];
  for (const m of used) {
    if (needed.has(m.name)) continue; // a queued session uses it next: keep it warm
    if (me?.keepLoaded && me.models.includes(m.name)) continue; // the caller's next session uses it
    await unload(m.name, m.embedding);
    released.push(m.name);
  }
  return released;
}

/** Forget a session without unloading (it never reached the GPU, e.g. it failed before starting). */
export function forgetSession(sessionId: string) {
  pending.delete(sessionId);
}
