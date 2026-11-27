import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { isStepCount, tool } from 'ai';
import { z } from 'zod';
import type { TestDefinition } from '../types';
import { datasetCases, datasetLanguages, datasetPath } from '../datasets';
import { GenerationError, runStream } from '../generate';
import { docker } from '../polyglot/sandbox';
import type { TbCase } from './config';
import { ensureImage, runVerifier, startTaskContainer, stopTaskContainer } from './sandbox';
import { containerLabel } from '@/lib/runner/instance';

/**
 * Terminal-Bench 2.1: an autonomous agent (our AI SDK loop with a single `bash` tool, Ollama model under test)
 * works inside the task's own container; then the task's verifier runs (Harbor's protocol: tests/ copied to
 * /tests, `bash /tests/test.sh`, reward in /logs/verifier/reward.txt). Metric: share of tasks with reward 1.
 * Long-running (each task up to its agent timeout, 10–200 min): start it from the CLI (pnpm bench).
 * Not comparable 1:1 with the leaderboard, which uses the Terminus 2 agent (tmux) and 5 trials per task.
 */
export interface TbCommand {
  step: number;
  toolName: 'bash';
  input: { command: string; timeoutSec?: number };
  output?: string;
  error?: string;
}
export interface TbData {
  reward: number | null;
  commands: number;
  agentEnded: 'finished' | 'step limit' | 'stuck' | 'timeout' | 'error';
  agentError?: string;
  verifierTail: string;
  trace: TbCommand[];
  image: string;
}

const MAX_STEPS = 80;
/** the same command this many times in a row ends the agent as 'stuck' (saves time; no hint is given) */
const STUCK_REPEATS = 8;
const OUT_HEAD = 1500;
const OUT_TAIL = 6000;

const SYSTEM = `You are an autonomous agent completing a task inside a Linux container, using a terminal.
Use the bash tool to run shell commands. Work step by step: inspect the environment, make changes, and check your work.
- Each command runs in a fresh non-interactive bash shell that starts in the task's working directory: use absolute paths or "cd dir && …" within one command; environment changes do not persist between commands.
- Never run interactive programs (editors, pagers, REPLs, "less", "vim", "top"); write files with heredocs or tools like sed/python instead.
- Long-running commands need an explicit timeoutSec (default 120, max 900).
- No human will answer questions: decide for yourself and complete the whole task.
When the task is fully done, stop calling tools and reply with a short summary of what you did.`;

/** Keep the start and the end of long command output (the end usually holds the error). */
function clip(s: string): string {
  if (s.length <= OUT_HEAD + OUT_TAIL) return s;
  return `${s.slice(0, OUT_HEAD)}\n… (${s.length - OUT_HEAD - OUT_TAIL} characters omitted) …\n${s.slice(-OUT_TAIL)}`;
}

