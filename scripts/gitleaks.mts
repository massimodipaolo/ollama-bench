/**
 * Secret scans with gitleaks, beyond the two that already run on every change: the pre-commit hook (staged changes)
 * and the GitHub workflow (the commits of each push and pull request).
 *
 *   pnpm security:secrets                         # history + tree + image
 *   pnpm security:secrets history tree            # some of them
 *   pnpm security:secrets image --image my-tag    # another local image (default <folder>:local, e.g. ollama-bench:local)
 *
 *   history  every commit of every branch and tag: also commits made before the hook existed, or with --no-verify
 *   tree     the working tree including git-ignored files: build output (.next), .data (reports, CodeQL database),
 *            logs, anything that could be committed, pasted or shipped by mistake
 *   image    the filesystem of a local Docker image (`docker export`): checks that no secret was baked in
 *
 * Besides gitleaks' default rules, every scan looks for the literal values of the secrets in .env and .env.docker
 * (plus any --env-file): "own secrets", found wherever they were copied, even in a format no rule recognises. The values reach
 * gitleaks only through an environment variable (GITLEAKS_CONFIG_TOML), never a file, and every report is redacted.
 *
 * Report: .data/gitleaks/report.md on every run (all scans, findings with links and fingerprints, what was skipped),
 * plus gitleaks' raw report per scan in .data/gitleaks/<scan>.json. False positives: add the fingerprint to
 * .gitleaksignore.
 * Exit code: 0 clean · 1 findings · 2 usage error, gitleaks missing, or the image missing when `image` was asked for.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createSteps, fmt } from './cli-steps.mjs';

const SCANS = ['history', 'tree', 'image'] as const;
type Scan = (typeof SCANS)[number];

const USAGE = `Usage: pnpm security:secrets [history] [tree] [image] [--image <name>] [--env-file <path>]...

  history            every commit of every branch and tag
  tree               the working tree, git-ignored files included (.next, .data, logs…)
  image              the filesystem of a local Docker image
  (none)             all three; image is skipped with a note when the image isn't built
  --image <name>     image to scan (default <folder>:local, as the docker:build task names it: ollama-bench:local)
  --env-file <path>  another file to read own secrets from, besides .env and .env.docker (repeatable); the tree
                     scan skips all of them, the other scans don't
  -h, --help`;

let parsed: { values: { image?: string; 'env-file'?: string[]; help?: boolean }; positionals: string[] };
try {
  parsed = parseArgs({
    options: {
      image: { type: 'string' },
      'env-file': { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });
} catch (e) {
  console.error(`${(e as Error).message}\n\n${USAGE}`);
  process.exit(2);
}
if (parsed.values.help) {
  console.log(USAGE);
  process.exit(0);
}
const unknown = parsed.positionals.find((p) => !SCANS.includes(p as Scan));
if (unknown !== undefined) {
  console.error(`Unknown scan "${unknown}": use ${SCANS.join(', ')}.\n\n${USAGE}`);
  process.exit(2);
}
const explicit = parsed.positionals.length > 0;
const scans: Scan[] = explicit ? SCANS.filter((s) => parsed.positionals.includes(s)) : [...SCANS];

const root = resolve(import.meta.dirname, '..');
// same naming as the VS Code docker tasks: <workspace folder>:local (Docker wants lowercase)
const imageName = parsed.values.image ?? `${basename(root).toLowerCase()}:local`;
const outRel = join('.data', 'gitleaks');
const out = join(root, outRel);

const { log, step, elapsed } = createSteps(scans.length);

// ---------- own secrets: the values in .env / .env.docker

/** Variables whose value is treated as a secret. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i;
const ENV_FILES = [...new Set(['.env', '.env.docker', ...(parsed.values['env-file'] ?? [])])];

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The env files inside the repository, as path patterns for the tree scan's allowlist. */
function envFilePatterns(): string[] {
  return ENV_FILES.map((f) => relative(root, resolve(root, f)))
    .filter((rel) => rel && !rel.startsWith('..') && !isAbsolute(rel))
    .map(
      (rel) =>
        `^${rel
          .split(/[\\/]/)
          .map(escapeRegex)
          .join(String.raw`[\\/]`)}$`,
    );
}

