/**
 * Every security check in one run, and one report of what they found.
 *
 *   pnpm security                       # all four checks: audit, scout, secrets, codeql
 *   pnpm security audit scout           # some of them (the others keep their last result in the report)
 *   pnpm security --build               # rebuild the Docker image first (scout and the image secret scan read it)
 *   pnpm security --report-only         # no scan: rebuild the report from the last results (after editing suppressions)
 *
 *   audit    pnpm audit: known vulnerabilities in the dependencies (production and dev, told apart)
 *   scout    Docker Scout: CVEs in the image (OS packages, Node, the npm packages it ships)
 *   secrets  gitleaks (scripts/gitleaks.mts): git history, working tree and image, including own .env values
 *   codeql   CodeQL security-extended queries on the sources (scripts/codeql.mts; reuses the database when unchanged)
 *
 * Output in .data/security/:
 *   report.md        every check's status and every open finding, most urgent first, with its fix
 *   findings.json    the same, for scripts and the security-fix skill
 *   checks/<check>.json   each check's last result: a run of some checks keeps the others' results
 *
 * Every finding has a stable ID (`codeql-1a2b3c4d`). An accepted finding goes in security-suppressions.json with its
 * ID and a reason (and optionally an expiry date): it moves to the report's Suppressed section. A secret that must be
 * rotated can't be suppressed.
 *
 * Exit code: 0 no open findings · 1 open findings · 2 a check that was asked for failed, or a usage error.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createSteps, fmt } from './cli-steps.mjs';
import { loadFindings } from './codeql-report.mjs';
import {
  applySuppressions,
  byPriority,
  CHECKS,
  fromAudit,
  fromCodeql,
  fromGitleaks,
  fromScout,
  renderReport,
  type AuditReport,
  type Check,
  type CheckResult,
  type GitleaksResults,
  type ScoutSarif,
  type Suppression,
} from './security-findings.mjs';

const USAGE = `Usage: pnpm security [audit] [scout] [secrets] [codeql] [--build] [--image <name>] [--report-only]

  audit | scout | secrets | codeql   the checks to run (default: all four)
  --build          rebuild the Docker image first (as the docker:build task does)
  --image <name>   image for scout and the image secret scan (default <folder>:local, e.g. ollama-bench:local)
  --report-only    run nothing: rebuild report.md and findings.json from the last results
  -h, --help`;

let parsed: { values: { build?: boolean; image?: string; 'report-only'?: boolean; help?: boolean }; positionals: string[] };
try {
  parsed = parseArgs({
    options: {
      build: { type: 'boolean' },
      image: { type: 'string' },
      'report-only': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });
} catch (e) {
  console.error(`${(e as Error).message}\n\n${USAGE}`);
  process.exit(2);
}
const { values: opts, positionals } = parsed;
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}
const unknown = positionals.find((p) => !CHECKS.includes(p as Check));
if (unknown !== undefined) {
  console.error(`Unknown check "${unknown}": use ${CHECKS.join(', ')}.\n\n${USAGE}`);
  process.exit(2);
}
const reportOnly = !!opts['report-only'];
if (reportOnly && (positionals.length || opts.build)) {
  console.error('--report-only runs nothing: drop the checks and --build, or drop --report-only.');
  process.exit(2);
}
const explicit = positionals.length > 0;
const selected: Check[] = reportOnly ? [] : explicit ? CHECKS.filter((c) => positionals.includes(c)) : [...CHECKS];

const root = resolve(import.meta.dirname, '..');
const out = join(root, '.data', 'security');
const checksDir = join(out, 'checks');
const imageName = opts.image ?? `${basename(root).toLowerCase()}:local`;
const suppressionsFile = join(root, 'security-suppressions.json');
const rel = (p: string) => relative(root, p).replace(/\\/g, '/');

const needsImage = selected.includes('scout') || selected.includes('secrets');
const { log, step, elapsed } = createSteps(selected.length + (opts.build && needsImage ? 1 : 0) + 1);

// ---------- processes

function run(cmd: string, args: string[], o: { inherit?: boolean } = {}) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: o.inherit ? 'inherit' : 'pipe', maxBuffer: 256 * 1024 * 1024 });
  return { status: r.status, out: r.stdout?.trim() ?? '', err: (r.stderr || r.error?.message || '').trim() };
}
/** One of this folder's TypeScript scripts, in its own process (they call process.exit), output shown live. */
const script = (name: string, args: string[]) =>
  run(process.execPath, ['--import', 'tsx', join(import.meta.dirname, name), ...args], { inherit: true });
