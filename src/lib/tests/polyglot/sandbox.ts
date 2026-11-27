/**
 * Docker sandbox for the Polyglot test. One container per run (model), started by prepare() and removed by
 * cleanup(); each test attempt gets a fresh copy of the exercise in /work/<n>.
 * Model-written code only ever runs inside the container: no network, no host mounts, capped memory/CPU/PIDs,
 * no privilege escalation, and every command under a timeout.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEST_COMMAND, TEST_TIMEOUT_S, cleanTestOutput, type PolyglotCase } from './config';

export interface Exec {
  code: number | null;
  out: string;
  timedOut: boolean;
}

/**
 * Run the docker CLI; output capped (a runaway test can print forever).
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

export async function imageExists(tag: string): Promise<boolean> {
  return (await docker(['image', 'inspect', tag], { timeoutMs: 30_000 })).code === 0;
}

/** `extra`: additional docker run arguments (the app passes its owner label, see runner/instance.ts). */
export async function startSandbox(tag: string, extra: string[] = []): Promise<string> {
  const name = `bench-polyglot-${crypto.randomBytes(4).toString('hex')}`;
  const r = await docker(
    [
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '--network',
      'none',
      '--memory',
      '6g',
      '--cpus',
      '4',
      '--pids-limit',
      '1024',
      '--security-opt',
      'no-new-privileges',
      ...extra,
      tag,
      'sleep',
      'infinity',
    ],
    { timeoutMs: 120_000 },
  );
  if (r.code !== 0) throw new Error(`could not start the sandbox (${tag}): ${r.out.trim().split('\n').pop()}`);
  return name;
}

export async function stopSandbox(name: string): Promise<void> {
  await docker(['rm', '-f', name], { timeoutMs: 60_000 });
}

/** Copy an exercise without its metadata (.meta holds the reference solution, .docs the instructions). */
function copyExercise(src: string, dst: string) {
  fs.cpSync(src, dst, {
    recursive: true,
    filter: (p) => !/[\\/](\.meta|\.docs|\.approaches|build|target|node_modules)$/.test(p),
  });
}

/**
 * Write `files` over a fresh copy of the exercise, restore the original tests (Java: without @Disabled, as Aider),
 * run the language's test command in the sandbox and report the outcome.
 */
export async function runTests(
  container: string,
  datasetDir: string,
  c: PolyglotCase,
  files: Record<string, string>,
): Promise<{ pass: boolean; output: string; timedOut: boolean; ms: number }> {
  const exDir = path.join(datasetDir, c.dir);
  // the folder keeps the exercise's own name: C++ CMakeLists.txt derives the test file name from it
  const name = path.posix.basename(c.dir);
  const n = crypto.randomBytes(4).toString('hex');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-polyglot-'));
  const local = path.join(tmp, name);
  try {
    copyExercise(exDir, local);
    for (const [f, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(local, f)), { recursive: true });
      fs.writeFileSync(path.join(local, f), content.replace(/\r\n/g, '\n'));
    }
    for (const f of c.tests) {
      const orig = fs.readFileSync(path.join(exDir, f), 'utf8');
      fs.mkdirSync(path.dirname(path.join(local, f)), { recursive: true });
      fs.writeFileSync(path.join(local, f), f.endsWith('.java') ? orig.replace(/@Disabled\([^)]*\)\s*\n/g, '') : orig);
    }
    await docker(['exec', container, 'mkdir', '-p', `/work/${n}`], { timeoutMs: 60_000 });
    const cp = await docker(['cp', local, `${container}:/work/${n}/${name}`], { timeoutMs: 120_000 });
    if (cp.code !== 0) throw new Error(`docker cp failed: ${cp.out.trim()}`);
    const t0 = Date.now();
    const r = await docker(
      [
        'exec',
        '-w',
        `/work/${n}/${name}`,
        container,
        'timeout',
        '-k',
        '10',
        String(TEST_TIMEOUT_S),
        'bash',
        '-c',
        TEST_COMMAND[c.codeLang],
      ],
      { timeoutMs: (TEST_TIMEOUT_S + 30) * 1000 },
    );
    const timedOut = r.timedOut || r.code === 124 || r.code === 137;
    const output = timedOut ? `${cleanTestOutput(r.out)}\nTests timed out!` : cleanTestOutput(r.out);
    return { pass: r.code === 0, output, timedOut, ms: Date.now() - t0 };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    void docker(['exec', container, 'rm', '-rf', `/work/${n}`], { timeoutMs: 60_000 });
  }
}
