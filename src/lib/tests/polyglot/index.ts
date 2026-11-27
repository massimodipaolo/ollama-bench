import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import type { ModelMessage } from 'ai';
import type { TestDefinition } from '../types';
import { datasetCases, datasetLanguages, datasetPath } from '../datasets';
import { runStream, toCaseOutput, GenerationError } from '../generate';
import { exerciseInstructions, imageTag, testFailurePrompt, LANG_LABEL, type PolyglotCase } from './config';
import { imageExists, runTests, startSandbox, stopSandbox } from './sandbox';
import { parseWholeFiles, showFiles } from './parse';
import { containerLabel } from '@/lib/runner/instance';

/**
 * Polyglot coding (Aider's polyglot benchmark: 225 hard Exercism exercises in C++, Go, Java, JavaScript, Python,
 * Rust). The model edits the solution files; the exercise's own unit tests run in a Docker sandbox; on failure it
 * gets one more try with the test output (Aider's protocol). Metric: pass rate after 2 tries (Aider's pass_rate_2).
 */
interface Attempt {
  pass: boolean;
  timedOut: boolean;
  testMs: number;
  missing: string[];
  output: string;
}
export interface PolyglotData {
  codeLang: string;
  attempts: Attempt[];
  passAt1: boolean;
  passAt2: boolean;
}
interface Shared {
  container: string;
}

const SYSTEM = `Act as an expert software developer.
Take requests for changes to the supplied code.
Always use best practices when coding. Respect and use existing conventions, libraries, etc that are already present in the code base.

To suggest changes to a file you MUST return the entire content of the updated file, in this format:

path/to/file.ext
\`\`\`language
<the complete file content>
\`\`\`

Write the file path alone on its own line, exactly as given, right before the code block.
Every file you return must be complete: never skip, elide or abbreviate any part with "..." or comments like "rest of the code unchanged".
Return only the files you change.`;

const MANIFEST = path.join(process.cwd(), 'fixtures', 'polyglot', 'manifest.json');
const commit = () => (JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as { commit: string }).commit;

export const polyglot: TestDefinition<PolyglotCase> = {
  id: 'polyglot',
  name: 'Coding · Polyglot (Aider)',
  description:
    "Aider's polyglot benchmark: 225 hard Exercism exercises in C++, Go, Java, JavaScript, Python and Rust. The model edits the code; the exercise's unit tests run in a Docker sandbox, with one retry after seeing the failures. Pass rate after 2 tries.",
  // v2: Java test output without -q (per-test failures for the retry, as in Aider)
  // v3: a file path written as the code block's first line names the file (it used to be written into the code)
  // v4: test feedback without framework stack frames, so failing tests + messages fit the 12k cap
  version: '4',
  requires: ['completion'],
  numCtx: 32768,
  judged: false,
  languages: datasetLanguages('polyglot'),
  rubric: { version: 'pg-1', instructions: 'Not judged: unit tests decide.', criteria: [] },
  loadCases: (lang) => datasetCases<PolyglotCase>('polyglot', lang),

  async prepare() {
    const tag = imageTag(process.cwd(), commit());
    if (!(await imageExists(tag))) throw new Error(`Docker image ${tag} not found: run "pnpm datasets:fetch polyglot" (needs Docker)`);
    const container = await startSandbox(tag, containerLabel());
    return { shared: { container } satisfies Shared, stats: { sandbox: tag.split(':')[1] } };
  },
  async cleanup(shared) {
    if (shared) await stopSandbox((shared as Shared).container);
  },

  async run(ctx, c) {
    const { container } = ctx.shared as Shared;
    const exDir = datasetPath('polyglot', c.dir);
    let files: Record<string, string> = Object.fromEntries(c.solution.map((f) => [f, fs.readFileSync(path.join(exDir, f), 'utf8')]));
    const messages: ModelMessage[] = [{ role: 'user', content: `${exerciseInstructions(exDir, c.solution)}\n${showFiles(files)}` }];
    const attempts: Attempt[] = [];
    let last: Awaited<ReturnType<typeof runStream>> | undefined;
    const usage = { tokensOut: 0, reasoningTokens: 0, latencyMs: 0 };

    for (let i = 0; i < 2; i++) {
      // the second try streams its own text; keep the first try's answer above it
      if (i === 1) ctx.onDelta(`\n\n——— try 2 (after test failures) ———\n\n`);
      try {
        last = await runStream(ctx, { system: SYSTEM, messages, maxOutputTokens: 8192 });
      } catch (e) {
        if (e instanceof GenerationError && attempts.length) break; // keep the first try's result
        throw e;
      }
      usage.tokensOut += last.tokensOut ?? 0;
      usage.reasoningTokens += last.reasoningTokens ?? 0;
      usage.latencyMs += last.latencyMs ?? 0;
      const parsed = parseWholeFiles(last.output, c.solution);
      files = { ...files, ...parsed.files };
      const t = await runTests(container, datasetPath('polyglot'), c, files);
      attempts.push({ pass: t.pass, timedOut: t.timedOut, testMs: t.ms, missing: parsed.missing, output: t.output.slice(-6000) });
      if (t.pass) break;
      messages.push(
        { role: 'assistant', content: last.output },
        { role: 'user', content: `${t.output}\n${testFailurePrompt(c.solution)}\nCurrent files:\n\n${showFiles(files)}` },
      );
    }
    const out = toCaseOutput(last!);
    const data: PolyglotData = {
      codeLang: LANG_LABEL[c.codeLang],
      attempts,
      passAt1: !!attempts[0]?.pass,
      passAt2: attempts.some((a) => a.pass),
    };
    return {
      ...out,
      // what the session shows: the final answer, tokens summed over both tries
      output: last!.output,
      tokensOut: usage.tokensOut || out.tokensOut,
      reasoningTokens: usage.reasoningTokens || out.reasoningTokens,
      latencyMs: usage.latencyMs || out.latencyMs,
      data,
    };
  },

  check(c, out) {
    const d = out.data as PolyglotData | undefined;
    if (!d?.attempts.length) return [{ name: 'tests pass (≤ 2 tries)', pass: false, detail: 'no attempt ran' }];
    const desc = d.attempts
      .map(
        (a, i) =>
          `try ${i + 1}: ${a.pass ? 'pass' : a.timedOut ? 'timeout' : 'fail'}${a.missing.length ? ` (no ${a.missing.join(', ')} returned)` : ''}`,
      )
      .join(' · ');
    return [{ name: 'tests pass (≤ 2 tries)', pass: d.passAt2, detail: desc }];
  },

  judgeMaterial: (c, out) => ({ task: c.title, input: c.id, response: out.output }),

  promptPreview(c) {
    const exDir = datasetPath('polyglot', c.dir);
    const files = Object.fromEntries(c.solution.map((f) => [f, fs.readFileSync(path.join(exDir, f), 'utf8')]));
    return {
      task: `${c.title}: make the exercise's unit tests pass (2 tries; the tests stay hidden)`,
      input: `System: ${SYSTEM}\n\nUser: ${exerciseInstructions(exDir, c.solution)}\n${showFiles(files)}`,
      reference: `Hidden tests: ${c.tests.join(', ')} (run in the sandbox).`,
    };
  },
};
