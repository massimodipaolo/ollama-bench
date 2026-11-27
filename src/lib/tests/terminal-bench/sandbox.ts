/**
 * Terminal-Bench task containers (Harbor's protocol), shared by the test and scripts/tb-verify.mts.
 * The container runs the task's own prebuilt image with resource limits; model commands have no network or host
 * mounts. A fresh container is used for verification so agent processes cannot alter the reward.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { docker } from '@/lib/docker';
import type { TbCase } from './config';

const STORAGE_LIMIT = '10G';

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
      '--storage-opt',
      `size=${STORAGE_LIMIT}`,
      '--network',
      'none',
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

/** Snapshot the task workspace, then run tests in a fresh container with no agent processes. */
export async function runVerifier(name: string, taskDir: string, c: TbCase): Promise<{ reward: number | null; tail: string }> {
  const suffix = crypto.randomBytes(3).toString('hex');
  const image = `bench-tb-verifier:${suffix}`;
  const verifier = `bench-tb-verifier-${suffix}`;
  try {
    const snapshot = await docker(['commit', '--pause=true', name, image], { timeoutMs: 120_000 });
    if (snapshot.code !== 0) throw new Error(`could not snapshot task container: ${snapshot.out.trim()}`);

    const started = await docker(
      [
        'run',
        '-d',
        '--name',
        verifier,
        '--cpus',
        String(c.cpus),
        '--memory',
        `${c.memoryMb}m`,
        '--pids-limit',
        '4096',
        '--storage-opt',
        `size=${STORAGE_LIMIT}`,
        '--network',
        'none',
        '--entrypoint',
        'sh',
        image,
        '-c',
        'sleep infinity',
      ],
      { timeoutMs: 120_000 },
    );
    if (started.code !== 0) throw new Error(`could not start verifier container: ${started.out.trim()}`);

    await docker(['exec', verifier, 'sh', '-c', 'rm -rf /tests /logs/verifier/reward.txt && mkdir -p /logs/verifier /logs/agent'], {
      timeoutMs: 60_000,
    });
    const cp = await docker(['cp', path.join(taskDir, 'tests'), `${verifier}:/tests`], { timeoutMs: 120_000 });
    if (cp.code !== 0) throw new Error(`docker cp tests failed: ${cp.out.trim()}`);
    const v = await docker(['exec', verifier, 'timeout', '-k', '10', String(c.verifierTimeoutS), 'bash', '/tests/test.sh'], {
      timeoutMs: (c.verifierTimeoutS + 60) * 1000,
    });
    let tail = v.out.slice(-3000);
    const rw = await docker(['exec', verifier, 'cat', '/logs/verifier/reward.txt'], { timeoutMs: 30_000 });
    const value = rw.out.trim();
    const n = Number(value);
    const reward = rw.code === 0 && /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value) && Number.isFinite(n) ? n : null;
    if (reward === null) tail += `\n[no valid reward written${v.timedOut || v.code === 124 ? ': verifier timed out' : ''}]`;
    return { reward, tail };
  } finally {
    await docker(['rm', '-f', verifier], { timeoutMs: 120_000 });
    await docker(['rmi', '-f', image], { timeoutMs: 120_000 });
  }
}
