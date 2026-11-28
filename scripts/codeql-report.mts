/**
 * Turns the SARIF file written by `codeql database analyze` into readable reports (Markdown and/or a self-contained
 * HTML page). Used by scripts/codeql.mts; not meant to be run directly.
 */
import { closeSync, fstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';

export type ReportFormat = 'md' | 'html';
export const REPORT_FORMATS: readonly ReportFormat[] = ['md', 'html'];

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'note';
const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'note'];

interface Loc {
  file: string;
  line?: number;
  column?: number;
  endLine?: number;
}

/** A message split into plain text and references to related locations (`[label](id)` in SARIF). */
type MessagePart = { text: string; loc?: Loc };

interface Snippet {
  startLine: number;
  lines: string[];
  /** first and last reported line, highlighted */
  from: number;
  to: number;
  /** read from a file modified after the scan: the lines may not match the finding */
  stale?: boolean;
}

export interface Finding {
  ruleId: string;
  ruleName: string;
  description?: string;
  help?: string;
  severity: Severity;
  /** GitHub's security-severity score (0–10), when the rule has one */
  score?: number;
  precision?: string;
  cwes: string[];
  message: MessagePart[];
  loc?: Loc;
  snippet?: Snippet;
  /** first data-flow path, source to sink */
  flow: { text: string; loc: Loc }[];
  pathCount: number;
}

export interface ScanInfo {
  codeqlVersion?: string;
  rulesRun: number;
  filesExtracted?: number;
  /** when the SARIF file was written */
  scanTime: number;
}

// ---------- SARIF (only the parts used here) ----------

interface SarifPhysical {
  artifactLocation?: { uri?: string };
  region?: { startLine?: number; startColumn?: number; endLine?: number; snippet?: { text?: string } };
  contextRegion?: { startLine?: number; snippet?: { text?: string } };
}
interface SarifLocation {
  id?: number;
  physicalLocation?: SarifPhysical;
  message?: { text?: string };
}
interface SarifRule {
  id: string;
  name?: string;
  shortDescription?: { text?: string };
  fullDescription?: { text?: string };
  help?: { text?: string; markdown?: string };
  defaultConfiguration?: { level?: string };
  properties?: { tags?: string[]; precision?: string; 'security-severity'?: string; 'problem.severity'?: string };
}
interface SarifResult {
  ruleId?: string;
  rule?: { id?: string };
  level?: string;
  message: { text: string };
  locations?: SarifLocation[];
  relatedLocations?: SarifLocation[];
  codeFlows?: { threadFlows?: { locations?: { location?: SarifLocation }[] }[] }[];
}
interface SarifRun {
  tool: { driver: { semanticVersion?: string; rules?: SarifRule[] }; extensions?: { rules?: SarifRule[] }[] };
  results?: SarifResult[];
  invocations?: { toolExecutionNotifications?: { descriptor?: { id?: string } }[] }[];
}

function toLoc(p?: SarifPhysical): Loc | undefined {
  const file = p?.artifactLocation?.uri;
  if (!file) return undefined;
  return { file, line: p.region?.startLine, column: p.region?.startColumn, endLine: p.region?.endLine };
}

/** GitHub's buckets for security-severity; rules without a score fall back to their SARIF level. */
function severityOf(score: number | undefined, level: string | undefined): Severity {
  if (score !== undefined) {
    if (score >= 9) return 'critical';
    if (score >= 7) return 'high';
    if (score >= 4) return 'medium';
    if (score > 0) return 'low';
  }
  return level === 'error' ? 'high' : level === 'warning' ? 'medium' : 'note';
}

function parseMessage(text: string, related: Map<number, Loc>): MessagePart[] {
  const parts: MessagePart[] = [];
  let last = 0;
  for (const m of text.matchAll(/\[([^\]]+)\]\((\d+)\)/g)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ text: m[1], loc: related.get(Number(m[2])) });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/** Code around the finding: SARIF's own snippet when it has one (--sarif-add-snippets), else the file on disk. */
function snippetOf(root: string, p: SarifPhysical | undefined, loc: Loc | undefined, scanTime: number): Snippet | undefined {
  if (!loc?.line) return undefined;
  const from = loc.line;
  const to = loc.endLine ?? loc.line;
  const ctx = p?.contextRegion;
  if (ctx?.snippet?.text && ctx.startLine) {
    return { startLine: ctx.startLine, lines: ctx.snippet.text.replace(/\r?\n$/, '').split(/\r?\n/), from, to };
  }
  const file = readWithMtime(join(root, loc.file));
  if (!file) return undefined;
  const all = file.text.split(/\r?\n/);
  const startLine = Math.max(1, from - 2);
  const end = Math.min(all.length, to + 2, from + 30); // a multi-line region is cut after 30 lines
  return { startLine, lines: all.slice(startLine - 1, end), from, to, stale: file.mtimeMs > scanTime };
}

