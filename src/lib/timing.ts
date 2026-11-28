/**
 * Execution times: how long the models worked, never the automatic checks or the judges (client-safe, no database
 * access).
 *
 * - a case: `case_results.exec_ms`, measured by the runner around the test's run() only;
 * - a model's run: `runs.exec_ms`, warm-up + preparation + its cases' run times. Runs recorded before it was measured
 *   fall back to start → end of the run: judges run alongside the next generation, so they were never part of it,
 *   only the (milliseconds of) automatic checks are;
 * - a session: the sum of its runs, so neither judging, which can finish long after the last generation, nor time
 *   spent queued count.
 *
 * Only completed runs get a time: an interrupted one has a finishedAt of when the next server noticed.
 */

interface TimedRun {
  status: string;
  startedAt: number | null;
  finishedAt: number | null;
  execMs?: number | null;
}

/** Execution time of a completed model run; null otherwise. */
export function runExecMs(r: TimedRun): number | null {
  if (r.status !== 'done') return null;
  if (r.execMs != null) return r.execMs;
  return r.startedAt != null && r.finishedAt != null ? r.finishedAt - r.startedAt : null;
}

/** Execution time of a finished (done or cancelled) session: the sum of its completed runs; null otherwise. */
export function sessionExecMs(s: { status: string }, runs: TimedRun[]): number | null {
  if (s.status !== 'done' && s.status !== 'cancelled') return null;
  const times = runs.map(runExecMs).filter((t): t is number => t != null);
  return times.length ? times.reduce((a, b) => a + b, 0) : null;
}
