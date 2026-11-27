/**
 * Batch runner: every selected test on every compatible model, through the running app's API (so the app's
 * single-GPU lock, judges, history and live session view are shared with the web UI).
 *
 *   pnpm bench --dry-run                                   # show the plan
 *   pnpm bench                                             # all tests × all compatible models, quick set
 *   pnpm bench --subset full --skip-existing               # overnight: only what is missing for the current suites
 *   pnpm bench --tests rag,tool-use --models "/^qwen/,gemma4:31b" --lang it --judges openai,anthropic
 *   pnpm bench --all-variants --tests structured-output    # every option combination (native + prompt)
 *   pnpm bench --capabilities vision,tools --tier small    # every test of these capabilities
 *
 * Needs the app running (`pnpm dev`, or `pnpm build && pnpm start` for long runs). --url defaults to $BENCH_URL or
 * http://localhost:3000. Ctrl+C cancels the current session and still writes the report.
 */
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { inTier, parseTier } from '../src/lib/tiers';
import { CAPABILITIES } from '../src/config/capabilities';

const HELP = `Usage: pnpm bench [options]

  --url <url>            app URL (default $BENCH_URL or http://localhost:3000)
  --tests <ids>          comma-separated test ids (default: all, except hours-long ones like terminal-bench,
                         which run only when named: --tests terminal-bench)
  --capabilities <ids>   the tests of these capabilities (${CAPABILITIES.map((c) => c.id).join(', ')}), as listed in
                         src/config/capabilities.ts; combines with --tests. A capability that lists an hours-long
                         test includes it (coding → terminal-bench)
  --models <list>        comma-separated model names or /regex/ (default: every compatible model)
  --exclude <list>       models to leave out (names or /regex/)
  --tier <t>             model size: small (<10B) | medium (10-50B) | large (>50B) | all (default)
  --lang <codes>         languages (default: every language with cases)
  --subset quick|full    case set (default quick)
  --judges <ids|none>    judges to use (default: all configured)
  --think                enable thinking for models that support it
  --num-ctx <n>          context window (default: each test's own, usually 8192); capped at each model's maximum.
                         A non-default value is a separate variant (own leaderboard row, own --skip-existing key)
  --option key=value     test option override, repeatable (e.g. --option mode=prompt)
  --all-variants         run every combination of each test's options
  --skip-existing        skip combinations already completed with the same model digest, suite version and
                         SDK versions (ai, ai-sdk-ollama): after an SDK update everything is due again
  --ignore-sdk           with --skip-existing: don't treat an SDK version change as a reason to re-run
  --max-sessions <n>     stop after n sessions
  --report <file>        report path (default .data/reports/bench-<timestamp>.md, plus .json)
  --dry-run              print the plan and exit
  -h, --help`;