/** pnpm itself: the copy running this script when started by pnpm, else the one on PATH. */
function pnpm(args: string[]) {
  const execPath = process.env.npm_execpath;
  if (execPath && /\.[cm]?js$/.test(execPath)) return run(process.execPath, [execPath, ...args]);
  return process.platform === 'win32' ? run('cmd.exe', ['/d', '/s', '/c', 'pnpm', ...args]) : run('pnpm', args);
}
const git = (args: string[]) => {
  const r = run('git', args);
  return r.status === 0 ? r.out : undefined;
};
const tail = (s: string, lines = 5) => s.split(/\r?\n/).filter(Boolean).slice(-lines).join(' / ');

const commit = git(['rev-parse', '--short', 'HEAD']);
const dirty = !!git(['status', '--porcelain']);
const branch = git(['branch', '--show-current']);

// ---------- the checks

type Outcome = Omit<CheckResult, 'check' | 'ranAt' | 'commit' | 'dirty' | 'ms'>;

/** A missing prerequisite: skipped when running everything, an error when this check was asked for by name. */
const unavailable = (reason: string, target: string): Outcome => ({
  status: explicit ? 'error' : 'skipped',
  reason,
  target,
  findings: [],
});
const withFindings = (o: Omit<Outcome, 'status'>): Outcome => ({ ...o, status: o.findings.length ? 'findings' : 'clean' });

function imageState(): { ok: true; target: string } | { ok: false; reason: string } {
  if (run('docker', ['version', '--format', '{{.Server.Version}}']).status !== 0) return { ok: false, reason: 'Docker is not running' };
  const created = run('docker', ['image', 'inspect', imageName, '--format', '{{.Created}}']);
  if (created.status !== 0)
    return { ok: false, reason: `no local image "${imageName}": build it first (pnpm security --build, or the docker:build task)` };
  const builtAt = Date.parse(created.out);
  const lastCommit = Number(git(['log', '-1', '--format=%ct'])) * 1000;
  const old = builtAt < lastCommit ? ', older than the last commit: --build to rebuild it' : '';
  return { ok: true, target: `image \`${imageName}\` built ${new Date(builtAt).toLocaleString('en-GB')}${old}` };
}

function runAudit(): Outcome {
  const target = 'dependencies in pnpm-lock.yaml';
  const parse = (args: string[]): AuditReport | string => {
    const r = pnpm(['audit', '--json', ...args]);
    try {
      return JSON.parse(r.out) as AuditReport; // exits 1 when it finds something: the JSON tells
    } catch {
      return `pnpm audit ${args.join(' ')} gave no report (exit ${r.status}): ${tail(r.err || r.out)}`;
    }
  };
  const all = parse([]);
  if (typeof all === 'string') return { status: 'error', reason: all, target, findings: [] };
  const prod = parse(['--prod']);
  if (typeof prod === 'string') return { status: 'error', reason: prod, target, findings: [] };
  writeFileSync(join(out, 'audit.json'), JSON.stringify(all, null, 2));
  const findings = fromAudit(all, new Set(Object.keys(prod.advisories ?? {})));
  return withFindings({ target, tool: `pnpm ${pnpm(['--version']).out}`, report: rel(join(out, 'audit.json')), findings });
}

function runScout(): Outcome {
  const target = `image \`${imageName}\``;
  const image = imageState();
  if (!image.ok) return unavailable(image.reason, target);
  if (run('docker', ['scout', 'version']).status !== 0) return unavailable('the docker scout plugin is not installed', target);
  const sarifPath = join(out, 'scout.sarif');
  log(`$ docker scout cves ${imageName} --format sarif --output ${rel(sarifPath)}`);
  const r = run('docker', ['scout', 'cves', imageName, '--format', 'sarif', '--output', sarifPath]);
  if (r.status !== 0) return { status: 'error', reason: `docker scout failed: ${tail(r.err)}`, target: image.target, findings: [] };
  const sarif = JSON.parse(readFileSync(sarifPath, 'utf8')) as ScoutSarif;
  const driver = sarif.runs[0]?.tool.driver;
  return withFindings({
    target: image.target,
    tool: driver ? `${driver.name ?? 'docker scout'} ${driver.version ?? ''}`.trim() : undefined,
    report: rel(sarifPath),
    findings: fromScout(sarif, imageName),
  });
}

