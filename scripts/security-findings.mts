/**
 * The common shape of a security finding, whichever check reported it, and everything `pnpm security`
 * (scripts/security.mts) does with findings that doesn't touch the outside world: converting each tool's output,
 * giving every finding a stable ID, applying suppressions, and rendering the Markdown report. Kept free of side effects
 * so it can be tested on sample tool output (test/scripts/security-findings.test.ts).
 *
 * Never put a secret value in a finding: gitleaks findings carry the rule, the place and the fingerprint only.
 */
import { createHash } from 'node:crypto';
import type { Finding as CodeqlFinding } from './codeql-report.mjs';

export const CHECKS = ['audit', 'scout', 'secrets', 'codeql'] as const;
export type Check = (typeof CHECKS)[number];

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'note'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Where the finding lives: decides who is exposed, and so how urgent the same severity is. */
export type Area =
  | 'app' // src/: runs in the server or the browser
  | 'scripts' // scripts/: CLI tools run by hand
  | 'tests' // test/
  | 'config' // anything else in the repository
  | 'prod-dependency'
  | 'dev-dependency'
  | 'image' // the Docker image
  | 'git-history';

export interface SecurityFinding {
  /** stable across runs while the finding is the same: `<check>-<8 hex>` (what suppressions and commits refer to) */
  id: string;
  check: Check;
  severity: Severity;
  /** CVSS-like 0–10 score, when the tool gives one */
  score?: number;
  area: Area;
  /** the tool's rule or advisory: js/xss, GHSA-…, CVE-…, a gitleaks rule */
  rule: string;
  title: string;
  /** file:line, package@version, or a path inside the image */
  location: string;
  file?: string;
  line?: number;
  package?: { name: string; version: string; ecosystem: string; fixedIn?: string; via?: string[] };
  /** what to do about it, in one or two sentences */
  fix: string;
  /** a fix exists that doesn't need a code change of ours (a version bump, a base image refresh) */
  fixable?: boolean;
  /** a secret that left its env file: removing it isn't enough, the key must be rotated by its owner */
  rotate?: boolean;
  url?: string;
  details?: string;
}

/** One check's outcome, stored per check so a later run of another check doesn't erase it. */
export interface CheckResult {
  check: Check;
  status: 'clean' | 'findings' | 'skipped' | 'error';
  /** why it was skipped or failed */
  reason?: string;
  /** what was scanned, in words */
  target: string;
  ranAt: number;
  commit?: string;
  dirty?: boolean;
  ms: number;
  tool?: string;
  /** the tool's own report, relative to the repository root */
  report?: string;
  findings: SecurityFinding[];
}

export interface Suppression {
  id: string;
  /** why this is acceptable: required, at least a sentence */
  reason: string;
  /** ISO date; after it, the suppression no longer applies */
  expires?: string;
}

export const MIN_REASON = 20;

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8);
const idOf = (check: Check, key: string) => `${check}-${hash(`${check}\0${key}`)}`;

export function areaOfFile(file: string): Area {
  const f = file.replace(/\\/g, '/');
  if (f.startsWith('src/')) return 'app';
  if (f.startsWith('scripts/')) return 'scripts';
  if (f.startsWith('test/')) return 'tests';
  return 'config';
}

/** GitHub's buckets for a 0–10 security-severity score. */
export function severityOfScore(score: number): Severity {
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  return score > 0 ? 'low' : 'note';
}

// ---------- CodeQL (the findings loadFindings() reads from results.sarif)

const codeqlHelp = (rule: string) => `https://codeql.github.com/codeql-query-help/javascript/${rule.replace(/\//g, '-')}/`;

export function fromCodeql(findings: CodeqlFinding[]): SecurityFinding[] {
  return findings.map((f) => {
    const file = f.loc?.file;
    const message = f.message.map((p) => p.text).join('');
    // the line-content hash survives edits elsewhere in the file; without it, fall back to the line number
    const key = `${f.ruleId}\0${file ?? ''}\0${f.fingerprint ?? f.loc?.line ?? ''}`;
    return {
      id: idOf('codeql', key),
      check: 'codeql',
      severity: f.severity,
      score: f.score,
      area: file ? areaOfFile(file) : 'config',
      rule: f.ruleId,
      title: f.ruleName,
      location: file ? `${file}${f.loc?.line ? `:${f.loc.line}` : ''}` : '(no location)',
      file,
      line: f.loc?.line,
      fix: `Fix the code (see the rule's help for the safe pattern). A false positive is suppressed with a reason, never by weakening the check.`,
      url: codeqlHelp(f.ruleId),
      details: [message, f.cwes.length ? f.cwes.join(', ') : '', f.flow.length ? `data flow: ${f.flow.length} steps` : '']
        .filter(Boolean)
        .join(' · '),
    };
  });
}

