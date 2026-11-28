/**
 * Terminal-Bench end to end with the model on the fake Ollama and Docker replaced by a scripted fake (vi.mock of
 * src/lib/docker.ts): the agent loop, what runs where (task container, separate verifier container), the sandbox
 * flags, how the reward is read, and that every container is removed whatever happens.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLanguage } from '@/config/languages';
import type { TbCase } from '@/lib/tests/terminal-bench/config';
import { parseTaskToml } from '@/lib/tests/terminal-bench/config';
import { chatReply, startFakeOllama } from '../../helpers/fake-ollama';
import { runContext } from '../../helpers/context';

/** The fake docker CLI: every call recorded; answers scripted per test. */
const dockerFake = vi.hoisted(() => ({
  calls: [] as string[][],
  /** command output inside the task container, by command (set per test) */
  exec: undefined as unknown as (cmd: string) => { code: number | null; out: string },
  reward: '1',
  failCommit: false,
}));
vi.mock('@/lib/docker', () => ({
  docker: async (args: string[]) => {
    dockerFake.calls.push(args);
    const [verb] = args;
    if (verb === 'commit' && dockerFake.failCommit) return { code: 1, out: 'commit failed', timedOut: false };
    if (verb === 'exec' && args.includes('bash') && args.includes('-c') && !args[1].startsWith('bench-tb-verifier')) {
      return { ...dockerFake.exec(args.at(-1)!), timedOut: false };
    }
    if (verb === 'exec' && args.at(-1) === '/logs/verifier/reward.txt') return { code: 0, out: dockerFake.reward, timedOut: false };
    return { code: 0, out: verb === 'version' ? '29.9.3' : '', timedOut: false };
  },
}));

const ollama = await startFakeOllama();
process.env.OLLAMA_HOST = ollama.url;
const { terminalBench } = await import('@/lib/tests/terminal-bench');
const { DATASETS_DIR } = await import('@/lib/tests/datasets');

afterAll(() => ollama.close());
beforeEach(() => {
  ollama.reset();
  dockerFake.calls.length = 0;
  dockerFake.exec = () => ({ code: 0, out: 'file.txt' });
  dockerFake.reward = '1';
  dockerFake.failCommit = false;
});

// a task directory outside the dataset (the run reads instruction.md from it; tests/ is copied by the fake docker)
const taskDir = mkdtempSync(join(tmpdir(), 'tb-task-'));
writeFileSync(join(taskDir, 'instruction.md'), 'Create /app/out.txt containing "done".');
mkdirSync(join(taskDir, 'tests'));
const task: TbCase = {
  id: 'make-file',
  title: 'make-file',
  dir: relative(join(DATASETS_DIR, 'terminal-bench'), taskDir),
  difficulty: 'easy',
  category: 'sysadmin',
  image: 'example/task:1',
  cpus: 2,
  memoryMb: 4096,
  agentTimeoutS: 60,
  verifierTimeoutS: 60,
};
const en = getLanguage('en');
const bashCall = (command: string) => chatReply({ toolCalls: [{ name: 'bash', arguments: { command } }] });
const verbs = () => dockerFake.calls.map((a) => a[0]);

describe('parseTaskToml', () => {
  it('reads the image, limits and timeouts the harness needs', () => {
    const toml = `difficulty = "medium"\ncategory = "debugging"\n[environment]\ndocker_image = "ghcr.io/x/task:2"\ncpus = 4\nmemory_mb = 8192\n[agent]\ntimeout_sec = 1800.0\n[verifier]\ntimeout_sec = 600\n`;
    expect(parseTaskToml('fix-git', toml)).toEqual({
      id: 'fix-git',
      title: 'fix-git',
      difficulty: 'medium',
      category: 'debugging',
      image: 'ghcr.io/x/task:2',
      cpus: 4,
      memoryMb: 8192,
      agentTimeoutS: 1800,
      verifierTimeoutS: 600,
    });
    expect(() => parseTaskToml('broken', '[agent]\ntimeout_sec = 1')).toThrow('broken: no environment.docker_image in task.toml');
  });
});