function runSecrets(): Outcome {
  const resultsPath = join(root, '.data', 'gitleaks', 'results.json');
  const started = Date.now();
  const r = script('gitleaks.mts', ['--image', imageName]);
  if (r.status !== 0 && r.status !== 1)
    return { status: 'error', reason: `scripts/gitleaks.mts exited with ${r.status}`, target: 'secrets', findings: [] };
  if (statSync(resultsPath).mtimeMs < started - 1000)
    return { status: 'error', reason: 'gitleaks wrote no results', target: 'secrets', findings: [] };
  const results = JSON.parse(readFileSync(resultsPath, 'utf8')) as GitleaksResults;
  const scanned = results.scans.map((s) => (s.skipped ? `${s.scan} (skipped: ${s.skipped})` : s.scan));
  return withFindings({
    target: `git ${scanned.join(', ')}`,
    tool: `gitleaks ${results.gitleaks}`,
    report: '.data/gitleaks/report.md',
    findings: fromGitleaks(results),
  });
}

function runCodeql(): Outcome {
  const started = Date.now();
  const r = script('codeql.mts', ['--report', 'md,html']);
  const target = 'the sources, security-extended queries';
  if (r.status !== 0 && r.status !== 1) {
    const reason =
      r.status === 2 ? 'CodeQL CLI missing, or another scan running (see the output above)' : `scripts/codeql.mts exited with ${r.status}`;
    return r.status === 2 ? unavailable(reason, target) : { status: 'error', reason, target, findings: [] };
  }
  const loaded = loadFindings(join(root, '.data', 'codeql', 'results.sarif'), root);
  if (!loaded || loaded.info.scanTime < started - 1000) return { status: 'error', reason: 'CodeQL wrote no results', target, findings: [] };
  return withFindings({
    target: `${target}${loaded.info.filesExtracted ? `, ${loaded.info.filesExtracted} files` : ''}`,
    tool: `CodeQL ${loaded.info.codeqlVersion ?? ''}`.trim(),
    report: '.data/codeql/results.md',
    findings: fromCodeql(loaded.findings),
  });
}

const RUNNERS: Record<Check, () => Outcome> = { audit: runAudit, scout: runScout, secrets: runSecrets, codeql: runCodeql };
const TITLES: Record<Check, string> = {
  audit: 'pnpm audit (dependencies)',
  scout: 'Docker Scout (image CVEs)',
  secrets: 'gitleaks (history, tree, image)',
  codeql: 'CodeQL (sources; long when the database must be rebuilt)',
};

// ---------- main

mkdirSync(checksDir, { recursive: true });
log(
  reportOnly
    ? 'Security report from the last results'
    : `Security checks: ${selected.join(', ')} · ${branch ?? '?'} at ${commit ?? '?'}${dirty ? ' + uncommitted changes' : ''}`,
);

let buildFailed = false;
if (opts.build && needsImage) {
  step(`Build image ${imageName}`, () => {
    const args = ['build', '--pull', '-t', imageName, '.']; // no settings at build time: see the Dockerfile
    log(`$ docker ${args.join(' ')}`);
    const r = run('docker', args, { inherit: true });
    if (r.status !== 0) {
      log(`✖ docker build failed (exit ${r.status}): scout and the image scan use the previous image, if any`);
      buildFailed = true;
    }
  });
}

const ranNow: CheckResult[] = [];
for (const check of selected) {
  step(TITLES[check], () => {
    const start = performance.now();
    let outcome: Outcome;
    try {
      outcome = RUNNERS[check]();
    } catch (e) {
      outcome = { status: 'error', reason: (e as Error).message, target: check, findings: [] };
    }
    const result: CheckResult = { check, ...outcome, ranAt: Date.now(), commit, dirty, ms: performance.now() - start };
    writeFileSync(join(checksDir, `${check}.json`), JSON.stringify(result, null, 2));
    ranNow.push(result);
    const what = result.status === 'findings' ? `${result.findings.length} finding(s)` : result.status;
    log(`  ${check}: ${what}${result.reason ? ` (${result.reason})` : ''}`);
  });
}