export const terminalBench: TestDefinition<TbCase> = {
  id: 'terminal-bench',
  name: 'Coding · Terminal-Bench 2.1',
  description:
    "Agentic terminal tasks (89: software engineering, debugging, security, data, sysadmin…) in each task's own Docker container; the model drives a bash tool until done, then the task's verifier decides. CLI only: hours per model.",
  version: '1',
  requires: ['completion', 'tools'],
  numCtx: 65536,
  judged: false,
  cliOnly: true,
  languages: datasetLanguages('terminal-bench'),
  rubric: { version: 'tb-1', instructions: 'Not judged: the task verifier decides.', criteria: [] },
  loadCases: (lang) =>
    datasetCases<TbCase>('terminal-bench', lang).map((c) => ({ ...c, title: `${c.id} (${c.difficulty}, ${c.category})` })),

  async prepare() {
    const v = await docker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 30_000 });
    if (v.code !== 0) throw new Error(`Docker is not available: ${v.out.trim().split('\n').pop()}`);
    return { stats: { docker: v.out.trim() } };
  },

  async run(ctx, c) {
    const taskDir = datasetPath('terminal-bench', c.dir);
    const instruction = fs.readFileSync(path.join(taskDir, 'instruction.md'), 'utf8');
    await ensureImage(c.image, ctx.onDelta);
    const name = await startTaskContainer(c, containerLabel());

    const trace: TbCommand[] = [];
    let transcript = '';
    const log = (s: string) => {
      if (transcript.length < 400_000) transcript += s;
    };
    const deadline = AbortSignal.timeout(c.agentTimeoutS * 1000);
    const stuck = new AbortController();
    const signal = AbortSignal.any([ctx.signal, deadline, stuck.signal]);
    let repeats = 0;
    let agentEnded: TbData['agentEnded'] = 'finished';
    let agentError: string | undefined;
    let last: Awaited<ReturnType<typeof runStream>> | undefined;

    const bash = tool({
      description:
        'Run a shell command in the task container (bash -c, fresh shell, task working directory). Returns the exit code and combined stdout/stderr.',
      inputSchema: z.object({
        command: z.string().describe('the shell command to run'),
        timeoutSec: z.number().int().min(1).max(900).optional().describe('kill after this many seconds (default 120)'),
      }),
      execute: async ({ command, timeoutSec }) => {
        repeats = trace.length && trace[trace.length - 1].input.command === command ? repeats + 1 : 1;
        if (repeats >= STUCK_REPEATS) stuck.abort();
        const entry: TbCommand = { step: trace.length + 1, toolName: 'bash', input: { command, timeoutSec } };
        trace.push(entry);
        log(`\n$ ${command}\n`);
        const t = Math.min(timeoutSec ?? 120, 900);
        const r = await docker(['exec', name, 'timeout', '-k', '5', String(t), 'bash', '-c', command], { timeoutMs: (t + 20) * 1000 });
        const timedOut = r.timedOut || r.code === 124 || r.code === 137;
        const out = `${timedOut ? `[timed out after ${t}s]\n` : ''}exit code: ${r.code}\n${clip(r.out)}`;
        entry.output = out.slice(0, 4000);
        log(`${clip(r.out)}\n[exit ${r.code}]\n`);
        return out;
      },
    });

    let reward: number | null = null;
    let verifierTail = '';
    try {
      try {
        last = await runStream(
          { ...ctx, signal },
          {
            system: SYSTEM,
            prompt: instruction,
            tools: { bash },
            stopWhen: isStepCount(MAX_STEPS),
            maxOutputTokens: 8192,
          },
        );
        if (last.steps >= MAX_STEPS && trace.length && last.output.trim() === '') agentEnded = 'step limit';
        log(`\n${last.output}\n`);
      } catch (e) {
        if (ctx.signal.aborted) throw e; // session cancelled: no verifier (the container is still removed below)
        agentEnded = stuck.signal.aborted ? 'stuck' : deadline.aborted ? 'timeout' : 'error';
        agentError = (e as Error).message;
        if (e instanceof GenerationError && e.partialOutput) log(`\n${e.partialOutput}\n`);
        log(`\n[agent ${agentEnded}: ${agentError}]\n`);
      }
      // the verifier runs even after an agent timeout, as in Harbor
      ctx.onDelta(`\n(running the task verifier…)\n`);
      ({ reward, tail: verifierTail } = await runVerifier(name, taskDir, c));
    } finally {
      await stopTaskContainer(name);
    }

    const data: TbData = { reward, commands: trace.length, agentEnded, agentError, verifierTail, trace, image: c.image };
    return {
      output: transcript.trim() || last?.output || '',
      reasoning: last?.reasoning,
      latencyMs: last?.latencyMs,
      ttftMs: last?.ttftMs,
      tokensIn: last?.tokensIn,
      tokensOut: last?.tokensOut,
      reasoningTokens: last?.reasoningTokens,
      tokPerSec: last?.tokPerSec,
      data,
    };
  },

  check(_c, out) {
    const d = out.data as TbData | undefined;
    if (!d) return [{ name: 'task solved (verifier)', pass: false, detail: 'no result' }];
    return [
      {
        name: 'task solved (verifier)',
        pass: (d.reward ?? 0) >= 1,
        detail: `reward ${d.reward ?? 'none'} · ${d.commands} commands · agent ${d.agentEnded}`,
      },
    ];
  },

  judgeMaterial: (c, out) => ({ task: c.title, input: c.id, response: out.output }),

  promptPreview(c) {
    const taskDir = datasetPath('terminal-bench', c.dir);
    return {
      task: `${c.title}: solve it in the container (${c.image}, ${c.cpus} CPU, ${c.memoryMb} MB, agent timeout ${Math.round(c.agentTimeoutS / 60)} min)`,
      input: `System: ${SYSTEM}\n\nTools: bash(command, timeoutSec?)\n\nUser: ${fs.readFileSync(path.join(taskDir, 'instruction.md'), 'utf8')}`,
      reference: `Verifier: tests/test.sh (hidden from the agent), reward in /logs/verifier/reward.txt`,
    };
  },
};