describe('a run', () => {
  it('the agent works in a sandboxed task container, a separate container verifies, everything is removed', async () => {
    ollama.replies.push(bashCall('ls /app'), bashCall('echo done > /app/out.txt'), chatReply({ text: 'Created the file.' }));
    const out = await terminalBench.run(runContext().ctx, task);
    const d = out.data as { reward: number; commands: number; agentEnded: string; trace: { output: string }[] };

    expect(d).toMatchObject({ reward: 1, commands: 2, agentEnded: 'finished' });
    expect(d.trace[0].output).toBe('exit code: 0\nfile.txt');
    expect(terminalBench.check(task, out, en)).toEqual([
      { name: 'task solved (verifier)', pass: true, detail: 'reward 1 · 2 commands · agent finished' },
    ]);

    const run = dockerFake.calls.find((a) => a[0] === 'run' && a.includes(task.image))!;
    // no network, resource limits, no host mounts
    expect(run).toEqual(expect.arrayContaining(['--network', 'none', '--cpus', '2', '--memory', '4096m', '--pids-limit', '4096']));
    expect(run.join(' ')).not.toMatch(/(^| )(-v|--volume|--mount)( |$)/);
    expect(run).toContain('ollama-bench.instance=' + run[run.indexOf('--label') + 1].split('=')[1]); // owner label, for recovery
    // the model's commands run with a timeout inside the task container
    const name = run[run.indexOf('--name') + 1];
    expect(dockerFake.calls).toContainEqual(['exec', name, 'timeout', '-k', '5', '120', 'bash', '-c', 'ls /app']);
    // the verifier runs on a snapshot, in a fresh container with no network, then both containers and the image go
    expect(verbs()).toEqual(expect.arrayContaining(['commit', 'cp']));
    const verifierRun = dockerFake.calls.filter((a) => a[0] === 'run')[1];
    expect(verifierRun).toEqual(expect.arrayContaining(['--network', 'none']));
    expect(dockerFake.calls).toContainEqual(['rm', '-f', name]);
    expect(dockerFake.calls.some((a) => a[0] === 'rmi')).toBe(true);
  });

  it.each([
    ['0', 0],
    ['0.5', 0.5],
    ['2', null],
    ['yes', null],
    ['', null],
  ])('reward.txt "%s" → %s', async (text, reward) => {
    dockerFake.reward = text;
    ollama.replies.push(chatReply({ text: 'Done.' }));
    const out = await terminalBench.run(runContext().ctx, task);
    expect((out.data as { reward: number | null }).reward).toBe(reward);
    expect(terminalBench.check(task, out, en)[0].pass).toBe(false);
  });

  it('the same command 8 times in a row ends the agent as stuck; the verifier still runs', async () => {
    for (let i = 0; i < 9; i++) ollama.replies.push(bashCall('cat /app/out.txt'));
    const out = await terminalBench.run(runContext().ctx, task);
    expect(out.data).toMatchObject({ agentEnded: 'stuck', commands: 8 });
    expect(verbs()).toContain('commit');
  });

  it('long output keeps its start and end; a timed-out command says so', async () => {
    dockerFake.exec = (cmd) => (cmd === 'make' ? { code: 0, out: `${'a'.repeat(2000)}${'b'.repeat(8000)}` } : { code: 124, out: '' });
    ollama.replies.push(bashCall('make'), bashCall('sleep 999'), chatReply({ text: 'Done.' }));
    const out = await terminalBench.run(runContext().ctx, task);
    const [make, sleep] = (out.data as { trace: { output: string }[] }).trace;
    expect(make.output).toMatch(/characters omitted/);
    expect(sleep.output).toMatch(/^\[timed out after 120s\]\nexit code: 124/);
  });

  it('the task container is removed even when verification fails', async () => {
    dockerFake.failCommit = true;
    ollama.replies.push(chatReply({ text: 'Done.' }));
    await expect(terminalBench.run(runContext().ctx, task)).rejects.toThrow('could not snapshot task container');
    expect(dockerFake.calls.filter((a) => a[0] === 'rm').length).toBeGreaterThanOrEqual(2); // verifier and task container
  });

  it('prepare reports the Docker version', async () => {
    expect((await terminalBench.prepare!({ ...runContext().ctx, onDelta: () => {} })).stats).toEqual({ docker: '29.9.3' });
  });
});
