/**
 * Polyglot coding benchmark (Aider-AI/polyglot-benchmark, Exercism exercises) — rules shared by the dataset fetch
 * script and the test: which files the model sees, which it must not, how each language runs its tests.
 * Everything here mirrors Aider's benchmark/benchmark.py so pass rates stay comparable (except the edit format:
 * we ask for whole files; Aider usually benchmarks diff formats).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CODE_LANGS = ['python', 'javascript', 'go', 'rust', 'cpp', 'java'] as const;
export type CodeLang = (typeof CODE_LANGS)[number];

export const LANG_LABEL: Record<CodeLang, string> = {
  python: 'Python',
  javascript: 'JavaScript',
  go: 'Go',
  rust: 'Rust',
  cpp: 'C++',
  java: 'Java',
};

/** One exercise in .data/datasets/polyglot/cases.json */
export interface PolyglotCase {
  id: string; // "python/bowling"
  title: string;
  quick?: boolean;
  codeLang: CodeLang;
  /** exercise directory, relative to .data/datasets/polyglot */
  dir: string;
  /** files the model edits (from .meta/config.json, minus ignored ones) */
  solution: string[];
  /** test files: hidden from the model, restored before every test run */
  tests: string[];
  /** reference solution files (.meta/…), used only by --verify */
  example: string[];
}

/** Aider: never offered to the model even if listed as solution files. */
const IGNORED = new Set(['CMakeLists.txt', 'Cargo.toml']);

/** Solution/test/example files of an exercise, exactly as Aider derives them from .meta/config.json. */
export function exerciseFiles(exDir: string): { solution: string[]; tests: string[]; example: string[] } {
  const cfg = JSON.parse(fs.readFileSync(path.join(exDir, '.meta', 'config.json'), 'utf8')) as {
    files?: { solution?: string[]; test?: string[]; example?: string[] };
  };
  const tests = cfg.files?.test ?? [];
  const example = cfg.files?.example ?? [];
  const hidden = new Set([...IGNORED, ...tests, ...example]);
  const solution = (cfg.files?.solution ?? []).filter((f) => !hidden.has(f) && !f.startsWith('.meta/') && !f.startsWith('.docs/'));
  return { solution, tests, example };
}

/** The task text: introduction + instructions + instructions.append, then Aider's addendum. */
export function exerciseInstructions(exDir: string, solution: string[]): string {
  const read = (f: string) => (fs.existsSync(path.join(exDir, '.docs', f)) ? fs.readFileSync(path.join(exDir, '.docs', f), 'utf8') : '');
  const fileList = solution.map((f) => path.posix.basename(f)).join(' ');
  return `${read('introduction.md')}${read('instructions.md')}${read('instructions.append.md')}
####

Use the above instructions to modify the supplied files: ${fileList}
Don't change the names of existing functions or classes, as they may be referenced from other code like unit tests, etc.
Only use standard libraries, don't suggest installing any packages.
`;
}

/** Aider's follow-up after a failed test run. */
export const testFailurePrompt = (solution: string[]) => `
####

See the testing errors above.
The tests are correct, don't try and change them.
Fix the code in ${solution.map((f) => path.posix.basename(f)).join(' ')} to resolve the errors.
`;

/**
 * Shell command run inside the exercise directory in the sandbox (no network; caches baked into the image).
 * Same commands as Aider's TEST_COMMANDS / npm-test.sh / cpp-test.sh, plus the offline flags.
 */
export const TEST_COMMAND: Record<CodeLang, string> = {
  python: 'python3 -m pytest -q -p no:cacheprovider',
  rust: 'cargo test --offline -- --include-ignored',
  go: 'go test ./...',
  javascript:
    "[ -e node_modules ] || ln -s /npm-install/node_modules . ; [ -e package-lock.json ] || ln -s /npm-install/package-lock.json . ; sed -i 's/\\bxtest(/test(/g' *.spec.js && npm run test --silent",
  cpp: 'mkdir -p build && cd build && cmake -DEXERCISM_RUN_ALL_TESTS=1 -G "Unix Makefiles" .. >/dev/null && make',
  // no -q: Gradle's per-test failure lines are the feedback the model gets for its second try (as in Aider)
  java: 'sh ./gradlew --offline --no-daemon --console=plain test',
};

export const TEST_TIMEOUT_S = 180; // Aider: 3 minutes

/** Image tag: changes whenever the Dockerfile or the pinned dataset commit changes. */
export function imageTag(root: string, commit: string): string {
  const dockerfile = fs.readFileSync(path.join(root, 'docker', 'polyglot', 'Dockerfile'), 'utf8');
  return `ollama-bench-polyglot:${crypto.createHash('sha1').update(dockerfile).update(commit).digest('hex').slice(0, 12)}`;
}

/** Stack frames of test frameworks and runtimes: dozens per failure (Java prints full traces), never about the code. */
const FRAMEWORK_FRAME =
  /^\s*at (org\.junit|org\.opentest4j|org\.assertj|org\.gradle|worker\.org\.gradle|java\.base\/|jdk\.internal|java\.lang\.reflect|sun\.reflect|jdk\.proxy)\S*/;

/**
 * Aider's cleanup of test output (timings, paths) + a cap so a huge log can't flood the context. Unlike Aider (which
 * passes the output uncapped), we cap it; framework stack frames are dropped first so that the failing tests, their
 * assertion messages and the frames in the model's own code survive the cap.
 */
export function cleanTestOutput(out: string, maxChars = 12_000): string {
  const s = out
    .replace(/\bin \d+\.\d+s\b/g, '')
    .replace(/\r/g, '')
    .replace(/\/work\/[0-9a-f]{8}\//g, '') // sandbox work dir -> exercise-relative paths
    .split('\n')
    .filter((l) => !FRAMEWORK_FRAME.test(l))
    .join('\n');
  if (s.length <= maxChars) return s;
  const head = s.slice(0, Math.floor(maxChars * 0.4));
  const tail = s.slice(-Math.floor(maxChars * 0.6));
  return `${head}\n… (${s.length - maxChars} characters omitted) …\n${tail}`;
}
