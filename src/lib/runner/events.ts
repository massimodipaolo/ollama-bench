import type { CheckResult, JudgeScores } from '@/db/schema';
import type { CaseMetrics } from '@/lib/tests/types';

export type SessionEvent =
  | { type: 'session'; status: 'running' | 'judging' }
  | { type: 'run-status'; runId: number; status: 'loading' | 'running' | 'done' | 'error'; loadMs?: number; error?: string }
  | { type: 'case-start'; runId: number; caseId: string; title: string }
  | { type: 'delta'; runId: number; caseId: string; text: string }
  | {
      type: 'case-end';
      runId: number;
      caseId: string;
      caseResultId: number;
      output: string;
      reasoning?: string;
      data?: unknown;
      metrics: CaseMetrics;
      checks: CheckResult[];
      autoScore: number | null;
      error?: string;
    }
  | {
      type: 'judgment';
      runId: number;
      caseId: string;
      caseResultId: number;
      judge: string;
      score: number | null;
      rationale?: string;
      cached: boolean;
      error?: string;
      withoutAttachments?: boolean;
    }
  | { type: 'run-scores'; runId: number; autoScore: number | null; judgeScores: JudgeScores; judgeAvg: number | null }
  | { type: 'session-end'; status: 'done' | 'error' | 'cancelled'; error?: string };

interface LiveSession {
  events: SessionEvent[];
  listeners: Set<(e: SessionEvent) => void>;
  done: boolean;
  abort: AbortController;
}

const g = globalThis as unknown as { __benchLive?: Map<string, LiveSession> };
const live = (g.__benchLive ??= new Map());

export function createLive(sessionId: string): LiveSession {
  const s: LiveSession = { events: [], listeners: new Set(), done: false, abort: new AbortController() };
  live.set(sessionId, s);
  return s;
}

export function getLive(sessionId: string) {
  return live.get(sessionId);
}

export function emit(sessionId: string, e: SessionEvent) {
  const s = live.get(sessionId);
  if (!s) return;
  // merge consecutive deltas to keep the replay buffer small
  const last = s.events[s.events.length - 1];
  if (e.type === 'delta' && last?.type === 'delta' && last.runId === e.runId && last.caseId === e.caseId) last.text += e.text;
  else s.events.push(e.type === 'delta' ? { ...e } : e);
  if (e.type === 'session-end') {
    s.done = true;
    // keep the buffer around for late subscribers for a while
    setTimeout(() => live.delete(sessionId), 10 * 60_000).unref?.();
  }
  for (const l of s.listeners) l(e);
}

export function subscribe(sessionId: string, fn: (e: SessionEvent) => void): (() => void) | null {
  const s = live.get(sessionId);
  if (!s) return null;
  s.listeners.add(fn);
  return () => s.listeners.delete(fn);
}

/** Single-GPU lock: only one session generates with Ollama at a time (fair timings). */
const lockState = globalThis as unknown as { __benchOllamaLock?: Promise<void> };
export async function withOllamaLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = lockState.__benchOllamaLock ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => (release = r));
  lockState.__benchOllamaLock = prev.then(() => next);
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}
