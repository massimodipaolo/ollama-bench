/**
 * Step logging shared by the long-running CLI scripts (codeql.mts, gitleaks.mts): every line carries the clock time
 * and the time since start, and each numbered step logs its own duration.
 */

/** 850ms · 12.3s · 4m 5s */
export function fmt(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function createSteps(total: number) {
  const t0 = performance.now();
  let n = 0;
  const elapsed = () => performance.now() - t0;

  function log(msg: string) {
    const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
    console.log(`[${time} +${fmt(elapsed())}] ${msg}`);
  }

  /** Runs one numbered step and logs how long it took. */
  function step<T>(title: string, fn: () => T): T {
    n++;
    log(`▶ [${n}/${total}] ${title}`);
    const start = performance.now();
    const result = fn();
    log(`✔ [${n}/${total}] ${title} (${fmt(performance.now() - start)})`);
    return result;
  }

  return { log, step, elapsed };
}
