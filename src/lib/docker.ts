/**
 * The docker CLI, for the tests that run things in containers (Terminal-Bench task containers, the DuckDuckGo MCP
 * server of web-search) and for the cleanup of containers left by a dead server (runner/recover.ts).
 */
import { spawn } from 'node:child_process';

export interface Exec {
  code: number | null;
  out: string;
  timedOut: boolean;
}

/**
 * Run the docker CLI; output capped (a runaway command can print forever).
 * The timeout always settles the promise: killing docker.exe alone isn't enough on Windows, where a child of the
 * CLI can keep the output pipes open and 'close' never fires (a stalled `docker exec` then hung a whole agent run).
 */
export function docker(args: string[], opts: { timeoutMs?: number; input?: string } = {}): Promise<Exec> {
  return new Promise((resolve) => {
    const p = spawn('docker', args, { windowsHide: true });
    let out = '';
    let settled = false;
    let timedOut = false;
    let t: NodeJS.Timeout | undefined;
    const finish = (code: number | null, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve({ code, out: extra ? `${out}\n${extra}` : out, timedOut });
    };
    const add = (b: Buffer) => {
      if (out.length < 2_000_000) out += b.toString('utf8');
    };
    p.stdout.on('data', add);
    p.stderr.on('data', add);
    if (opts.timeoutMs)
      t = setTimeout(() => {
        timedOut = true;
        p.kill();
        p.stdout.destroy();
        p.stderr.destroy();
        // give 'close' a moment, then settle regardless
        setTimeout(() => finish(null, `[docker ${args[0]} timed out after ${Math.round(opts.timeoutMs! / 1000)}s]`), 2000).unref();
      }, opts.timeoutMs);
    p.on('error', (e) => finish(null, e.message));
    p.on('close', (code) => finish(code));
    if (opts.input !== undefined) p.stdin.end(opts.input);
  });
}