interface OwnSecret {
  id: string;
  name: string;
  source: string;
  value: string;
}

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

function ownSecrets(): OwnSecret[] {
  const found: OwnSecret[] = [];
  const seen = new Set<string>();
  for (const source of ENV_FILES) {
    const text = readIfExists(resolve(root, source));
    if (!text) continue;
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m || !SECRET_NAME.test(m[1])) continue;
      let value = m[2].trim();
      value = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value.replace(/\s+#.*$/, '');
      // too short to search for without false positives; or a reference to another variable, not a value
      if (value.length < 8 || value.includes('${') || value.includes("'''") || seen.has(value)) continue;
      seen.add(value);
      const base = `own-secret-${m[1].toLowerCase().replace(/_/g, '-')}`;
      // the same variable with another value in another env file: tell them apart by the file name
      let id = base;
      for (let i = 2; found.some((s) => s.id === id); i++) id = `${base}-${basename(source).replace(/\W/g, '')}${i > 2 ? i : ''}`;
      found.push({ id, name: m[1], source, value });
    }
  }
  return found;
}

// ---------- gitleaks config: default rules + own secrets + per-scan allowlists

interface Allowlist {
  description: string;
  paths: string[];
}

// paths as gitleaks reports them: relative to the scanned directory, `!` between an archive and a file inside it
const NODE_MODULES: Allowlist = {
  description: 'third-party packages (pnpm audit and Docker Scout cover them)',
  paths: [String.raw`(^|[\\/!])node_modules[\\/]`],
};
const NEXT_KEYS: Allowlist = {
  description: 'keys Next.js generates for each build (preview mode, server actions encryption), not ours',
  paths: [
    String.raw`(^|[\\/!])\.next[\\/](.*[\\/])?(preview-props\.json|server-reference-manifest\.json|prerender-manifest\.json|\.rscinfo|\.previewinfo)$`,
  ],
};
const SOURCE_MAPS: Allowlist = {
  description: 'source maps repeat the code next to them, which is scanned (their copies of libraries trip generic rules)',
  paths: [String.raw`\.js\.map$`],
};

const ALLOWLISTS: Record<Scan, Allowlist[]> = {
  history: [], // a committed .env, build output or anything else is a finding
  tree: [
    { description: 'where secrets belong: the env files the own secrets are read from', paths: envFilePatterns() },
    { description: "git's own files: the history scan reads the commits", paths: [String.raw`^\.git[\\/]`] },
    {
      // next build traces .data/datasets into the standalone output (src/lib/tests/datasets.ts reads it by path)
      description: 'downloaded third-party datasets, and the copy a local next build puts in .next/standalone',
      paths: [String.raw`^(\.next[\\/]standalone[\\/])?\.data[\\/]datasets[\\/]`],
    },
    { description: "this script's reports and the image export", paths: [String.raw`^\.data[\\/]gitleaks[\\/]`] },
    NODE_MODULES,
    NEXT_KEYS,
    SOURCE_MAPS,
  ],
  image: [NODE_MODULES, NEXT_KEYS, SOURCE_MAPS],
};

const tomlString = (s: string) => JSON.stringify(s); // a JSON string is a valid TOML basic string

function gitleaksConfig(own: OwnSecret[], allowlists: Allowlist[]): string {
  const lines = ['[extend]', 'useDefault = true', ''];
  for (const s of own) {
    lines.push(
      '[[rules]]',
      `id = ${tomlString(s.id)}`,
      `description = ${tomlString(`Value of ${s.name} from ${s.source}`)}`,
      `regex = '''${escapeRegex(s.value)}'''`,
      '',
    );
  }
  for (const a of allowlists.filter((x) => x.paths.length)) {
    // e.g. no env file inside the repository: gitleaks rejects an allowlist without checks
    lines.push(
      '[[allowlists]]',
      `description = ${tomlString(a.description)}`,
      `paths = [${a.paths.map((p) => `'''${p}'''`).join(', ')}]`,
      '',
    );
  }
  return lines.join('\n');
}