const { values: a } = parseArgs({
  options: {
    url: { type: 'string' },
    tests: { type: 'string' },
    capabilities: { type: 'string' },
    models: { type: 'string' },
    exclude: { type: 'string' },
    tier: { type: 'string', default: 'all' },
    lang: { type: 'string' },
    subset: { type: 'string', default: 'quick' },
    judges: { type: 'string' },
    think: { type: 'boolean', default: false },
    'num-ctx': { type: 'string' },
    option: { type: 'string', multiple: true },
    'all-variants': { type: 'boolean', default: false },
    'skip-existing': { type: 'boolean', default: false },
    'ignore-sdk': { type: 'boolean', default: false },
    'max-sessions': { type: 'string' },
    report: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: false,
});
if (a.help) {
  console.log(HELP);
  process.exit(0);
}

// ---------- API types (subset of what the app returns) ----------
interface TestOption {
  id: string;
  choices: { value: string }[];
  default: string;
}
interface TestSummary {
  id: string;
  name: string;
  requires: string[];
  requiresAny: string[];
  languages: string[];
  options: TestOption[];
  suiteVersion: string;
  numCtx?: number;
  /** hours-long (e.g. terminal-bench): only when named in --tests or via its capability in --capabilities */
  cliOnly?: boolean;
  baselines: string[];
  caseCounts: Record<string, { quick: number; full: number }>;
}
interface ModelInfo {
  name: string;
  digest: string;
  parameterSize: string;
  capabilities: string[];
  contextLength: number | null;
}
interface RunRow {
  testId: string;
  lang: string;
  variant: string;
  subset: string;
  suiteVersion: string;
  model: string;
  digest: string;
  status: string;
  sdk: Record<string, string>;
}
interface SessionDetail {
  status: string;
  error?: string | null;
  runs: {
    role: string;
    status: string;
    error?: string | null;
    judgeAvg: number | null;
    autoScore: number | null;
    judgeScores: Record<string, number | null> | null;
    avgTokPerSec: number | null;
    model: { name: string };
    cases: { error: string | null }[];
  }[];
}

const BASE = (a.url ?? process.env.BENCH_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const list = (s?: string) =>
  s
    ? s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    : [];

async function api<T>(p: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${p}`, init);
  } catch (e) {
    // connection refused & co.: the CLI drives the app's API, so the app must be running
    const cause = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message;
    throw new Error(
      `Can't reach the app at ${BASE} (${cause}). Start it with "pnpm dev" (or "pnpm build && pnpm start"), or point to a running one with --url / BENCH_URL.`,
    );
  }
  const body = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${p} → ${res.status} ${body.slice(0, 300)}`);
  return JSON.parse(body) as T;
}

/** name or /regex/ matchers */
function matcher(items: string[]) {
  const ms = items.map((i) => {
    const re = i.match(/^\/(.+)\/([a-z]*)$/);
    return re ? (n: string) => new RegExp(re[1], re[2]).test(n) : (n: string) => n === i;
  });
  return (n: string) => ms.some((m) => m(n));
}

const eligible = (t: TestSummary, caps: string[]) =>
  t.requires.every((c) => caps.includes(c)) && (!t.requiresAny.length || t.requiresAny.some((c) => caps.includes(c)));

/** Option combinations to run for a test: defaults + --option overrides, or every combination (--all-variants). */
function variants(t: TestSummary): Record<string, string>[] {
  const overrides = Object.fromEntries((a.option ?? []).map((kv) => kv.split('=') as [string, string]));
  if (!a['all-variants'] || !t.options.length) {
    const v: Record<string, string> = {};
    for (const o of t.options) {
      const want = overrides[o.id];
      v[o.id] = want && o.choices.some((c) => c.value === want) ? want : o.default;
    }
    return [v];
  }
  return t.options.reduce<Record<string, string>[]>(
    (acc, o) =>
      acc.flatMap((v) => (overrides[o.id] ? [overrides[o.id]] : o.choices.map((c) => c.value)).map((val) => ({ ...v, [o.id]: val }))),
    [{}],
  );
}
const variantLabel = (v: Record<string, string>) =>
  Object.entries(v)
    .map(([k, x]) => `${k}=${x}`)
    .join(' · ');

const NUM_CTX = a['num-ctx'] ? Number(a['num-ctx']) : undefined;
if (NUM_CTX !== undefined && !(Number.isInteger(NUM_CTX) && NUM_CTX > 0)) {
  console.error(`--num-ctx must be a positive integer (got ${a['num-ctx']})`);
  process.exit(1);
}
/** Same rule as the server (registry sessionVariant): a non-default *requested* value is labelled (the server caps it). */
function ctxVariant(t: TestSummary): string {
  return NUM_CTX !== undefined && NUM_CTX !== (t.numCtx ?? 8192) ? `num_ctx=${NUM_CTX}` : '';
}

interface Job {
  test: TestSummary;
  model: ModelInfo;
  lang: string;
  extra: Record<string, string>;
  variant: string;
  cases: number;
  includeBaselines: boolean;
}

interface Result {
  job: Job;
  sessionId?: string;
  status: string;
  error?: string;
  judgeAvg?: number | null;
  autoScore?: number | null;
  judgeScores?: Record<string, number | null> | null;
  tokPerSec?: number | null;
  caseErrors?: number;
  baseline?: { name: string; judgeAvg: number | null; autoScore: number | null };
  seconds: number;
}

const fmt = (n: number | null | undefined, d = 1) => (n == null ? '–' : n.toFixed(d));
const hms = (sec: number) => {
  const s = Math.round(sec); // round first: 119.6 s must print 0h02m00s, not 0h01m60s
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m${String(s % 60).padStart(2, '0')}s`;
};

