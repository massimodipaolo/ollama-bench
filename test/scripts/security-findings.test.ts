/**
 * `pnpm security`'s findings (scripts/security-findings.mts): each tool's output turned into one shape, IDs that stay
 * the same across runs, suppressions that need a reason, priority order, and a report that never holds a secret.
 * The inputs are trimmed copies of real tool output.
 */
import { describe, expect, it } from 'vitest';
import type { Finding as CodeqlFinding } from '../../scripts/codeql-report.mjs';
import {
  applySuppressions,
  areaOfFile,
  byPriority,
  fromAudit,
  fromCodeql,
  fromGitleaks,
  fromScout,
  parsePurl,
  renderReport,
  type AuditReport,
  type CheckResult,
  type GitleaksResults,
  type ScoutSarif,
  type SecurityFinding,
} from '../../scripts/security-findings.mjs';

const codeqlFinding = (o: Partial<CodeqlFinding> = {}): CodeqlFinding => ({
  ruleId: 'js/regex/missing-regexp-anchor',
  ruleName: 'Missing regular expression anchor',
  severity: 'medium',
  score: 7.8,
  cwes: ['CWE-20'],
  message: [{ text: 'This hostname pattern may match any domain.' }],
  loc: { file: 'src/lib/judges/index.ts', line: 42 },
  flow: [],
  pathCount: 0,
  fingerprint: '73daa2665177e17b:1',
  ...o,
});

const audit: AuditReport = {
  advisories: {
    '1101': {
      id: 1101,
      module_name: 'postcss',
      severity: 'moderate',
      title: 'PostCSS line return parsing error',
      url: 'https://github.com/advisories/GHSA-7fh5-64p2-3v2j',
      github_advisory_id: 'GHSA-7fh5-64p2-3v2j',
      cves: ['CVE-2023-44270'],
      vulnerable_versions: '<8.4.31',
      patched_versions: '>=8.4.31',
      findings: [{ version: '8.4.14', paths: ['. > next > postcss'] }],
    },
    '1102': {
      id: 1102,
      module_name: 'esbuild',
      severity: 'high',
      title: 'esbuild dev server CORS',
      github_advisory_id: 'GHSA-67mh-4wv8-2f99',
      patched_versions: '>=0.25.0',
      findings: [{ version: '0.24.2', paths: ['. > esbuild'] }],
    },
    '1103': {
      id: 1103,
      module_name: 'abandoned',
      severity: 'low',
      title: 'No fix',
      patched_versions: '<0.0.0',
      findings: [{ version: '1.0.0', paths: ['. > vitest > abandoned'] }],
    },
  },
};

const scout: ScoutSarif = {
  runs: [
    {
      tool: {
        driver: {
          name: 'docker scout',
          version: '1.28.0',
          rules: [
            {
              id: 'CVE-2026-107891',
              helpUri: 'https://scout.docker.com/v/CVE-2026-107891',
              properties: {
                'security-severity': '8.1',
                cvssV3_severity: 'HIGH',
                affected_version: '<1.2.6-r6',
                fixed_version: '1.2.6-r6',
                purls: ['pkg:apk/alpine/musl@1.2.6-r3?os_name=alpine&os_version=3.24'],
              },
            },
            {
              id: 'CVE-2026-2',
              properties: { cvssV3_severity: 'LOW', fixed_version: 'not fixed', purls: ['pkg:npm/%40scope/pkg@2.0.0'] },
            },
          ],
        },
      },
      results: [
        {
          ruleId: 'CVE-2026-107891',
          locations: [{ physicalLocation: { artifactLocation: { uri: '/lib/ld-musl-x86_64.so.1' } } }],
        },
        { ruleId: 'CVE-2026-2', locations: [] },
      ],
    },
  ],
};

const gitleaks: GitleaksResults = {
  gitleaks: '8.30.1',
  image: 'ollama-bench:local',
  scans: [
    {
      scan: 'history',
      target: '40 commits',
      ms: 900,
      leaks: [
        {
          rule: 'own-secret-openai-api-key',
          description: 'OPENAI_API_KEY from .env',
          own: true,
          file: 'notes.txt',
          line: 3,
          commit: 'abcdef1234567890',
          fingerprint: 'abcdef12:notes.txt:own-secret-openai-api-key:3',
        },
      ],
    },
    {
      scan: 'tree',
      target: 'working tree',
      ms: 500,
      leaks: [
        {
          rule: 'generic-api-key',
          description: 'Generic API Key',
          own: false,
          file: 'scripts/x.mts',
          line: 7,
          fingerprint: 'scripts/x.mts:generic-api-key:7',
        },
        {
          rule: 'own-secret-openai-api-key',
          description: 'OPENAI_API_KEY from .env',
          own: true,
          file: '.data/scratch.txt',
          line: 1,
          fingerprint: '.data/scratch.txt:own-secret-openai-api-key:1',
        },
      ],
    },
    { scan: 'image', target: 'image', ms: 0, skipped: 'no local image' },
  ],
};