const report = step('Write the report', () => {
  const results: Partial<Record<Check, CheckResult>> = {};
  for (const c of CHECKS) {
    try {
      results[c] = JSON.parse(readFileSync(join(checksDir, `${c}.json`), 'utf8')) as CheckResult;
    } catch {
      // never run: shown as such
    }
  }
  let suppressions: Suppression[] = [];
  try {
    suppressions = (JSON.parse(readFileSync(suppressionsFile, 'utf8')) as { suppressions?: Suppression[] }).suppressions ?? [];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`${rel(suppressionsFile)} is not valid JSON: ${(e as Error).message}`);
      process.exit(2);
    }
  }
  const all = Object.values(results).flatMap((r) => r.findings);
  const checksRun = new Set(
    Object.values(results)
      .filter((r) => r.status === 'clean' || r.status === 'findings')
      .map((r) => r.check),
  );
  const s = applySuppressions(all, suppressions, new Date().toISOString().slice(0, 10), checksRun);
  s.open.sort(byPriority);
  s.suppressed.sort((a, b) => byPriority(a.finding, b.finding));

  const generatedAt = Date.now();
  const reportPath = join(out, 'report.md');
  const jsonPath = join(out, 'findings.json');
  writeFileSync(reportPath, renderReport(results, s, { generatedAt, commit, dirty, branch, rootFromReport: '../..' }));
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date(generatedAt).toISOString(),
        commit,
        dirty,
        branch,
        checks: CHECKS.map((c) => {
          const r = results[c];
          if (!r) return { check: c, status: 'not-run' };
          const { findings, ...rest } = r;
          return { ...rest, ranAt: new Date(r.ranAt).toISOString(), ms: Math.round(r.ms), findings: findings.length };
        }),
        open: s.open,
        suppressed: s.suppressed.map(({ finding, suppression }) => ({ ...finding, suppression })),
        suppressionProblems: [
          ...s.unused.map((x) => ({ id: x.id, problem: 'matches no current finding' })),
          ...s.expired.map((x) => ({ id: x.id, problem: `expired on ${x.expires}` })),
          ...s.invalid.map((x) => ({ id: x.suppression.id, problem: x.problem })),
        ],
      },
      null,
      2,
    ),
  );
  return { reportPath, jsonPath, s, results };
});

// ---------- summary

console.log('\nChecks:');
for (const c of CHECKS) {
  const r = report.results[c];
  const now = ranNow.some((x) => x.check === c) ? '' : r ? ` (from ${new Date(r.ranAt).toLocaleString('en-GB')})` : '';
  const state = !r ? 'not run yet' : r.status === 'findings' ? `${r.findings.length} finding(s)` : r.status;
  console.log(`  ${c.padEnd(8)} ${state}${r?.reason ? `: ${r.reason}` : ''}${now}`);
}
const { s } = report;
console.log(`\nOpen findings: ${s.open.length}${s.suppressed.length ? ` · suppressed: ${s.suppressed.length}` : ''}`);
for (const f of s.open.slice(0, 15)) console.log(`  ${f.id}  ${f.severity.padEnd(8)} ${f.area.padEnd(15)} ${f.title} · ${f.location}`);
if (s.open.length > 15) console.log(`  … and ${s.open.length - 15} more in the report`);
if (s.open.some((f) => f.rotate))
  console.log('\n🔑 Secrets to rotate: see the report. Removing a committed or shipped key does not undo the exposure.');
const problems = s.unused.length + s.expired.length + s.invalid.length;
if (problems) console.log(`\n${problems} problem(s) in ${rel(suppressionsFile)}: see the end of the report.`);
console.log(`\nReport:   ${report.reportPath}   (Ctrl+Shift+V in VS Code for the preview)`);
console.log(`Findings: ${report.jsonPath}\n`);
log(`Done in ${fmt(elapsed())}`);

const failed = ranNow.some((r) => r.status === 'error') || buildFailed;
process.exit(failed ? 2 : s.open.length ? 1 : 0);
