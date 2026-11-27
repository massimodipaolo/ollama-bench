/**
 * Validate the Polyglot harness: run every exercise's reference solution (.meta) through the same sandbox and test
 * commands the benchmark uses. Any failure here is a harness/toolchain problem, not a model's.
 *
 *   pnpm polyglot:verify                  # all 225
 *   pnpm polyglot:verify --quick          # the 6 quick exercises
 *   pnpm polyglot:verify --lang java      # one language
 *   pnpm polyglot:verify python/bowling   # specific exercises
 *
 * Writes .data/datasets/polyglot/verify.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { imageTag, type PolyglotCase } from '../src/lib/tests/polyglot/config';
import { imageExists, runTests, startSandbox, stopSandbox } from '../src/lib/tests/polyglot/sandbox';

const ROOT = process.cwd();
const DIR = path.join(ROOT, '.data', 'datasets', 'polyglot');
const { values: a, positionals } = parseArgs({
  options: { quick: { type: 'boolean', default: false }, lang: { type: 'string' }, concurrency: { type: 'string', default: '3' } },
  allowPositionals: true,
});

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'polyglot', 'manifest.json'), 'utf8')) as { commit: string };
const all = JSON.parse(fs.readFileSync(path.join(DIR, 'cases.json'), 'utf8')) as PolyglotCase[];
const cases = all.filter(
  (c) => (!a.quick || c.quick) && (!a.lang || c.codeLang === a.lang) && (!positionals.length || positionals.includes(c.id)),
);

/** Map reference files (.meta/example.py, .meta/src/reference/java/X.java) onto the solution paths. */
function referenceFiles(c: PolyglotCase): Record<string, string> {
  const ex = path.join(DIR, c.dir);
  const out: Record<string, string> = {};
  for (const s of c.solution) {
    const base = path.posix.basename(s);
    const ext = path.posix.extname(s);
    const pick =
      c.example.find((e) => path.posix.basename(e) === base) ??
      (c.example.filter((e) => path.posix.extname(e) === ext).length === 1
        ? c.example.find((e) => path.posix.extname(e) === ext)
        : undefined);
    if (pick) out[s] = fs.readFileSync(path.join(ex, pick), 'utf8');
  }
  // Java reference solutions may add helper classes in their own files (BowlingGame.java + Frame.java)
  if (c.codeLang === 'java')
    for (const e of c.example) out[path.posix.join('src/main/java', path.posix.basename(e))] ??= fs.readFileSync(path.join(ex, e), 'utf8');
  // Rust reference solutions that use extra crates come with their own manifest
  const cargoExample = path.join(ex, '.meta', 'Cargo-example.toml');
  if (fs.existsSync(cargoExample)) out['Cargo.toml'] = fs.readFileSync(cargoExample, 'utf8');
  return out;
}

const tag = imageTag(ROOT, manifest.commit);
if (!(await imageExists(tag))) throw new Error(`image ${tag} missing: run "pnpm datasets:fetch polyglot"`);
const container = await startSandbox(tag);
const results: { id: string; pass: boolean; ms: number; timedOut: boolean; mapped: number; tail?: string }[] = [];
const t0 = Date.now();
try {
  let next = 0;
  const worker = async () => {
    while (next < cases.length) {
      const c = cases[next++];
      const files = referenceFiles(c);
      const r = await runTests(container, DIR, c, files);
      results.push({
        id: c.id,
        pass: r.pass,
        ms: r.ms,
        timedOut: r.timedOut,
        mapped: Object.keys(files).length,
        tail: r.pass ? undefined : r.output.slice(-800),
      });
      console.log(
        `${r.pass ? 'pass' : 'FAIL'} ${c.id} (${(r.ms / 1000).toFixed(1)} s${Object.keys(files).length < c.solution.length ? `, mapped ${Object.keys(files).length}/${c.solution.length}` : ''})`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(a.concurrency)) }, worker));
} finally {
  await stopSandbox(container);
}
const fails = results.filter((r) => !r.pass);
fs.writeFileSync(path.join(DIR, 'verify.json'), JSON.stringify({ tag, at: new Date().toISOString(), results }, null, 2));
console.log(
  `\n${results.length - fails.length}/${results.length} reference solutions pass in ${((Date.now() - t0) / 60000).toFixed(1)} min`,
);
for (const f of fails) console.log(`\n--- ${f.id}${f.timedOut ? ' (timeout)' : ''}\n${f.tail}`);
process.exit(fails.length ? 1 : 0);