describe('converting each tool', () => {
  it('CodeQL: rule, place, severity and score, help link, area from the path', () => {
    const [f] = fromCodeql([codeqlFinding()]);
    expect(f).toMatchObject({
      check: 'codeql',
      severity: 'medium',
      score: 7.8,
      area: 'app',
      rule: 'js/regex/missing-regexp-anchor',
      location: 'src/lib/judges/index.ts:42',
      file: 'src/lib/judges/index.ts',
      line: 42,
      url: 'https://codeql.github.com/codeql-query-help/javascript/js-regex-missing-regexp-anchor/',
    });
    expect(f.id).toMatch(/^codeql-[0-9a-f]{8}$/);
    expect(f.details).toContain('CWE-20');
  });

  it('CodeQL IDs survive the code moving (same line content), and change for another rule or file', () => {
    const id = (o: Partial<CodeqlFinding>) => fromCodeql([codeqlFinding(o)])[0].id;
    const base = id({});
    expect(id({ loc: { file: 'src/lib/judges/index.ts', line: 90 } })).toBe(base); // moved down, same fingerprint
    expect(id({ ruleId: 'js/xss' })).not.toBe(base);
    expect(id({ loc: { file: 'src/other.ts', line: 42 } })).not.toBe(base);
  });

  it('areas from paths', () => {
    expect(['src/a.ts', 'scripts/b.mts', 'test/c.ts', 'next.config.ts', 'scripts\\win.mts'].map(areaOfFile)).toEqual([
      'app',
      'scripts',
      'tests',
      'config',
      'scripts',
    ]);
  });

  it('pnpm audit: production vs dev, direct vs transitive fix, no fix', () => {
    const fs = fromAudit(audit, new Set(['1101']));
    const by = (name: string) => fs.find((f) => f.package?.name === name)!;
    expect(by('postcss')).toMatchObject({
      severity: 'medium',
      area: 'prod-dependency',
      rule: 'GHSA-7fh5-64p2-3v2j',
      location: 'postcss@8.4.14',
      fixable: true,
      package: { fixedIn: '>=8.4.31', via: ['next'] },
    });
    expect(by('postcss').fix).toMatch(/Upgrade the dependency that pulls it in \(next\).*override .* in pnpm-workspace\.yaml/);
    expect(by('esbuild')).toMatchObject({ area: 'dev-dependency', severity: 'high' });
    expect(by('esbuild').fix).toBe('Upgrade esbuild to >=0.25.0.');
    expect(by('abandoned')).toMatchObject({ fixable: false, severity: 'low' });
    expect(by('abandoned').fix).toMatch(/No patched version/);
  });

  it('Docker Scout: severity from the score, package from the purl, fixed or not', () => {
    const [musl, npm] = fromScout(scout, 'ollama-bench:local');
    expect(musl).toMatchObject({
      check: 'scout',
      severity: 'high',
      score: 8.1,
      area: 'image',
      rule: 'CVE-2026-107891',
      location: 'ollama-bench:local: apk/musl@1.2.6-r3',
      package: { ecosystem: 'apk', name: 'musl', version: '1.2.6-r3', fixedIn: '1.2.6-r6' },
      fixable: true,
    });
    expect(musl.fix).toMatch(/--pull|apk upgrade/);
    expect(npm).toMatchObject({ severity: 'low', fixable: false, package: { ecosystem: 'npm', name: '@scope/pkg' } });
  });

  it('purls', () => {
    expect(parsePurl('pkg:apk/alpine/musl@1.2.6-r3?os_name=alpine')).toEqual({ ecosystem: 'apk', name: 'musl', version: '1.2.6-r3' });
    expect(parsePurl('pkg:npm/%40next/env@16.4.6')).toEqual({ ecosystem: 'npm', name: '@next/env', version: '16.4.6' });
    expect(parsePurl('garbage').ecosystem).toBe('?');
  });

  it('gitleaks: an own secret in history must be rotated; a never-committed copy just deleted; a rule match checked', () => {
    const fs = fromGitleaks(gitleaks);
    expect(fs).toHaveLength(2 + 1);
    const [history, rule, scratch] = fs;
    expect(history).toMatchObject({ severity: 'critical', area: 'git-history', rotate: true, location: 'notes.txt:3 @ abcdef12' });
    expect(history.file).toBeUndefined(); // only at that commit: nothing to open locally
    expect(history.fix).toMatch(/rotate/);
    expect(rule).toMatchObject({ severity: 'high', area: 'scripts', rotate: false, file: 'scripts/x.mts', line: 7 });
    expect(rule.fix).toMatch(/\.gitleaksignore/);
    expect(scratch).toMatchObject({ severity: 'critical', rotate: false });
    expect(scratch.fix).toMatch(/never committed/);
  });
});