/** Follow a session's server-sent events until it ends (falls back to polling if the stream drops). */
async function waitForSession(id: string, onEvent: (e: { type: string; [k: string]: unknown }) => void): Promise<void> {
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/sessions/${id}/events`);
      if (!res.body) throw new Error('no body');
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (!line.startsWith('data:')) continue;
          const e = JSON.parse(line.slice(5));
          if (e.type === 'not-live' || e.type === 'session-end') return;
          onEvent(e);
        }
      }
    } catch {
      /* stream dropped: check status below */
    }
    const s = await api<SessionDetail>(`/api/sessions/${id}`).catch(() => null);
    if (s && !['running', 'queued'].includes(s.status)) return;
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function main() {
  const [{ tests: allTests, capabilities: appCaps, judges: configuredJudges, sdk }, { models: allModels, host }] = await Promise.all([
    api<{
      tests: TestSummary[];
      capabilities?: { id: string; tests: string[] }[];
      judges: { id: string }[];
      sdk: Record<string, string>;
    }>('/api/tests'),
    api<{ models: ModelInfo[]; host: string }>('/api/models'),
  ]);

  // a flag given but empty (e.g. --capabilities "$CAPS" with CAPS unset) must not fall back to the whole suite
  for (const flag of ['tests', 'capabilities'] as const)
    if (a[flag] !== undefined && !list(a[flag]).length) throw new Error(`--${flag} is empty: name at least one, or leave the flag out`);

  const testIds = list(a.tests);
  const unknown = testIds.filter((id) => !allTests.some((t) => t.id === id));
  if (unknown.length) throw new Error(`Unknown test(s): ${unknown.join(', ')}. Available: ${allTests.map((t) => t.id).join(', ')}`);
  // --capabilities expands to the tests the app at --url lists for them (src/config/capabilities.ts), so a test added
  // there is picked up; an older app that doesn't report them falls back to this checkout's config
  const caps = appCaps ?? CAPABILITIES;
  if (!appCaps && a.capabilities) console.warn(`${BASE} doesn't report its capabilities (older build): using this checkout's`);
  const capIds = list(a.capabilities);
  const unknownCaps = capIds.filter((id) => !caps.some((c) => c.id === id));
  if (unknownCaps.length) throw new Error(`Unknown capability: ${unknownCaps.join(', ')}. Available: ${caps.map((c) => c.id).join(', ')}`);
  const capTests = [...new Set(capIds.flatMap((id) => caps.find((c) => c.id === id)!.tests))];
  const missing = capTests.filter((id) => !allTests.some((t) => t.id === id));
  if (missing.length) console.warn(`Not in this app's suite, skipped: ${missing.join(', ')}`);
  const wanted = new Set([...testIds, ...capTests]);
  // long agentic benchmarks (cliOnly) never ride along with "all tests": name them in --tests or via their capability
  const tests = wanted.size ? allTests.filter((t) => wanted.has(t.id)) : allTests.filter((t) => !t.cliOnly);
  if (capIds.length) {
    const long = tests.filter((t) => t.cliOnly && !testIds.includes(t.id)).map((t) => t.id);
    console.log(`Capabilities ${capIds.join(', ')} → ${capTests.filter((id) => !missing.includes(id)).join(', ')}`);
    if (long.length) console.log(`  includes hours-long ${long.join(', ')} (leave its capability out to skip it)`);
  }
  const include = a.models ? matcher(list(a.models)) : () => true;
  const exclude = a.exclude ? matcher(list(a.exclude)) : () => false;
  if (a.tier && parseTier(a.tier) !== a.tier) throw new Error(`--tier must be one of: all, small, medium, large`);
  const tier = parseTier(a.tier);
  const models = allModels.filter((m) => include(m.name) && !exclude(m.name) && inTier(m.parameterSize, tier));
  const langs = list(a.lang);
  const subset = a.subset === 'full' ? 'full' : 'quick';
  const judges = a.judges === 'none' ? [] : a.judges ? list(a.judges) : configuredJudges.map((j) => j.id);
  const history = a['skip-existing'] ? await api<RunRow[]>('/api/runs') : [];

  // plan: grouped by model so each model loads once and runs all its tests
  const jobs: Job[] = [];
  const skipped: string[] = [];
  const baselineDone = new Set<string>();
  for (const m of models) {
    for (const t of tests) {
      if (!eligible(t, m.capabilities)) continue;
      for (const lang of t.languages.filter((l) => !langs.length || langs.includes(l))) {
        for (const extra of variants(t)) {
          const variant = [variantLabel(extra), ctxVariant(t)].filter(Boolean).join(' · ');
          const done = history.some(
            (h) =>
              h.status === 'done' &&
              h.model === m.name &&
              h.digest === m.digest &&
              h.testId === t.id &&
              h.lang === lang &&
              h.variant === variant &&
              h.subset === subset &&
              h.suiteVersion === t.suiteVersion &&
              (a['ignore-sdk'] || (h.sdk?.['ai'] === sdk['ai'] && h.sdk?.['ai-sdk-ollama'] === sdk['ai-sdk-ollama'])),
          );
          if (done) {
            skipped.push(`${m.name} · ${t.id} · ${lang}${variant ? ` · ${variant}` : ''}`);
            continue;
          }
          // baselines ignore test options (e.g. embeddingImpl): once per test and language
          const bkey = `${t.id}|${lang}`;
          const includeBaselines = t.baselines.length > 0 && !baselineDone.has(bkey);
          jobs.push({ test: t, model: m, lang, extra, variant, cases: t.caseCounts[lang]?.[subset] ?? 0, includeBaselines });
          if (includeBaselines) baselineDone.add(bkey);
        }
      }
    }
  }
  const max = a['max-sessions'] ? Number(a['max-sessions']) : Infinity;
  const plan = jobs.slice(0, max);

  console.log(`Ollama host ${host} · app ${BASE}`);
  console.log(
    `SDK: ${Object.entries(sdk)
      .map(([k, v]) => `${k}@${v}`)
      .join(' ')}`,
  );
  console.log(
    `${plan.length} sessions, ${plan.reduce((s, j) => s + j.cases, 0)} cases (${subset}) · judges: ${judges.join(', ') || 'none'}${a.think ? ' · thinking on' : ''}`,
  );
  if (skipped.length) console.log(`${skipped.length} already done for the current suite version (--skip-existing)`);
  for (const j of plan)
    console.log(
      `  ${j.model.name.padEnd(36)} ${j.test.id.padEnd(18)} ${j.lang}  ${String(j.cases).padStart(3)} cases${j.variant ? `  ${j.variant}` : ''}${j.includeBaselines ? `  (+ ${j.test.baselines.join(', ')})` : ''}`,
    );
  if (a['dry-run'] || !plan.length) return;

  // run
  const started = Date.now();
  const results: Result[] = [];
  let current: string | undefined;
  let interrupted = false;
  process.on('SIGINT', async () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.log('\nInterrupted: cancelling the current session (Ctrl+C again to quit immediately)…');
    if (current) await fetch(`${BASE}/api/sessions/${current}/cancel`, { method: 'POST' }).catch(() => {});
  });

  for (const [i, j] of plan.entries()) {
    if (interrupted) break;
    const t0 = Date.now();
    const tag = `[${i + 1}/${plan.length}] ${j.model.name} · ${j.test.id} · ${j.lang}${j.variant ? ` · ${j.variant}` : ''}`;
    process.stdout.write(`${tag} … `);
    try {
      const { id } = await api<{ id: string }>('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testId: j.test.id,
          lang: j.lang,
          models: [j.model.name],
          includeBaselines: j.includeBaselines,
          config: { subset, judges, think: a.think, extra: j.extra, ...(NUM_CTX ? { numCtx: NUM_CTX } : {}) },
          // the plan is grouped by model: keep it loaded while its next session follows, free it when moving on
          keepLoaded: plan[i + 1]?.model.name === j.model.name,
        }),
      });
      current = id;
      await waitForSession(id, (e) => {
        if (e.type === 'case-end') {
          process.stdout.write('.');
        }
        if (e.type === 'session' && e.status === 'judging') process.stdout.write(' judging');
      });
      current = undefined;
      const s = await api<SessionDetail>(`/api/sessions/${id}`);
      const run = s.runs.find((r) => r.role === 'candidate');
      const base = s.runs.find((r) => r.role === 'baseline');
      const r: Result = {
        job: j,
        sessionId: id,
        status: s.status,
        error: s.error ?? run?.error ?? undefined,
        judgeAvg: run?.judgeAvg,
        autoScore: run?.autoScore,
        judgeScores: run?.judgeScores,
        tokPerSec: run?.avgTokPerSec,
        caseErrors: run?.cases.filter((c) => c.error && !c.error.startsWith('skipped')).length,
        baseline: base ? { name: base.model.name, judgeAvg: base.judgeAvg, autoScore: base.autoScore } : undefined,
        seconds: (Date.now() - t0) / 1000,
      };
      results.push(r);
      console.log(
        ` ${r.status} · judges ${fmt(r.judgeAvg)} · auto ${fmt(r.autoScore)}${r.tokPerSec ? ` · ${fmt(r.tokPerSec, 0)} tok/s` : ''}${r.caseErrors ? ` · ${r.caseErrors} case errors` : ''} · ${hms(r.seconds)}${r.error ? `\n    ${r.error}` : ''}`,
      );
    } catch (e) {
      results.push({ job: j, status: 'error', error: (e as Error).message, seconds: (Date.now() - t0) / 1000 });
      console.log(` error: ${(e as Error).message}`);
    }
  }

  writeReport(results, { started, subset, judges, interrupted, skipped: skipped.length, sdk });
  const failed = results.filter((r) => r.status !== 'done').length;
  console.log(
    `\nDone in ${hms((Date.now() - started) / 1000)}: ${results.length - failed} ok, ${failed} not ok${interrupted ? ' (interrupted)' : ''}.`,
  );
  process.exit(failed || interrupted ? 1 : 0);
}