// ---------- running gitleaks

interface Leak {
  RuleID: string;
  Description: string;
  File: string;
  StartLine: number;
  Commit?: string;
  Fingerprint: string;
}

interface ScanResult {
  scan: Scan;
  /** what was scanned, in words */
  target: string;
  leaks?: Leak[];
  skipped?: string;
  report?: string;
  ms: number;
}

const LEAK_EXIT = 3; // distinguishes "found something" from gitleaks' own errors (exit 1)

function gitleaks(scan: Scan, args: string[], config: string): Leak[] {
  const reportRel = join(outRel, `${scan}.json`);
  const env: NodeJS.ProcessEnv = { ...process.env, GITLEAKS_CONFIG_TOML: config };
  delete env.GITLEAKS_CONFIG; // it would take precedence over GITLEAKS_CONFIG_TOML
  const full = [...args, '--redact', '--no-banner', '--exit-code', String(LEAK_EXIT), '-f', 'json', '-r', reportRel];
  log(`$ gitleaks ${full.join(' ')}`);
  const r = spawnSync('gitleaks', full, { cwd: root, env, stdio: 'inherit' });
  if (r.status !== 0 && r.status !== LEAK_EXIT) {
    log(`✖ gitleaks exited with ${r.status ?? r.signal ?? r.error?.message}`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(join(root, reportRel), 'utf8')) as Leak[];
}

function docker(args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync('docker', args, { cwd: root, encoding: 'utf8' });
  return { ok: r.status === 0, out: r.stdout?.trim() ?? '', err: (r.stderr || r.error?.message || '').trim() };
}

function runScan(scan: Scan, own: OwnSecret[]): ScanResult {
  const start = performance.now();
  const config = gitleaksConfig(own, ALLOWLISTS[scan]);
  const done = (r: Omit<ScanResult, 'scan' | 'ms'>): ScanResult => ({ scan, ms: performance.now() - start, ...r });
  const report = join(out, `${scan}.json`);

  if (scan === 'history') {
    const commits = spawnSync('git', ['rev-list', '--all', '--count'], { cwd: root, encoding: 'utf8' }).stdout?.trim();
    const target = `${commits ?? '?'} commits on every branch and tag`;
    log(`  ${target}`);
    return done({ target, leaks: gitleaks(scan, ['git', '--log-opts=--all', '.'], config), report });
  }

  if (scan === 'tree') {
    return done({ target: 'working tree, git-ignored files included', leaks: gitleaks(scan, ['dir', '.'], config), report });
  }

  const target = `Docker image \`${imageName}\``;

  // image: export the filesystem of a container created (not started) from it, then scan the tar
  if (!docker(['image', 'inspect', imageName]).ok) {
    const why = `no local image "${imageName}": build it first (VS Code task docker:build, or docker build)`;
    if (explicit) {
      console.error(why);
      process.exit(2);
    }
    log(`  skipped: ${why}`);
    return done({ target, skipped: why });
  }
  const tarRel = join(outRel, 'image.tar'); // a fixed path keeps .gitleaksignore fingerprints stable
  const created = docker(['create', imageName]);
  if (!created.ok) throw new Error(`docker create failed: ${created.err}`);
  try {
    log(`  exporting the filesystem of ${imageName}`);
    const exported = docker(['export', created.out, '-o', tarRel]);
    if (!exported.ok) throw new Error(`docker export failed: ${exported.err}`);
    return done({ target, leaks: gitleaks(scan, ['dir', tarRel, '--max-archive-depth', '1'], config), report });
  } finally {
    docker(['rm', created.out]);
    rmSync(join(root, tarRel), { force: true }); // about 1 GB
  }
}

// ---------- Markdown report: every run, clean or not. Names and paths only: never a secret value.

const isOwn = (l: Leak) => l.RuleID.startsWith('own-secret-');
const mdEscape = (s: string) =>
  s
    .replace(/([\\`*_[\]|])/g, '\\$1')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;

/** Path as reported, made readable: forward slashes, and for the image the path inside it. */
const leakPath = (l: Leak) => l.File.split('!').pop()!.replace(/\\/g, '/');

const location = (l: Leak) => `${leakPath(l)}:${l.StartLine}${l.Commit ? ` @ ${l.Commit.slice(0, 8)}` : ''}`;

function markdownLocation(scan: Scan, l: Leak, reportPath: string): string {
  const where = `${leakPath(l)}:${l.StartLine}`;
  if (scan !== 'tree') return code(where); // a file at some commit, or inside the image: nothing local to open
  const rel = relative(dirname(reportPath), join(root, leakPath(l))).replace(/\\/g, '/');
  return `[${mdEscape(where)}](${encodeURI(rel)}#L${l.StartLine})`;
}

function renderMarkdown(results: ScanResult[], own: OwnSecret[], meta: { gitleaks: string; ms: number }, reportPath: string): string {
  const total = results.reduce((n, r) => n + (r.leaks?.length ?? 0), 0);
  const ownHits = results.reduce((n, r) => n + (r.leaks ?? []).filter(isOwn).length, 0);
  const head = git(['rev-parse', '--short', 'HEAD']);
  const dirty = git(['status', '--porcelain']);
  const md: string[] = ['# Secret scan report', ''];

  md.push(`- **Run:** ${new Date().toLocaleString('en-GB')} · ${fmt(meta.ms)}`);
  if (head) md.push(`- **Commit:** ${head}${dirty ? ' + uncommitted changes' : ''}`);
  md.push(`- **gitleaks:** ${meta.gitleaks}, default rules${own.length ? ` + ${own.length} own-secret rule(s)` : ''}`);
  md.push(
    own.length
      ? `- **Own secrets searched** (names only, values never shown): ${own.map((s) => `${code(s.name)} (${mdEscape(s.source)})`).join(', ')}`
      : `- **Own secrets searched:** none, no secret values in ${ENV_FILES.map(code).join(' / ')}`,
  );

  md.push('', '## Summary', '');
  md.push(
    total
      ? `**❌ ${total} finding(s)**${ownHits ? `, of which **${ownHits} own secret(s)**: real keys outside their env file` : ''}`
      : results.some((r) => r.skipped)
        ? '**✅ No findings** in the scans that ran (one was skipped, see below)'
        : '**✅ Clean:** no findings',
  );
  md.push('', '| Scan | Scanned | Result | Time | Raw report |', '|---|---|---|---|---|');
  for (const r of results) {
    const result = r.skipped ? `⏭ skipped: ${mdEscape(r.skipped)}` : r.leaks?.length ? `❌ ${r.leaks.length} finding(s)` : '✅ clean';
    const raw = r.report ? `[${r.scan}.json](${r.scan}.json)` : '—';
    md.push(`| ${r.scan} | ${r.target} | ${result} | ${fmt(r.ms)} | ${raw} |`);
  }

  if (total) {
    md.push('', '## Findings');
    for (const r of results.filter((x) => x.leaks?.length)) {
      md.push('', `### ${r.scan} (${r.leaks!.length})`, '');
      const commitCol = r.scan === 'history';
      md.push(`| Kind | Rule | Location |${commitCol ? ' Commit |' : ''} Fingerprint |`, `|---|---|---|${commitCol ? '---|' : ''}---|`);
      // own secrets first: they are the ones that certainly need action
      for (const l of [...r.leaks!].sort((a, b) => Number(isOwn(b)) - Number(isOwn(a)))) {
        const kind = isOwn(l) ? '🔑 **own secret**' : 'rule match';
        const rule = isOwn(l) ? mdEscape(l.Description) : code(l.RuleID);
        const commit = commitCol ? ` ${code(l.Commit?.slice(0, 8) ?? '?')} |` : '';
        md.push(`| ${kind} | ${rule} | ${markdownLocation(r.scan, l, reportPath)} |${commit} ${code(l.Fingerprint)} |`);
      }
    }
    md.push('', '## What to do', '');
    md.push(
      "- **Own secret:** a real key outside its env file. Remove that copy. If it was committed, pushed or shipped in an image, **rotate the key**: removing it doesn't undo the exposure.",
      '- **Rule match:** check it. A false positive goes in `.gitleaksignore`, one fingerprint per line (the Fingerprint column).',
    );
  }

  md.push('', '## Not scanned', '', 'Allowlisted paths, per scan (everything else was scanned):', '');
  for (const r of results.filter((x) => !x.skipped)) {
    const lists = ALLOWLISTS[r.scan].filter((a) => a.paths.length);
    md.push(`- **${r.scan}:**${lists.length ? '' : ' nothing skipped'}`);
    for (const a of lists) md.push(`  - ${mdEscape(a.description)}: ${a.paths.map(code).join(', ')}`);
  }
  md.push('', 'Fingerprints in `.gitleaksignore` are skipped too.', '');
  return md.join('\n');
}

function git(args: string[]): string | undefined {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

// ---------- main

const version = spawnSync('gitleaks', ['version'], { encoding: 'utf8' });
if (version.status !== 0) {
  console.error('gitleaks not found: install it (https://github.com/gitleaks/gitleaks#installing).');
  process.exit(2);
}
mkdirSync(out, { recursive: true });

log(`Secret scan · ${scans.join(', ')}${scans.includes('image') ? ` · image ${imageName}` : ''}`);
const own = ownSecrets();
log(
  own.length
    ? `  also searching for ${own.length} own secret value(s): ${own.map((s) => `${s.name} (${s.source})`).join(', ')}`
    : `  no secret values in ${ENV_FILES.join(' / ')}: default rules only`,
);

const results = scans.map((scan) => step(`Scan ${scan}`, () => runScan(scan, own)));

const reportPath = join(out, 'report.md');
writeFileSync(reportPath, renderMarkdown(results, own, { gitleaks: version.stdout.trim(), ms: elapsed() }, reportPath));
// for `pnpm security` (scripts/security.mts): what ran and what it found, with only the fields named here (gitleaks'
// own JSON also carries the matched text, redacted but still not needed)
writeFileSync(
  join(out, 'results.json'),
  JSON.stringify(
    {
      gitleaks: version.stdout.trim(),
      image: imageName,
      scans: results.map((r) => ({
        scan: r.scan,
        target: r.target,
        skipped: r.skipped,
        ms: Math.round(r.ms),
        leaks: r.leaks?.map((l) => ({
          rule: l.RuleID,
          description: l.Description,
          own: isOwn(l),
          file: leakPath(l),
          line: l.StartLine,
          commit: l.Commit || undefined,
          fingerprint: l.Fingerprint,
        })),
      })),
    },
    null,
    2,
  ),
);

console.log('\nResults:');
for (const r of results) {
  const head = `  ${r.scan.padEnd(8)}`;
  if (r.skipped) {
    console.log(`${head} skipped (${r.skipped})`);
    continue;
  }
  const leaks = r.leaks ?? [];
  console.log(`${head} ${leaks.length ? `${leaks.length} finding(s)` : 'clean'} (${fmt(r.ms)}) · report: ${r.report}`);
  for (const l of leaks) {
    console.log(`    [${isOwn(l) ? `OWN SECRET: ${l.Description}` : l.RuleID}] ${location(l)}`);
    console.log(`      fingerprint: ${l.Fingerprint}`);
  }
}

const total = results.reduce((n, r) => n + (r.leaks?.length ?? 0), 0);
if (total) {
  console.log(
    '\nAn OWN SECRET finding is a real key outside its .env file: remove it there, and rotate the key if that copy was' +
      ' committed, pushed or shipped. Other findings: check them; a false positive goes in .gitleaksignore (fingerprint).',
  );
}
console.log(`\nReport: ${reportPath}   (Ctrl+Shift+V in VS Code for the preview)\n`);
log(`Done in ${fmt(elapsed())}`);
process.exit(total ? 1 : 0);
