/**
 * Local CodeQL scan (too slow for a pre-commit hook: GitHub runs it on every pull request).
 *
 *   pnpm security:codeql            # build the database, run the security-extended queries, list the findings
 *
 * The CLI comes from $CODEQL, then PATH, then the default Windows install (%LOCALAPPDATA%\codeql). Query packs are
 * downloaded on first use. Database and SARIF report go to .data/codeql/ (git-ignored). Exits 1 when it finds anything.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = join(root, '.data', 'codeql');
const db = join(out, 'db');
const sarif = join(out, 'results.sarif');
const config = join(out, 'config.yml');
const suite = 'codeql/javascript-queries:codeql-suites/javascript-security-extended.qls';

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
  console.log(`$ codeql ${args.join(' ')}`);
  const r = spawnSync(cli, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const cli = findCli();
mkdirSync(out, { recursive: true });

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
writeFileSync(config, ['paths-ignore:', '  - node_modules', '  - .next', '  - .data', ''].join('\n'));

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
codeql(cli, ['database', 'analyze', db, suite, '--download', '--format=sarif-latest', `--output=${sarif}`]);

interface SarifResult {
  ruleId: string;
  level?: string;
  message: { text: string };
  locations?: { physicalLocation: { artifactLocation: { uri: string }; region?: { startLine?: number } } }[];
}
const results: SarifResult[] = JSON.parse(readFileSync(sarif, 'utf8')).runs.flatMap((r: { results: SarifResult[] }) => r.results);
console.log(`\n${results.length} finding(s) · report: ${sarif}`);
for (const r of results) {
  const loc = r.locations?.[0]?.physicalLocation;
  const where = loc ? `${loc.artifactLocation.uri}:${loc.region?.startLine ?? '?'}` : '(no location)';
  console.log(`  [${r.level ?? 'warning'}] ${r.ruleId}  ${where}\n    ${r.message.text.split('\n')[0]}`);
}
process.exit(results.length ? 1 : 0);
