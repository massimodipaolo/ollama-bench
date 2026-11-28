/**
 * Local CodeQL scan (too slow for a pre-commit hook: GitHub runs it on every pull request).
 *
 *   pnpm security:codeql                      # build the database (only if the sources changed), analyze, list the findings
 *   pnpm security:codeql --rebuild            # always rebuild the database
 *   pnpm security:codeql --report md,html     # also write .data/codeql/results.md / results.html (or --report md, --report html)
 *   pnpm security:codeql --report-only        # no scan: rewrite the reports from the last results.sarif (default md,html)
 *
 * The CLI comes from $CODEQL, then PATH, then the default Windows install (%LOCALAPPDATA%\codeql). Query packs are
 * downloaded on first use. Database, SARIF and reports go to .data/codeql/ (git-ignored). Exits 1 when it finds
 * anything, 2 on a usage error, a missing CLI or a scan already running.
 *
 * CodeQL can't update a JavaScript database incrementally, so any change means a full rebuild. To skip the rebuild when
 * nothing changed, the script fingerprints the files git sees (tracked plus untracked, not ignored), the CLI and the
 * config. A change to a git-ignored file that CodeQL still extracts isn't detected: use --rebuild for that.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createSteps, fmt } from './cli-steps.mjs';
import {
  REPORT_FORMATS,
  loadFindings,
  plain,
  severityLabel,
  where,
  writeReports,
  type ReportFormat,
  type ReportMeta,
} from './codeql-report.mjs';

const USAGE = `Usage: pnpm security:codeql [--rebuild] [--report md|html|md,html] [--report-only]

  --rebuild        always rebuild the CodeQL database (default: only when the sources changed)
  --report <fmt>   also write a report: md, html, or both (comma-separated or repeated)
  --report-only    skip the scan and rewrite the reports from the last results.sarif (default formats: md,html)
  -h, --help`;

let args: { rebuild?: boolean; report?: string[]; 'report-only'?: boolean; help?: boolean };
try {
  args = parseArgs({
    options: {
      rebuild: { type: 'boolean' },
      report: { type: 'string', multiple: true },
      'report-only': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  }).values;
} catch (e) {
  console.error(`${(e as Error).message}\n\n${USAGE}`);
  process.exit(2);
}
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const reportOnly = !!args['report-only'];
const formats = [
  ...new Set((args.report ?? (reportOnly ? ['md,html'] : [])).flatMap((r) => r.split(',')).map((r) => r.trim().toLowerCase())),
];
const badFormat = formats.find((f) => !REPORT_FORMATS.includes(f as ReportFormat));
if (badFormat !== undefined) {
  console.error(`Unknown report format "${badFormat}": use ${REPORT_FORMATS.join(', ')} (comma-separated for both).\n\n${USAGE}`);
  process.exit(2);
}
if (reportOnly && args.rebuild) {
  console.error('--report-only skips the scan, so --rebuild has no effect: drop one of them.');
  process.exit(2);
}
const reportFormats = formats as ReportFormat[];

const root = resolve(import.meta.dirname, '..');
const out = join(root, '.data', 'codeql');
const db = join(out, 'db');
const fingerprintFile = join(out, 'db.fingerprint');
const sarif = join(out, 'results.sarif');
const reportBase = join(out, 'results');
const config = join(out, 'config.yml');
const suite = 'codeql/javascript-queries:codeql-suites/javascript-security-extended.qls';
const forceRebuild = !!args.rebuild;

const { log, step, elapsed } = createSteps((reportOnly ? 1 : 4) + (reportFormats.length ? 1 : 0));

function findCli(): string {
  if (process.env.CODEQL) return process.env.CODEQL;
  // on Windows the PATH also holds an extension-less `codeql` shell script, which can't be spawned: ask for the .exe
  if (process.platform === 'win32') {
    const where = spawnSync('where.exe', ['codeql.exe'], { encoding: 'utf8' });
    const exe = where.status === 0 ? where.stdout.split(/\r?\n/)[0].trim() : '';
    if (exe) return exe;
  } else if (spawnSync('codeql', ['version'], { stdio: 'ignore' }).status === 0) return 'codeql';
  const win = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'codeql', 'codeql.exe');
  if (win && existsSync(win)) return win;
  console.error('CodeQL CLI not found: install it (https://github.com/github/codeql-cli-binaries), or set CODEQL to its path.');
  process.exit(2);
}

function codeql(cli: string, args: string[]) {
  log(`$ codeql ${args.join(' ')}`);
  const r = spawnSync(cli, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) {
    log(`✖ codeql exited with ${r.status ?? r.signal ?? r.error?.message} after ${fmt(elapsed())}`);
    process.exit(r.status ?? 1);
  }
}

function git(args: string[]): string | undefined {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

/** Hash of everything the database depends on: the source files git sees, the CLI and the extractor config. */
function sourceFingerprint(cli: string, configText: string): { hash: string; files: number } {
  const ls = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  if (ls.status !== 0) throw new Error(`git ls-files failed: ${ls.stderr}`);
  const files = ls.stdout.split('\0').filter(Boolean).sort();
  const h = createHash('sha256')
    .update(`cli:${cli}:${statSync(cli, { throwIfNoEntry: false })?.mtimeMs ?? ''}\n`)
    .update(`config:${configText}\n`);
  let count = 0;
  for (const f of files) {
    // read directly rather than checking first: a check followed by a read races with a change in between
    let data: Buffer;
    try {
      data = readFileSync(join(root, f));
    } catch (e) {
      if (isMissing(e)) continue; // deleted from the working tree, or a submodule (a directory)
      throw e;
    }
    h.update(`${f}\0`).update(data).update('\0');
    count++;
  }
  return { hash: h.digest('hex'), files: count };
}