function writeReport(
  results: Result[],
  meta: { started: number; subset: string; judges: string[]; interrupted: boolean; skipped: number; sdk: Record<string, string> },
) {
  const stamp = new Date(meta.started).toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const file = a.report ?? path.join('.data', 'reports', `bench-${stamp}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const row = (r: Result) =>
    `| ${r.job.model.name} | ${r.job.test.name} | ${r.job.lang} | ${r.job.variant || ''} | ${fmt(r.judgeAvg)} | ${fmt(r.autoScore)} | ${r.tokPerSec ? fmt(r.tokPerSec, 0) : '–'} | ${r.status}${r.caseErrors ? ` (${r.caseErrors} case errors)` : ''} | ${hms(r.seconds)} | ${r.sessionId ? `[open](${BASE}/sessions/${r.sessionId})` : ''} |`;
  const baselines = results.filter((r) => r.baseline);
  const md = [
    `# Benchmark run ${new Date(meta.started).toLocaleString()}`,
    '',
    `${results.length} sessions · set: ${meta.subset} · judges: ${meta.judges.join(', ') || 'none'} · duration ${hms((Date.now() - meta.started) / 1000)}${meta.interrupted ? ' · **interrupted**' : ''}${meta.skipped ? ` · ${meta.skipped} skipped (already done)` : ''}`,
    '',
    `SDK: ${Object.entries(meta.sdk)
      .map(([k, v]) => `\`${k}@${v}\``)
      .join(' · ')}`,
    '',
    '| Model | Test | Lang | Variant | Judge avg | Auto | tok/s | Status | Time | Session |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...results.map(row),
    ...(baselines.length
      ? [
          '',
          '## Baselines',
          '',
          '| Baseline | Test | Lang | Judge avg | Auto |',
          '|---|---|---|---|---|',
          ...baselines.map(
            (r) =>
              `| ${r.baseline!.name} | ${r.job.test.name} | ${r.job.lang} | ${fmt(r.baseline!.judgeAvg)} | ${fmt(r.baseline!.autoScore)} |`,
          ),
        ]
      : []),
    '',
  ].join('\n');
  fs.writeFileSync(file, md);
  fs.writeFileSync(
    file.replace(/\.md$/, '') + '.json',
    JSON.stringify(
      {
        ...meta,
        app: BASE,
        results: results.map((r) => ({
          ...r,
          job: {
            model: r.job.model.name,
            digest: r.job.model.digest,
            test: r.job.test.id,
            lang: r.job.lang,
            variant: r.job.variant,
            cases: r.job.cases,
          },
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\nReport: ${file} (+ .json)`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