const isMissing = (e: unknown) => ['ENOENT', 'EISDIR'].includes((e as NodeJS.ErrnoException).code ?? '');

/**
 * A file's text and modification time, both from one open file descriptor so they describe the same version of the
 * file (checking the path first and reading it after would race with a write in between). Undefined if it's missing.
 */
export function readWithMtime(path: string): { text: string; mtimeMs: number } | undefined {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (e) {
    if (isMissing(e)) return undefined;
    throw e;
  }
  try {
    return { mtimeMs: fstatSync(fd).mtimeMs, text: readFileSync(fd, 'utf8') };
  } catch (e) {
    if (isMissing(e)) return undefined; // a directory, on systems where opening one succeeds
    throw e;
  } finally {
    closeSync(fd);
  }
}

/** Undefined when the SARIF file doesn't exist. */
export function loadFindings(sarifPath: string, root: string): { findings: Finding[]; info: ScanInfo } | undefined {
  const sarifFile = readWithMtime(sarifPath);
  if (!sarifFile) return undefined;
  const runs: SarifRun[] = JSON.parse(sarifFile.text).runs ?? [];
  const scanTime = sarifFile.mtimeMs;
  const findings: Finding[] = [];
  let rulesRun = 0;
  let filesExtracted: number | undefined;
  let codeqlVersion: string | undefined;

  for (const run of runs) {
    const rules = new Map<string, SarifRule>();
    for (const r of [...(run.tool.driver.rules ?? []), ...(run.tool.extensions ?? []).flatMap((e) => e.rules ?? [])]) rules.set(r.id, r);
    rulesRun += rules.size;
    codeqlVersion ??= run.tool.driver.semanticVersion;
    const notes = run.invocations?.flatMap((i) => i.toolExecutionNotifications ?? []) ?? [];
    const extracted = notes.filter((n) => n.descriptor?.id?.endsWith('/diagnostics/successfully-extracted-files')).length;
    if (extracted) filesExtracted = (filesExtracted ?? 0) + extracted;

    for (const r of run.results ?? []) {
      const ruleId = r.ruleId ?? r.rule?.id ?? '(unknown rule)';
      const rule = rules.get(ruleId);
      const props = rule?.properties ?? {};
      const scoreText = props['security-severity'];
      const score = scoreText !== undefined && !Number.isNaN(Number(scoreText)) ? Number(scoreText) : undefined;
      const related = new Map<number, Loc>();
      for (const rl of r.relatedLocations ?? []) {
        const l = toLoc(rl.physicalLocation);
        if (rl.id !== undefined && l) related.set(rl.id, l);
      }
      const primary = r.locations?.[0]?.physicalLocation;
      const loc = toLoc(primary);
      const steps = r.codeFlows?.[0]?.threadFlows?.[0]?.locations ?? [];
      findings.push({
        ruleId,
        ruleName: rule?.shortDescription?.text ?? rule?.name ?? ruleId,
        description: rule?.fullDescription?.text,
        help: rule?.help?.markdown ?? rule?.help?.text,
        severity: severityOf(score, r.level ?? rule?.defaultConfiguration?.level ?? props['problem.severity']),
        score,
        precision: props.precision,
        cwes: (props.tags ?? [])
          .map((t) => /^external\/cwe\/cwe-0*(\d+)$/i.exec(t)?.[1])
          .filter((x): x is string => !!x)
          .map((n) => `CWE-${n}`),
        message: parseMessage(r.message.text, related),
        loc,
        snippet: snippetOf(root, primary, loc, scanTime),
        flow: steps.flatMap((s) => {
          const l = toLoc(s.location?.physicalLocation);
          return l ? [{ text: s.location?.message?.text ?? '', loc: l }] : [];
        }),
        pathCount: r.codeFlows?.length ?? 0,
      });
    }
  }

  const rank = (s: Severity) => SEVERITIES.indexOf(s);
  findings.sort(
    (a, b) =>
      rank(a.severity) - rank(b.severity) ||
      (b.score ?? 0) - (a.score ?? 0) ||
      (a.loc?.file ?? '').localeCompare(b.loc?.file ?? '') ||
      (a.loc?.line ?? 0) - (b.loc?.line ?? 0),
  );
  return { findings, info: { codeqlVersion, rulesRun, filesExtracted, scanTime } };
}

