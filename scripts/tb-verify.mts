/**
 * Validate the Terminal-Bench harness: for each task, run the reference solution (solution/solve.sh) in the task
 * container, then the task verifier, exactly as the benchmark does after an agent. Reward 1 = the harness works for
 * that task; anything else is a harness/environment problem, not a model's.
 *
 *   pnpm tb:verify                 # the quick tasks
 *   pnpm tb:verify --all           # all 89 (pulls every image: tens of GB)
 *   pnpm tb:verify fix-git         # specific tasks
 *
 * Writes .data/datasets/terminal-bench/verify.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { docker } from '../src/lib/docker';
import type { TbCase } from '../src/lib/tests/terminal-bench/config';
import { ensureImage, runVerifier, startTaskContainer, stopTaskContainer } from '../src/lib/tests/terminal-bench/sandbox';

const DIR = path.join(process.cwd(), '.data', 'datasets', 'terminal-bench');
const { values: a, positionals } = parseArgs({ options: { all: { type: 'boolean', default: false } }, allowPositionals: true });
const all = JSON.parse(fs.readFileSync(path.join(DIR, 'cases.json'), 'utf8')) as TbCase[];
const cases = positionals.length ? all.filter((c) => positionals.includes(c.id)) : a.all ? all : all.filter((c) => c.quick);

const results: { id: string; reward: number | null; ms: number; error?: string; tail?: string }[] = [];
for (const c of cases) {
  const t0 = Date.now();
  const taskDir = path.join(DIR, c.dir);
  let name: string | undefined;
  try {
    await ensureImage(c.image, (t) => process.stdout.write(t));
    name = await startTaskContainer(c);
    await docker(['cp', path.join(taskDir, 'solution'), `${name}:/solution`], { timeoutMs: 120_000 });
    const sol = await docker(['exec', name, 'timeout', '-k', '10', String(c.agentTimeoutS), 'bash', '/solution/solve.sh'], {
      timeoutMs: (c.agentTimeoutS + 60) * 1000,
    });
    if (sol.code !== 0) console.log(`  (solve.sh exit ${sol.code})`);
    const v = await runVerifier(name, taskDir, c);
    results.push({ id: c.id, reward: v.reward, ms: Date.now() - t0, tail: v.reward === 1 ? undefined : v.tail.slice(-1500) });
  } catch (e) {
    results.push({ id: c.id, reward: null, ms: Date.now() - t0, error: (e as Error).message });
  } finally {
    if (name) await stopTaskContainer(name);
  }
  const r = results[results.length - 1];
  console.log(
    `${r.reward === 1 ? 'pass' : 'FAIL'} ${c.id} reward=${r.reward} (${(r.ms / 60000).toFixed(1)} min)${r.error ? ` ${r.error}` : ''}`,
  );
}
const fails = results.filter((r) => r.reward !== 1);
fs.writeFileSync(path.join(DIR, 'verify.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
console.log(`\n${results.length - fails.length}/${results.length} reference solutions verified`);
for (const f of fails) console.log(`\n--- ${f.id}\n${f.error ?? f.tail}`);
process.exit(fails.length ? 1 : 0);
