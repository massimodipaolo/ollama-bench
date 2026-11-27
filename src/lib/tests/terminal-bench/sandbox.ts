/**
 * Terminal-Bench task containers (Harbor's protocol), shared by the test and scripts/tb-verify.mts.
 * The container runs the task's own prebuilt image with the task's CPU/memory limits; model commands only ever
 * run inside it (no host mounts). Internet is on only when the task allows it (all 2.1 tasks do: agents install
 * packages and the verifiers download their test runner).
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { docker } from '@/lib/docker';
import type { TbCase } from './config';

export async function ensureImage(image: string, onProgress?: (t: string) => void) {
  if ((await docker(['image', 'inspect', image], { timeoutMs: 30_000 })).code === 0) return;
  onProgress?.(`(pulling ${image}…)\n`);
  const r = await docker(['pull', '-q', image], { timeoutMs: 45 * 60_000 });
  if (r.code !== 0) throw new Error(`docker pull ${image} failed: ${r.out.trim().split('\n').pop()}`);
}

/** `extra`: additional docker run arguments (the app passes its owner label, see runner/instance.ts). */
export async function startTaskContainer(c: TbCase, extra: string[] = []): Promise<string> {
  const name = `bench-tb-${c.id.replace(/[^a-z0-9-]/gi, '-').slice(0, 40)}-${crypto.randomBytes(3).toString('hex')}`;
  const r = await docker(
    [
      'run',
      '-d',
      '--name',
      name,
      '--cpus',
      String(c.cpus),
      '--memory',
      `${c.memoryMb}m`,
      '--pids-limit',
      '4096',
      ...(c.allowInternet ? [] : ['--network', 'none']),
      ...extra,
      '--entrypoint',
      'sh',
      c.image,
      '-c',
      'sleep infinity',
    ],
    { timeoutMs: 120_000 },
  );
  if (r.code !== 0) throw new Error(`could not start ${c.image}: ${r.out.trim().split('\n').pop()}`);
  return name;
}

export async function stopTaskContainer(name: string) {
  await docker(['rm', '-f', name], { timeoutMs: 120_000 });
}

/** Copy tests/ to /tests, run test.sh in the task's working directory, read /logs/verifier/reward.txt. */
export async function runVerifier(name: string, taskDir: string, c: TbCase): Promise<{ reward: number | null; tail: string }> {
  await docker(['exec', name, 'sh', '-c', 'rm -rf /tests && mkdir -p /logs/verifier /logs/agent'], { timeoutMs: 60_000 });
  const cp = await docker(['cp', path.join(taskDir, 'tests'), `${name}:/tests`], { timeoutMs: 120_000 });
  if (cp.code !== 0) throw new Error(`docker cp tests failed: ${cp.out.trim()}`);
  const v = await docker(['exec', name, 'timeout', '-k', '10', String(c.verifierTimeoutS), 'bash', '/tests/test.sh'], {
    timeoutMs: (c.verifierTimeoutS + 60) * 1000,
  });
  let tail = v.out.slice(-3000);
  const rw = await docker(['exec', name, 'cat', '/logs/verifier/reward.txt'], { timeoutMs: 30_000 });
  const n = Number.parseFloat(rw.out.trim());
  const reward = rw.code === 0 && Number.isFinite(n) ? n : null;
  if (reward === null) tail += `\n[no reward written${v.timedOut || v.code === 124 ? ': verifier timed out' : ''}]`;
  return { reward, tail };
}