function isMissing(e: unknown): boolean {
  return ['ENOENT', 'EISDIR'].includes((e as NodeJS.ErrnoException).code ?? '');
}

/** The file's text, or '' if it doesn't exist. */
function readIfExists(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if (isMissing(e)) return '';
    throw e;
  }
}

const meta: ReportMeta = [];

log(
  `CodeQL ${reportOnly ? 'report' : 'scan'} · root ${root}${forceRebuild ? ' · --rebuild' : ''}${reportFormats.length ? ` · report ${reportFormats.join(',')}` : ''}`,
);
mkdirSync(out, { recursive: true });

if (reportOnly) {
  const lock = join(out, 'scan.lock');
  if (existsSync(lock)) log(`  note: a scan is running (${lock}); this report uses the previous results`);
} else {
  const cli = step('Locate CodeQL CLI', () => {
    const found = findCli();
    log(`  using ${found}`);
    return found;
  });

  // one scan at a time: two would rebuild the same database under each other
  const lock = join(out, 'scan.lock');
  try {
    writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' });
  } catch {
    console.error(`Another CodeQL scan is running (${lock} exists). If none is, a scan crashed: delete the file and retry.`);
    process.exit(2);
  }
  process.on('exit', () => rmSync(lock, { force: true }));
  process.on('SIGINT', () => process.exit(130));

  // what the extractor skips: dependencies, build output, downloaded datasets and the tests' sample files
  const configText = ['paths-ignore:', '  - node_modules', '  - .next', '  - .data', ''].join('\n');
  writeFileSync(config, configText);

  const dbState = step('Build database', () => {
    const fp = sourceFingerprint(cli, configText);
    const dbExists = existsSync(join(db, 'codeql-database.yml'));
    const previous = readIfExists(fingerprintFile).trim();
    log(`  fingerprint ${fp.hash.slice(0, 12)} over ${fp.files} files (previous: ${previous ? previous.slice(0, 12) : 'none'})`);

    if (!forceRebuild && dbExists && previous === fp.hash) {
      log('  sources unchanged since the last build: reusing the database (pass --rebuild to force)');
      return 'reused (sources unchanged)';
    }
    const why = forceRebuild ? '--rebuild given' : !dbExists ? 'no database yet' : 'sources changed';
    log(`  rebuilding: ${why}`);
    rmSync(fingerprintFile, { force: true }); // a failed build must not leave a fingerprint that matches a broken database
    codeql(cli, [
      'database',
      'create',
      db,
      '--language=javascript-typescript',
      `--source-root=${root}`,
      `--codescanning-config=${config}`,
      '--overwrite',
      '--quiet', // otherwise one line per extracted file
    ]);
    writeFileSync(fingerprintFile, `${fp.hash}\n`);
    return `rebuilt (${why})`;
  });

  step('Run security-extended queries', () => {
    codeql(cli, [
      'database',
      'analyze',
      db,
      suite,
      '--download',
      '--format=sarif-latest',
      `--output=${sarif}`,
      '--sarif-add-snippets', // the code around each location, for the reports
      '--sarif-include-query-help=always', // each rule's explanation and fix advice, for the reports
    ]);
  });

  const head = git(['rev-parse', '--short', 'HEAD']);
  const dirty = git(['status', '--porcelain']);
  if (head) meta.push(['Commit', `${head}${dirty ? ' + uncommitted changes' : ''}`]);
  meta.push(['Database', dbState]);
}

const loaded = step('Read SARIF results', () => loadFindings(sarif, root));
if (!loaded) {
  // only with --report-only: a scan always writes the file
  console.error(`No ${sarif} yet: run a scan first (pnpm security:codeql --report ${reportFormats.join(',')}).`);
  process.exit(2);
}
const { findings, info } = loaded;
meta.unshift(['Scan finished', new Date(info.scanTime).toLocaleString('en-GB')]);
meta.push(['Query suite', suite]);
if (info.codeqlVersion) meta.push(['CodeQL', info.codeqlVersion]);
meta.push(['Rules run', String(info.rulesRun)]);
if (info.filesExtracted !== undefined) meta.push(['Files scanned', String(info.filesExtracted)]);
if (!reportOnly) meta.push(['Duration', fmt(elapsed())]);
meta.push(['SARIF', sarif]);

const reports = reportFormats.length
  ? step(`Write ${reportFormats.join(' + ')} report`, () => writeReports(reportFormats, reportBase, findings, meta, root))
  : new Map<ReportFormat, string>();

console.log(`\n${findings.length} finding(s)`);
for (const f of findings) {
  console.log(`  [${severityLabel(f)}] ${f.ruleId}  ${where(f.loc)}\n    ${plain(f.message).split('\n')[0]}`);
}

console.log('\nOutput:');
console.log(`  SARIF     ${sarif}`);
if (reports.has('md')) console.log(`  Markdown  ${reports.get('md')}   (Ctrl+Shift+V in VS Code for the preview)`);
if (reports.has('html')) console.log(`  HTML      ${pathToFileURL(reports.get('html')!).href}`);
if (!reports.size) console.log('  (add --report md,html for a readable report)');
console.log();
log(`Done in ${fmt(elapsed())}`);
process.exit(findings.length ? 1 : 0);