describe('suppressions', () => {
  const findings = [...fromCodeql([codeqlFinding()]), ...fromGitleaks(gitleaks)];
  const [codeqlId, rotateId] = [findings[0].id, findings[1].id];
  const all = new Set(['codeql', 'secrets'] as const);
  const reason = 'Pattern only matches our own config keys; not a hostname check.';

  it('a justified suppression moves the finding out of the open list', () => {
    const s = applySuppressions(findings, [{ id: codeqlId, reason }], '2026-11-28', all);
    expect(s.open.map((f) => f.id)).not.toContain(codeqlId);
    expect(s.suppressed.map((x) => x.finding.id)).toEqual([codeqlId]);
  });

  it('no reason, a token reason, a bad ID or a bad date: ignored and reported', () => {
    const s = applySuppressions(
      findings,
      [
        { id: codeqlId, reason: 'fp' },
        { id: 'whatever', reason },
        { id: codeqlId, reason, expires: 'next year' },
      ],
      '2026-11-28',
      all,
    );
    expect(s.suppressed).toEqual([]);
    expect(s.invalid.map((x) => x.problem)).toEqual([expect.stringMatching(/reason/), 'not a finding ID', expect.stringMatching(/YYYY/)]);
  });

  it('an expired suppression no longer applies', () => {
    const s = applySuppressions(findings, [{ id: codeqlId, reason, expires: '2026-11-27' }], '2026-11-28', all);
    expect(s.open.map((f) => f.id)).toContain(codeqlId);
    expect(s.expired).toHaveLength(1);
  });

  it('a secret to rotate cannot be suppressed', () => {
    const s = applySuppressions(findings, [{ id: rotateId, reason }], '2026-11-28', all);
    expect(s.open.map((f) => f.id)).toContain(rotateId);
  });

  it('an entry matching nothing is unused, unless its check has not run', () => {
    const gone = { id: 'audit-0000beef', reason };
    expect(applySuppressions(findings, [gone], '2026-11-28', all).unused).toEqual([]);
    expect(applySuppressions(findings, [gone], '2026-11-28', new Set(['audit'] as const)).unused).toEqual([gone]);
  });
});

describe('priority and report', () => {
  const f = (o: Partial<SecurityFinding>): SecurityFinding => ({
    id: 'x-00000000',
    check: 'codeql',
    severity: 'medium',
    area: 'app',
    rule: 'r',
    title: 't',
    location: 'l',
    fix: 'f',
    ...o,
  });

  it('severity first, then the running app before dev tooling, then the score', () => {
    const list = [
      f({ id: 'tests-high', severity: 'high', area: 'tests' }),
      f({ id: 'app-medium', area: 'app' }),
      f({ id: 'app-high-low-score', severity: 'high', area: 'app', score: 7 }),
      f({ id: 'app-high', severity: 'high', area: 'app', score: 8.8 }),
      f({ id: 'critical-dev', severity: 'critical', area: 'dev-dependency' }),
    ];
    expect(list.sort(byPriority).map((x) => x.id)).toEqual(['critical-dev', 'app-high', 'app-high-low-score', 'tests-high', 'app-medium']);
  });

  it('the report: checks, open findings with links and fixes, suppressed with reasons, problems; Markdown escaped', () => {
    const open = [
      f({ id: 'codeql-11111111', title: 'Bad | pipe <b>', file: 'src/a.ts', line: 3, location: 'src/a.ts:3', severity: 'high' }),
      f({ id: 'secrets-22222222', check: 'secrets', severity: 'critical', rotate: true, location: 'x:1 @ abc' }),
    ];
    const suppressed = [
      { finding: f({ id: 'audit-33333333', check: 'audit' }), suppression: { id: 'audit-33333333', reason: 'Dev only, never shipped' } },
    ];
    const results: Partial<Record<'codeql' | 'audit', CheckResult>> = {
      codeql: { check: 'codeql', status: 'findings', target: 'sources', ranAt: 0, commit: 'aaa', ms: 1000, findings: open },
      audit: { check: 'audit', status: 'skipped', reason: 'offline', target: 'deps', ranAt: 0, commit: 'bbb', ms: 5, findings: [] },
    };
    const md = renderReport(
      results,
      { open, suppressed, unused: [{ id: 'scout-44444444', reason: 'x'.repeat(30) }], expired: [], invalid: [] },
      { generatedAt: 0, commit: 'aaa', dirty: false, rootFromReport: '../..' },
    );
    expect(md).toContain('[src/a.ts:3](../../src/a.ts#L3)');
    expect(md).toContain('Bad \\| pipe &lt;b&gt;');
    expect(md).toContain('🔑 1 secret(s) to rotate');
    expect(md).toContain('⏭ skipped: offline');
    expect(md).toMatch(/bbb ⚠️/); // ran on another commit
    expect(md).toContain('Dev only, never shipped');
    expect(md).toContain('`scout-44444444`: matches no current finding');
    expect(md).toContain('— not run yet'); // scout, secrets
  });

  it('a gitleaks finding never carries more than the rule, place and fingerprint', () => {
    const json = JSON.stringify(fromGitleaks(gitleaks));
    for (const k of ['Secret', 'Match', 'secret"', 'match"']) expect(json).not.toContain(k);
  });
});