// ---------- gitleaks (the results.json scripts/gitleaks.mts writes)

export interface GitleaksResults {
  gitleaks: string;
  image: string;
  scans: {
    scan: 'history' | 'tree' | 'image';
    target: string;
    skipped?: string;
    ms: number;
    leaks?: { rule: string; description: string; own: boolean; file: string; line: number; commit?: string; fingerprint: string }[];
  }[];
}

export function fromGitleaks(r: GitleaksResults): SecurityFinding[] {
  return r.scans.flatMap((s) =>
    (s.leaks ?? []).map((l): SecurityFinding => {
      // a copy in the working tree that was never committed or shipped can simply be deleted
      const exposed = s.scan !== 'tree';
      const where = `${l.file}:${l.line}${l.commit ? ` @ ${l.commit.slice(0, 8)}` : ''}`;
      return {
        id: idOf('secrets', l.fingerprint),
        check: 'secrets',
        severity: l.own ? 'critical' : 'high',
        area: s.scan === 'history' ? 'git-history' : s.scan === 'image' ? 'image' : areaOfFile(l.file),
        rule: l.rule,
        title: l.own ? `Own secret outside its env file: ${l.description}` : `Possible secret: ${l.description}`,
        location: s.scan === 'image' ? `${r.image}:${where}` : where,
        file: s.scan === 'tree' ? l.file : undefined,
        line: s.scan === 'tree' ? l.line : undefined,
        rotate: l.own && exposed,
        fix: l.own
          ? exposed
            ? `Remove the copy, and ask the key's owner to rotate it: it was ${s.scan === 'history' ? 'committed' : 'shipped in the image'}, so removing it doesn't undo the exposure. Never paste the value anywhere.`
            : 'Delete this copy (it was never committed): the key belongs only in its env file.'
          : `Check it. A real secret: remove it and rotate it. A false positive: add the fingerprint to .gitleaksignore.`,
        details: `gitleaks fingerprint ${l.fingerprint}`,
      };
    }),
  );
}

// ---------- pnpm audit --json (npm audit v1 format)

export interface AuditAdvisory {
  id: number;
  module_name: string;
  severity: 'info' | 'low' | 'moderate' | 'high' | 'critical';
  title: string;
  url?: string;
  github_advisory_id?: string;
  cves?: string[];
  vulnerable_versions?: string;
  patched_versions?: string;
  recommendation?: string;
  cvss?: { score?: number };
  findings?: { version: string; paths: string[] }[];
}
export interface AuditReport {
  advisories?: Record<string, AuditAdvisory>;
}

const AUDIT_SEVERITY: Record<AuditAdvisory['severity'], Severity> = {
  critical: 'critical',
  high: 'high',
  moderate: 'medium',
  low: 'low',
  info: 'note',
};

/** `prodIds`: the advisories `pnpm audit --prod` also reports; the others reach only dev dependencies. */
export function fromAudit(report: AuditReport, prodIds: Set<string>): SecurityFinding[] {
  return Object.values(report.advisories ?? {}).map((a) => {
    const versions = [...new Set((a.findings ?? []).map((f) => f.version))];
    const paths = (a.findings ?? []).flatMap((f) => f.paths);
    // ". > next > postcss": the direct dependency is the second segment
    const direct = [...new Set(paths.map((p) => p.split(' > ')[1]).filter(Boolean))];
    const isDirect = paths.some((p) => p.split(' > ').length === 2);
    const patched = a.patched_versions && a.patched_versions !== '<0.0.0' ? a.patched_versions : undefined;
    const advisory = a.github_advisory_id ?? `npm-${a.id}`;
    return {
      id: idOf('audit', `${advisory}\0${a.module_name}`),
      check: 'audit',
      severity: AUDIT_SEVERITY[a.severity] ?? 'medium',
      score: a.cvss?.score || undefined,
      area: prodIds.has(String(a.id)) ? 'prod-dependency' : 'dev-dependency',
      rule: advisory,
      title: a.title,
      location: `${a.module_name}@${versions.join(', ') || '?'}`,
      package: { name: a.module_name, version: versions.join(', '), ecosystem: 'npm', fixedIn: patched, via: direct },
      fixable: !!patched,
      fix: !patched
        ? `No patched version yet: check whether the vulnerable code is reachable here, or replace ${a.module_name}.`
        : isDirect
          ? `Upgrade ${a.module_name} to ${patched}.`
          : `Upgrade the dependency that pulls it in (${direct.join(', ')}) to a release with ${a.module_name} ${patched}; if there's none yet, add an override "${a.module_name}": "${patched}" in pnpm-workspace.yaml and run the tests.`,
      url: a.url,
      details: [a.cves?.join(', '), a.vulnerable_versions ? `vulnerable: ${a.vulnerable_versions}` : '', paths.slice(0, 3).join(' · ')]
        .filter(Boolean)
        .join(' · '),
    };
  });
}