// ---------- shared helpers ----------

const where = (l?: Loc) => (l ? `${l.file}${l.line ? `:${l.line}` : ''}` : '(no location)');
const plain = (parts: MessagePart[]) => parts.map((p) => p.text).join('');
const STALE = 'This file changed after the scan, so the code below may not be the reported lines. Re-run the scan.';
const severityLabel = (f: Finding) =>
  `${f.severity[0].toUpperCase()}${f.severity.slice(1)}${f.score !== undefined ? ` ${f.score.toFixed(1)}` : ''}`;
const cweUrl = (cwe: string) => `https://cwe.mitre.org/data/definitions/${cwe.slice(4)}.html`;

function countBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const i of items) m.set(key(i), [...(m.get(key(i)) ?? []), i]);
  return m;
}

const LANG: Record<string, string> = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.mts': 'ts',
  '.cts': 'ts',
  '.js': 'js',
  '.jsx': 'jsx',
  '.mjs': 'js',
  '.cjs': 'js',
  '.json': 'json',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.html': 'html',
  '.vue': 'vue',
};

/** Key/value lines shown at the top of every report. */
export type ReportMeta = [label: string, value: string][];

// ---------- Markdown ----------

const mdEscape = (s: string) =>
  s
    .replace(/([\\`*_[\]|#])/g, '\\$1')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

function renderMarkdown(findings: Finding[], meta: ReportMeta, root: string, reportPath: string): string {
  const link = (l: Loc, label = where(l)) => {
    const rel = relative(dirname(reportPath), join(root, l.file)).replace(/\\/g, '/');
    return `[${mdEscape(label)}](${encodeURI(rel)}${l.line ? `#L${l.line}` : ''})`;
  };
  const msg = (parts: MessagePart[]) => parts.map((p) => (p.loc ? `${mdEscape(p.text)} (${link(p.loc)})` : mdEscape(p.text))).join('');
  const out: string[] = ['# CodeQL report', ''];
  // paths and pack names as inline code, so backslashes and underscores need no escaping
  for (const [k, v] of meta) out.push(`- **${k}:** ${/\\|[a-z]\/[a-z]/i.test(v) && !v.includes('`') ? `\`${v}\`` : mdEscape(v)}`);
  out.push('', '## Summary', '');

  if (!findings.length) {
    out.push('No findings. ✅', '');
    return out.join('\n');
  }
  const bySev = countBy(findings, (f) => f.severity);
  out.push(
    `**${findings.length} finding(s):** ${SEVERITIES.filter((s) => bySev.has(s))
      .map((s) => `${bySev.get(s)!.length} ${s}`)
      .join(' · ')}`,
    '',
  );
  out.push('| Rule | Severity | Findings |', '|---|---|---|');
  for (const [, fs] of countBy(findings, (f) => f.ruleId)) {
    out.push(`| ${mdEscape(fs[0].ruleName)} (\`${fs[0].ruleId}\`) | ${severityLabel(fs[0])} | ${fs.length} |`);
  }
  out.push('', '## Findings', '');

  findings.forEach((f, i) => {
    out.push(`### ${i + 1}. ${mdEscape(f.ruleName)} · ${severityLabel(f)}`, '');
    const facts = [`\`${f.ruleId}\``];
    if (f.precision) facts.push(`precision ${f.precision}`);
    if (f.cwes.length) facts.push(f.cwes.map((c) => `[${c}](${cweUrl(c)})`).join(', '));
    out.push(facts.join(' · '), '');
    out.push(`**Location:** ${f.loc ? link(f.loc) : '(no location)'}`, '');
    out.push(`> ${msg(f.message).replace(/\n/g, '\n> ')}`, '');
    if (f.snippet && f.loc) {
      const width = String(f.snippet.startLine + f.snippet.lines.length - 1).length;
      const body = f.snippet.lines
        .map((l, j) => {
          const n = f.snippet!.startLine + j;
          return `${n >= f.snippet!.from && n <= f.snippet!.to ? '>' : ' '} ${String(n).padStart(width)} | ${l}`;
        })
        .join('\n');
      const fence = '`'.repeat(Math.max(3, ...(body.match(/`+/g) ?? []).map((b) => b.length + 1)));
      if (f.snippet.stale) out.push(`*⚠ ${STALE}*`, '');
      out.push(`${fence}${LANG[extname(f.loc.file)] ?? ''}`, body, fence, '');
    }
    if (f.flow.length) {
      out.push(`**Data flow** (${f.flow.length} steps${f.pathCount > 1 ? `, first of ${f.pathCount} paths` : ''}):`, '');
      f.flow.forEach((s, j) => out.push(`${j + 1}. ${link(s.loc)}${s.text ? ` · \`${s.text.replace(/`/g, "'")}\`` : ''}`));
      out.push('');
    }
    if (f.help || f.description) {
      // the rule help has its own top-level headings: push them below this finding's heading
      const help = (f.help ?? f.description ?? '').replace(/^(#{1,3}) /gm, '$1### ');
      out.push('<details><summary>About this rule</summary>', '', help.trim(), '', '</details>', '');
    }
  });
  return out.join('\n');
}

// ---------- HTML ----------

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function renderHtml(findings: Finding[], meta: ReportMeta, root: string): string {
  // vscode:// links open the file at the line in VS Code; the text still shows the repo-relative path
  const href = (l: Loc) =>
    `vscode://file/${encodeURI(join(root, l.file).replace(/\\/g, '/'))}${l.line ? `:${l.line}${l.column ? `:${l.column}` : ''}` : ''}`;
  const link = (l: Loc) => `<a class="loc" href="${esc(href(l))}">${esc(where(l))}</a>`;
  const msg = (parts: MessagePart[]) =>
    parts
      .map((p) => (p.loc ? `<a class="ref" href="${esc(href(p.loc))}" title="${esc(where(p.loc))}">${esc(p.text)}</a>` : esc(p.text)))
      .join('');
  const badge = (f: Finding) => `<span class="sev sev-${f.severity}">${esc(severityLabel(f))}</span>`;
  const bySev = countBy(findings, (f) => f.severity);

  const summary = findings.length
    ? `<div class="chips">${SEVERITIES.map((s) => `<div class="chip sev-${s}${bySev.has(s) ? '' : ' zero'}"><b>${bySev.get(s)?.length ?? 0}</b> ${s}</div>`).join('')}</div>
<table><thead><tr><th>Rule</th><th>Severity</th><th class="num">Findings</th></tr></thead><tbody>
${[...countBy(findings, (f) => f.ruleId).values()].map((fs) => `<tr><td>${esc(fs[0].ruleName)}<br><code>${esc(fs[0].ruleId)}</code></td><td>${badge(fs[0])}</td><td class="num">${fs.length}</td></tr>`).join('\n')}
</tbody></table>`
    : '<p class="clean">No findings ✅</p>';

  const cards = findings
    .map((f, i) => {
      const facts = [`<code>${esc(f.ruleId)}</code>`];
      if (f.precision) facts.push(`precision ${esc(f.precision)}`);
      if (f.cwes.length) facts.push(f.cwes.map((c) => `<a href="${cweUrl(c)}">${c}</a>`).join(', '));
      const snippet =
        f.snippet && f.loc
          ? `${f.snippet.stale ? `<p class="stale">⚠ ${esc(STALE)}</p>` : ''}<pre class="code">${f.snippet.lines
              .map((l, j) => {
                const n = f.snippet!.startLine + j;
                const hit = n >= f.snippet!.from && n <= f.snippet!.to;
                return `<span class="ln${hit ? ' hit' : ''}"><span class="n">${n}</span>${esc(l) || ' '}</span>`;
              })
              .join('')}</pre>`
          : '';
      const flow = f.flow.length
        ? `<h4>Data flow <span class="muted">(${f.flow.length} steps${f.pathCount > 1 ? `, first of ${f.pathCount} paths` : ''})</span></h4>
<ol class="flow">${f.flow.map((s) => `<li>${link(s.loc)}${s.text ? ` <code>${esc(s.text)}</code>` : ''}</li>`).join('')}</ol>`
        : '';
      const help = f.help ?? f.description;
      return `<article id="f${i + 1}">
<header><span class="idx">${i + 1}</span><h3>${esc(f.ruleName)}</h3>${badge(f)}</header>
<p class="facts">${facts.join(' · ')}</p>
<p class="where">${f.loc ? link(f.loc) : '(no location)'}</p>
<p class="msg">${msg(f.message)}</p>
${snippet}${flow}${help ? `<details><summary>About this rule</summary><pre class="help">${esc(help.trim())}</pre></details>` : ''}
</article>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CodeQL report</title>
<style>
:root { color-scheme: light dark;
  --bg: #f7f7f8; --card: #fff; --fg: #1d1d1f; --muted: #6b6b73; --line: #e2e2e6; --code: #f1f1f4; --hit: #fff3c4; --link: #0b62c4;
  --critical: #a1101e; --high: #d1242f; --medium: #b35900; --low: #6a7380; --note: #8a8f98; }
@media (prefers-color-scheme: dark) { :root {
  --bg: #121214; --card: #1c1c20; --fg: #ececf0; --muted: #9a9aa3; --line: #2e2e34; --code: #24242a; --hit: #4a3f12; --link: #6cb0ff;
  --critical: #ff6b7a; --high: #ff8a8a; --medium: #ffb35c; --low: #a9b1bd; --note: #8a8f98; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { margin: 0 0 8px; font-size: 26px; } h2 { margin: 32px 0 12px; font-size: 19px; }
a { color: var(--link); text-decoration: none; } a:hover { text-decoration: underline; }
code, pre { font: 13px/1.45 ui-monospace, "Cascadia Code", Consolas, monospace; }
.muted, .meta dt { color: var(--muted); }
.meta { display: grid; grid-template-columns: max-content 1fr; gap: 2px 16px; margin: 0; font-size: 14px; } .meta dd { margin: 0; overflow-wrap: anywhere; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.chip { background: var(--card); border: 1px solid var(--line); border-left: 4px solid var(--c); border-radius: 6px; padding: 6px 12px; text-transform: capitalize; }
.chip.zero { opacity: .45; } .chip b { font-size: 18px; margin-right: 4px; }
table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); vertical-align: top; } th { font-size: 13px; color: var(--muted); }
.num { text-align: right; }
.sev-critical { --c: var(--critical); } .sev-high { --c: var(--high); } .sev-medium { --c: var(--medium); } .sev-low { --c: var(--low); } .sev-note { --c: var(--note); }
.sev { display: inline-block; white-space: nowrap; color: var(--c); border: 1px solid var(--c); border-radius: 999px; padding: 0 8px; font-size: 12px; font-weight: 600; }
article { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
article header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
article h3 { margin: 0; font-size: 16px; flex: 1 1 auto; } article h4 { margin: 14px 0 6px; font-size: 14px; }
.idx { color: var(--muted); font-variant-numeric: tabular-nums; }
.facts { margin: 6px 0; font-size: 13px; color: var(--muted); } .where { margin: 6px 0; } .msg { margin: 10px 0; }
.ref { border-bottom: 1px dotted var(--link); }
pre.code { background: var(--code); border-radius: 6px; padding: 8px 0; overflow-x: auto; margin: 10px 0; }
.ln { display: block; padding: 0 12px 0 0; white-space: pre; } .ln.hit { background: var(--hit); }
.ln .n { display: inline-block; min-width: 3.5em; padding: 0 12px 0 8px; text-align: right; color: var(--muted); user-select: none; }
.flow { margin: 0; padding-left: 24px; } .flow li { margin: 2px 0; overflow-wrap: anywhere; }
details { margin-top: 12px; } summary { cursor: pointer; color: var(--muted); }
pre.help { white-space: pre-wrap; background: var(--code); border-radius: 6px; padding: 12px; }
.clean { font-size: 18px; }
.stale { margin: 10px 0 -4px; font-size: 13px; color: var(--medium); }
</style>
</head>
<body>
<main>
<h1>CodeQL report</h1>
<dl class="meta">${meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
<h2>Summary</h2>
${summary}
${findings.length ? `<h2>Findings</h2>\n${cards}` : ''}
<p class="muted">Locations open in VS Code (vscode:// links).</p>
</main>
</body>
</html>
`;
}

/** Writes `<base>.<format>` for each format and returns the written paths. */
export function writeReports(
  formats: ReportFormat[],
  base: string,
  findings: Finding[],
  meta: ReportMeta,
  root: string,
): Map<ReportFormat, string> {
  const written = new Map<ReportFormat, string>();
  for (const format of formats) {
    const path = `${base}.${format}`;
    writeFileSync(path, format === 'md' ? renderMarkdown(findings, meta, root, path) : renderHtml(findings, meta, root));
    written.set(format, path);
  }
  return written;
}

export { where, plain, severityLabel };