// ---------- docker scout cves --format sarif

interface ScoutRule {
  id: string;
  helpUri?: string;
  properties?: {
    'security-severity'?: string;
    cvssV3_severity?: string;
    fixed_version?: string;
    affected_version?: string;
    purls?: string[];
  };
}
export interface ScoutSarif {
  runs: {
    tool: { driver: { name?: string; version?: string; rules?: ScoutRule[] } };
    results?: {
      ruleId: string;
      message?: { text?: string };
      locations?: { physicalLocation?: { artifactLocation?: { uri?: string } } }[];
    }[];
  }[];
}

/** pkg:apk/alpine/musl@1.2.6-r3?os_name=alpine → { ecosystem: apk, name: musl, version: 1.2.6-r3 } */
export function parsePurl(purl: string): { ecosystem: string; name: string; version: string } {
  const m = /^pkg:([^/]+)\/(.+?)@([^?#]+)/.exec(purl);
  if (!m) return { ecosystem: '?', name: purl, version: '?' };
  const name = decodeURIComponent(m[2]);
  // apk/deb packages carry their distribution as a namespace (alpine/musl): keep the package name
  return { ecosystem: m[1], name: m[1] === 'npm' ? name : name.split('/').pop()!, version: decodeURIComponent(m[3]) };
}

export function fromScout(sarif: ScoutSarif, image: string): SecurityFinding[] {
  return sarif.runs.flatMap((run) => {
    const rules = new Map((run.tool.driver.rules ?? []).map((r) => [r.id, r]));
    return (run.results ?? []).map((res): SecurityFinding => {
      const rule = rules.get(res.ruleId);
      const p = rule?.properties ?? {};
      const purl = p.purls?.[0] ?? '';
      const pkg = parsePurl(purl);
      const score = p['security-severity'] !== undefined ? Number(p['security-severity']) : undefined;
      const named = p.cvssV3_severity?.toLowerCase();
      const severity: Severity =
        score !== undefined && !Number.isNaN(score)
          ? severityOfScore(score)
          : (SEVERITIES as readonly string[]).includes(named ?? '')
            ? (named as Severity)
            : 'medium';
      const fixedIn = p.fixed_version && !/not fixed/i.test(p.fixed_version) ? p.fixed_version : undefined;
      const paths = (res.locations ?? []).map((l) => l.physicalLocation?.artifactLocation?.uri).filter(Boolean) as string[];
      return {
        id: idOf('scout', `${res.ruleId}\0${purl.split('?')[0]}`),
        check: 'scout',
        severity,
        score: score !== undefined && !Number.isNaN(score) ? score : undefined,
        area: 'image',
        rule: res.ruleId,
        title: `${res.ruleId} in ${pkg.name} ${pkg.version}`,
        location: `${image}: ${pkg.ecosystem}/${pkg.name}@${pkg.version}`,
        package: { name: pkg.name, version: pkg.version, ecosystem: pkg.ecosystem, fixedIn },
        fixable: !!fixedIn,
        fix: !fixedIn
          ? 'No fixed version yet: check whether the app uses the affected part, and re-check later.'
          : pkg.ecosystem === 'npm'
            ? `Upgrade ${pkg.name} to ${fixedIn} (via the dependency that ships it), rebuild the image and re-scan.`
            : `Fixed in ${pkg.ecosystem} package ${pkg.name} ${fixedIn}: rebuild on a newer base image (docker build --pull), or upgrade the package in the Dockerfile (apk upgrade), then re-scan.`,
        url: rule?.helpUri,
        details: [
          p.affected_version ? `affected: ${p.affected_version}` : '',
          paths.length ? `files: ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? '…' : ''}` : '',
        ]
          .filter(Boolean)
          .join(' · '),
      };
    });
  });
}

// ---------- suppressions

export interface SuppressionCheck {
  /** findings still open */
  open: SecurityFinding[];
  suppressed: { finding: SecurityFinding; suppression: Suppression }[];
  /** entries that match no current finding (fixed since, or the finding changed): remove them */
  unused: Suppression[];
  expired: Suppression[];
  /** entries without a real reason: they don't apply */
  invalid: { suppression: Suppression; problem: string }[];
}

/** `checksRun`: an entry for a check that hasn't run isn't called unused, since its findings are unknown. */
export function applySuppressions(
  findings: SecurityFinding[],
  list: Suppression[],
  today: string,
  checksRun: Set<Check>,
): SuppressionCheck {
  const valid = new Map<string, Suppression>();
  const result: SuppressionCheck = { open: [], suppressed: [], unused: [], expired: [], invalid: [] };
  for (const s of list) {
    if (typeof s.id !== 'string' || !/^[a-z]+-[0-9a-f]{8}$/.test(s.id))
      result.invalid.push({ suppression: s, problem: 'not a finding ID' });
    else if (typeof s.reason !== 'string' || s.reason.trim().length < MIN_REASON)
      result.invalid.push({ suppression: s, problem: `the reason must explain why it's acceptable (at least ${MIN_REASON} characters)` });
    else if (s.expires && !/^\d{4}-\d{2}-\d{2}$/.test(s.expires))
      result.invalid.push({ suppression: s, problem: 'expires must be YYYY-MM-DD' });
    else if (s.expires && s.expires < today) result.expired.push(s);
    else valid.set(s.id, s);
  }
  const used = new Set<string>();
  for (const f of findings) {
    const s = valid.get(f.id);
    // a secret that must be rotated can't be suppressed: suppressing it would hide an exposure, not a false positive
    if (s && !f.rotate) {
      result.suppressed.push({ finding: f, suppression: s });
      used.add(s.id);
    } else result.open.push(f);
  }
  result.unused = [...valid.values()].filter((s) => !used.has(s.id) && checksRun.has(s.id.split('-')[0] as Check));
  return result;
}

// ---------- ordering

const AREA_RANK: Area[] = ['app', 'prod-dependency', 'image', 'git-history', 'config', 'scripts', 'dev-dependency', 'tests'];

/** Most urgent first: severity, then where (what the running app exposes before dev tooling), then score. */
export function byPriority(a: SecurityFinding, b: SecurityFinding): number {
  return (
    SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
    AREA_RANK.indexOf(a.area) - AREA_RANK.indexOf(b.area) ||
    (b.score ?? 0) - (a.score ?? 0) ||
    a.location.localeCompare(b.location)
  );
}

// ---------- Markdown report

const CHECK_LABEL: Record<Check, string> = {
  audit: 'pnpm audit',
  scout: 'Docker Scout',
  secrets: 'gitleaks',
  codeql: 'CodeQL',
};
const SEVERITY_ICON: Record<Severity, string> = { critical: '🟥', high: '🟧', medium: '🟨', low: '🟦', note: '⬜' };

export const mdEscape = (s: string) =>
  s
    .replace(/([\\`*_[\]|])/g, '\\$1')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, ' ');
const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export interface ReportContext {
  generatedAt: number;
  commit?: string;
  dirty?: boolean;
  branch?: string;
  /** path from the report's folder to the repository root, for file links */
  rootFromReport: string;
}

/** A link to the file and line when it exists in the working tree, else the location as code. */
function whereMd(f: SecurityFinding, ctx: ReportContext): string {
  if (!f.file) return code(f.location);
  return `[${mdEscape(f.location)}](${encodeURI(`${ctx.rootFromReport}/${f.file}`)}${f.line ? `#L${f.line}` : ''})`;
}

function checkStatus(r: CheckResult | undefined, open: number): string {
  if (!r) return '— not run yet';
  if (r.status === 'skipped') return `⏭ skipped: ${mdEscape(r.reason ?? '')}`;
  if (r.status === 'error') return `⚠️ failed: ${mdEscape(r.reason ?? '')}`;
  return r.findings.length ? `❌ ${open} open${open < r.findings.length ? ` (${r.findings.length - open} suppressed)` : ''}` : '✅ clean';
}

export function renderReport(results: Partial<Record<Check, CheckResult>>, s: SuppressionCheck, ctx: ReportContext): string {
  const date = (t: number) => new Date(t).toLocaleString('en-GB');
  const md: string[] = ['# Security report', ''];
  md.push(`- **Generated:** ${date(ctx.generatedAt)}`);
  if (ctx.commit)
    md.push(`- **Working tree:** ${ctx.branch ? `${code(ctx.branch)} at ` : ''}${ctx.commit}${ctx.dirty ? ' + uncommitted changes' : ''}`);
  md.push(
    '- **Machine-readable:** [findings.json](findings.json) (the same findings, for scripts and the security-fix skill)',
    '',
    '## Checks',
    '',
    '| Check | Scanned | Result | Ran | Commit | Time | Tool report |',
    '|---|---|---|---|---|---|---|',
  );
  for (const c of CHECKS) {
    const r = results[c];
    const open = s.open.filter((f) => f.check === c).length;
    const stale = r?.commit && ctx.commit && (r.commit !== ctx.commit || r.dirty !== ctx.dirty) ? ' ⚠️' : '';
    md.push(
      `| ${CHECK_LABEL[c]} | ${r ? mdEscape(r.target) : '—'} | ${checkStatus(r, open)} | ${r ? date(r.ranAt) : '—'} | ${r?.commit ? `${r.commit}${r.dirty ? '+' : ''}${stale}` : '—'} | ${r ? fmtMs(r.ms) : '—'} | ${r?.report ? `[${mdEscape(r.report.split('/').pop()!)}](${encodeURI(`${ctx.rootFromReport}/${r.report}`)})` : '—'} |`,
    );
  }
  md.push('', 'A ⚠️ next to the commit: that check ran on another state of the code than the current one. Re-run it before relying on it.');

  md.push('', `## Open findings (${s.open.length})`, '');
  if (!s.open.length) md.push('None.');
  else {
    const bySeverity = SEVERITIES.map((sev) => `${SEVERITY_ICON[sev]} ${s.open.filter((f) => f.severity === sev).length} ${sev}`).join(
      ' · ',
    );
    const rotate = s.open.filter((f) => f.rotate).length;
    md.push(bySeverity, '');
    if (rotate)
      md.push(`**🔑 ${rotate} secret(s) to rotate:** the key's owner must revoke and replace it; deleting the copy is not enough.`, '');
    md.push('| ID | Severity | Check | Area | Issue | Where |', '|---|---|---|---|---|---|');
    for (const f of s.open)
      md.push(
        `| [${f.id}](#${f.id}) | ${SEVERITY_ICON[f.severity]} ${f.severity}${f.score !== undefined ? ` ${f.score.toFixed(1)}` : ''} | ${CHECK_LABEL[f.check]} | ${f.area} | ${mdEscape(f.title)} | ${whereMd(f, ctx)} |`,
      );
    md.push('', '### Details');
    for (const f of s.open) {
      md.push('', `#### ${f.id}`, '');
      md.push(`- **${mdEscape(f.title)}** (${code(f.rule)}, ${CHECK_LABEL[f.check]})`);
      md.push(`- **Where:** ${whereMd(f, ctx)} · area ${f.area}`);
      if (f.package)
        md.push(
          `- **Package:** ${f.package.ecosystem} ${code(`${f.package.name}@${f.package.version}`)}${f.package.fixedIn ? `, fixed in ${code(f.package.fixedIn)}` : ', no fix yet'}`,
        );
      if (f.details) md.push(`- **Details:** ${mdEscape(f.details)}`);
      md.push(`- **Fix:** ${mdEscape(f.fix)}`);
      if (f.url) md.push(`- **More:** ${f.url}`);
    }
  }

  if (s.suppressed.length) {
    md.push('', `## Suppressed (${s.suppressed.length})`, '', 'Accepted on purpose, in `security-suppressions.json`:', '');
    md.push('| ID | Issue | Where | Reason | Expires |', '|---|---|---|---|---|');
    for (const { finding: f, suppression: x } of s.suppressed)
      md.push(`| ${f.id} | ${mdEscape(f.title)} | ${whereMd(f, ctx)} | ${mdEscape(x.reason)} | ${x.expires ?? '—'} |`);
  }
  const problems = [
    ...s.unused.map((x) => `- ${code(x.id)}: matches no current finding (fixed, or the code changed): remove it`),
    ...s.expired.map((x) => `- ${code(x.id)}: expired on ${x.expires}: the finding is open again`),
    ...s.invalid.map((x) => `- ${code(String(x.suppression.id))}: ignored, ${x.problem}`),
  ];
  if (problems.length) md.push('', '## Suppression file problems', '', ...problems);
  md.push('');
  return md.join('\n');
}
