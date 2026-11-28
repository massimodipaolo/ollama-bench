# Scripts

Command-line tools for running benchmarks, fetching data, maintaining reference fixtures and running security
checks. Run them from the project root. The root [README](../README.md) explains the app and the tests these scripts
work with.

| Command                                                 | What it does                                                  | Needs                           | VS Code (Run and Debug)                                |
| ------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------ |
| [`pnpm test`](#pnpm-test)                               | The test suite (Vitest), with `test:coverage` and `verify`    | —                               | —                                                      |
| [`pnpm smoke`](#pnpm-smoke)                             | One tiny call to Ollama and to each judge                     | `.env`                          | `ai-sdk:update` (after updating the SDK)               |
| [`pnpm bench`](#pnpm-bench)                             | Batch runs: tests × models through the app's API              | the app running                 | `bench:dry-run`, `bench:quick`, `bench:terminal-bench` |
| [`pnpm rejudge`](#pnpm-rejudge)                         | Re-judge a session, or repair broken verdicts                 | `.env`                          | —                                                      |
| [`pnpm datasets:fetch`](#pnpm-datasetsfetch)            | Download the public benchmark datasets                        | network                         | —                                                      |
| [`pnpm tb:verify`](#pnpm-tbverify)                      | Check the Terminal-Bench harness with the reference solutions | Docker                          | —                                                      |
| [`pnpm security`](#pnpm-security)                       | All four checks below, one report of every finding            | the tools of each check         | `security:all`                                         |
| [`pnpm security:codeql`](#pnpm-securitycodeql)          | CodeQL scan of the sources                                    | CodeQL CLI                      | `security:codeql`                                      |
| [`pnpm audit --prod`](#pnpm-audit---prod)               | Known vulnerabilities in the production dependencies          | network                         | `security:audit`                                       |
| [`docker scout cves`](#docker-scout)                    | CVEs in the Docker image: OS packages, Node, npm packages     | Docker, the image built         | `security:scout`                                       |
| [`pnpm security:secrets`](#pnpm-securitysecrets)        | gitleaks on the whole history, the working tree and the image | gitleaks (Docker for the image) | `security:secrets`                                     |
| [`build-doc2md-refs.mts`](#reference-data-builders)     | Rebuild the doc-to-markdown reference Markdown                | `.env` (PDF only)               | —                                                      |
| [`render-pdf-pages.mjs`](#reference-data-builders)      | Render PDF pages to the image-recognition fixtures            | —                               | —                                                      |
| [`judge-image-experiment.mts`](#judge-image-experiment) | One-off judge calibration experiment                          | `.env`                          | —                                                      |

The Run and Debug list groups its entries as **run** (`dev`, `start`, `docker:run`), **bench** and **security**.

`scripts/mcp/benchmark-server.mjs` isn't run by hand: the app starts it for the `mcp` test (see
[Web search and MCP tests](../README.md#web-search-and-mcp-tests)).

**Environment.** `smoke` and `rejudge` load `.env` themselves (`tsx --env-file=.env`). The scripts run with
`pnpm tsx …` need it passed explicitly, as shown below. Scripts that import app code reading the database also need
`--conditions=react-server`, as the app's modules are server-only. `bench` reads no secrets: the app it talks to
holds them.

Everything a script writes goes under `.data/` (git-ignored), except the fixture builders, which write into
`fixtures/` on purpose.

---

## `pnpm test`

The test suite, with [Vitest](https://vitest.dev). Tests live in `test/`, mirroring `src/`: for example
`test/lib/tests/checks.test.ts` tests `src/lib/tests/checks.ts`.

```bash
pnpm test                          # the whole suite, once (a few seconds)
pnpm test test/proxy.test.ts       # one file (or a name pattern: pnpm test -t "BFCL")
pnpm test:watch                    # re-runs the affected tests on every change
pnpm test:coverage                 # + coverage report: .data/coverage/index.html
pnpm verify                        # typecheck + lint + tests: before a commit, after an SDK update
```

**What the tests can't touch.** `test/setup.ts` runs before every test file, in that file's own process:

- **Database:** a fresh temporary one, with every migration applied on first use, deleted afterwards. The real
  `~/.ollama-bench/bench.db` is never opened.
- **Providers:** no judge or Cohere API keys, and Ollama is pointed at a port where nothing listens. No test spends
  money or reaches a real model by accident; a test that needs a model fakes one explicitly.
- **`server-only`:** replaced by an empty stub (`test/stubs/server-only.ts`), so tests can import server modules
  directly.

**What's covered so far:**

- the automatic checks;
- judge-verdict validation;
- the real Mermaid parser analysis;
- the BFCL checker;
- the file adapters, run on the real sample files in `.data/files/`;
- the leaderboard ranking;
- execution-time maths, size tiers and math normalisation;
- the database migrations;
- **security regression tests** for the request guard (`src/proxy.ts`): foreign or spoofed `Host`, cross-origin and
  cross-site writes, non-JSON bodies;
- **AI SDK contract tests** (`test/sdk/`): what the app sends to Ollama and reads back. They run the real `ai` +
  `ai-sdk-ollama` + `ollama` packages over real HTTP. Covered: streaming, token counts and decode speed, the session
  settings sent (num_ctx, seed, temperature, think, keep_alive), thinking, the tool-calling loop, structured output
  (JSON schema as Ollama `format`), mid-stream errors, cancellation. **Run them after updating any of those
  packages**: a failure names the behaviour that changed;
- **the runner end to end** (`test/runner/`), against the fake Ollama and a temporary database:
  - a whole session: every quick case, runs and case results, execution times, scores;
  - warm-up with the session context, the generation settings, unloading;
  - two models one after the other; num_ctx capped at the model maximum;
  - a failed warm-up, a mid-stream error with partial output, cancellation;
- **the API routes** (`test/api/`), called the way Next calls them (handler + request), against the fake Ollama and
  the temporary database:
  - sessions: input validation (400), errors from the runner, detail and list, live events, cancel, re-judge (409
    while running);
  - run history and the CSV export: UTF-8 BOM, file names that can't be broken by a model name, and **formula
    injection**: model output such as `=HYPERLINK(…)` is exported as text, never as a formula;
  - prompt preview and attached files: inline only for safe types, `nosniff`, index validation;
  - the model list (502 when Ollama fails), sync, models in memory, unload (409 while a session needs the model),
    host default context;
  - the test list, active sessions, capability batches.

  `test/setup.ts` replaces Next's `connection()` with a no-op: it only exists to stop prerendering, and it throws
  outside a real Next request;

- **the benchmark tests** (`test/lib/tests/`, `test/lib/rag/`), each one's `run()` against the fake Ollama and its
  `check()` on the result: a correct answer scores 10, typical mistakes fail the right check. Every benchmark test is
  covered:
  - tool use (and its tools: the calculator refuses anything but arithmetic);
  - BFCL;
  - structured output (native and prompt mode);
  - doc-to-markdown and image recognition (CSV and PDF as extracted text, images as native Ollama images);
  - embeddings, reranking (listwise, yes/no log-probabilities, embedding rerankers), RAG;
  - corpus chunking, ranking metrics and BM25.

  Retrieval runs on an **oracle embedder** served by the fake Ollama, which ranks perfectly by construction, so every
  check must pass; a flat embedder must fail them. A **fixture integrity** test checks that every answerable query, in
  both languages, points at chunks that exist.

  The tests that need Docker, the live web or downloaded datasets are covered without them:
  - **MCP** runs end to end with the real MCP server (`scripts/mcp/benchmark-server.mjs`), spawned as in the app; the
    app-only tool must never reach the model;
  - **web search** tests `run()` and its scoring with stand-in search/fetch tools (its `prepare()` needs Docker and
    the live web);
  - **Terminal-Bench** replaces `src/lib/docker.ts` with a scripted fake that records every call. It checks the agent
    loop, the sandbox flags (no network, resource limits, no mounts, owner label), the separate verifier container,
    how `reward.txt` is read, the "stuck" detection, and that containers are removed even when verification fails;
  - **OmniDocBench and MMMU-Pro** test their scoring, plus an MMMU-Pro run, on inline cases: a test must not depend
    on a dataset being downloaded on the machine running it;

- **the queries behind the pages** (`test/lib/queries/`), on a small history written straight into the database by
  `test/helpers/seed.ts`. It covers judged and unjudged runs, two languages, a non-default context, a result from an
  older suite version, a failed run, a re-pulled model and a removed test. Checked:
  - which run represents each model in the leaderboards;
  - capability scores and ranking (only models with a current result on every test they can take), size tiers;
  - the overview's overall score;
  - the model list;
  - the comparison: scores, tokens/s, and the average case time, measured or estimated for older runs;
  - active sessions with their progress, and batch status.
- **the judges** (`test/lib/judges/`, `test/runner/judged-session.test.ts`), with stand-in judge models
  (`MockLanguageModelV4` from `ai/test`, built by `test/helpers/judges.ts`) in place of the paid providers:
  - what each judge is asked, the clamped verdict, only the enabled judges;
  - the cache: an identical case is served from it, while a different response, rubric version or judge model is not
    a hit;
  - broken verdicts are retried; after three attempts the judge error is stored with no score (left out of averages,
    never a 0), and a broken verdict in the cache is not reused;
  - the "flat verdict" fallback: a flat mid-scale verdict on a case with an attachment is asked again without the
    file;
  - a judged session end to end (blind, per-judge means and their average), and re-judging one judge on chosen cases;
- **recovery and infrastructure** (`test/lib/runner/recovery-and-infra.test.ts`):
  - on start-up, sessions of stopped servers are interrupted and their containers removed, while live servers are
    left alone;
  - the GPU lock: one session at a time, in arrival order, surviving a failure;
  - the live event stream: replay, then new events, then the close;
  - which judges count as configured, and the Cohere rate limit;
- **the two pages with the most logic**, in two layers:
  - their logic, moved out of the components into plain modules and tested directly:
    - `src/app/sessions/[id]/session-state.ts`: the stored session turned into page state, each live event applied
      to it, execution times, judge disagreement;
    - `src/app/run/run-form-state.ts`: which tests run, which models qualify, the context cap, thinking, and the
      request that starts a session or a batch;
  - **component tests** (`test/app/*.test.tsx`), rendering the real components in a simulated browser (jsdom +
    React Testing Library), with `fetch`, `EventSource` and Next's router replaced:
    - the session page loads a finished session and follows a live one through its event stream;
    - Re-judge and Cancel post to the API;
    - the run form offers only the models that fit the chosen test, then starts a session or a capability batch;
    - it shows the server's refusal and stays on the page.

  A component test opts into the browser environment with `// @vitest-environment jsdom` as its first line; every
  other test runs in Node. The other pages (dashboard, leaderboards, comparison) are mostly display over the tested
  queries, and are not covered by component tests.

- **`pnpm security`'s findings** (`test/scripts/`), on trimmed copies of real CodeQL, gitleaks, pnpm audit and
  Docker Scout output: the conversion, IDs that survive code moving, suppressions (a reason required, expiry, a secret
  to rotate never suppressed), the priority order, and that no secret value can reach a finding. Coverage counts
  `src/` only, so these don't change it.

**Known failures** are written as `it.fails(…)`: the suite stays green while the bug exists, and that test turns red
once the bug is fixed, as a reminder to make it a plain `it(…)`. None at the moment.

**Fake Ollama** (`test/helpers/fake-ollama.ts`): a real HTTP server on a random local port that answers like Ollama.
It streams scripted `/api/chat` replies (text, thinking, tool calls, counts and durations, errors), records every
request, and answers warm-up, unload, `/api/tags`, `/api/show`, `/api/ps` and `/api/version`. A test points
`OLLAMA_HOST` at it before importing the modules that read it:

```ts
const ollama = await startFakeOllama();
process.env.OLLAMA_HOST = ollama.url;
const { runStream } = await import('@/lib/tests/generate');
ollama.replies.push(chatReply({ text: 'Hello', evalCount: 20, evalDurationMs: 500 }));
```

**Coverage** (`.data/coverage/`: `index.html` per file and line, `coverage-summary.json` for scripts) works as a
ratchet. The thresholds in `vitest.config.mts` start at the current coverage, so a drop fails
`pnpm test:coverage`. When coverage grows, Vitest raises them in the config file itself; commit that change with the
tests. Plain `pnpm test` doesn't measure coverage, and stays fast.

**VS Code:** the "AI SDK: verify" task runs `pnpm verify`, then the smoke test.

## `pnpm smoke`

Connectivity check: one call to Ollama (`granite4.2:3b`, "Reply with exactly: pong") and one structured-output call
per configured judge (90 s timeout each).

```bash
pnpm smoke
```

- **Output:** stdout only. It prints the Ollama reply, token usage, performance metadata and each judge's answer with
  its latency, or `judge <id> FAILED: …`.
- A judge without both a key and a model in `.env` is skipped, not reported as failed.
- A judge failure doesn't change the exit code, so read the output.

## `pnpm bench`

Batch runner: every selected test on every compatible model. It doesn't run anything itself. It drives the running
app through its API, so batch and browser runs share the GPU lock, the judges and the history, and every session can
be watched live in the UI.

Start the app first (`pnpm dev`, or `pnpm build && pnpm start` for long runs), then:

```bash
pnpm bench --dry-run                                  # the plan: sessions and case counts, nothing runs
pnpm bench                                            # every test × every compatible model, quick set, all judges
pnpm bench --subset full --skip-existing              # overnight: only what's missing for the current suites
pnpm bench --tests rag,tool-use --models "/^qwen/,gemma4:31b" --lang it --judges openai,anthropic
pnpm bench --tests structured-output --all-variants   # every option combination
pnpm bench --tests doc-to-markdown --num-ctx 32768    # non-default context: separate variant
pnpm bench --capabilities vision,tools --tier small   # every test of these capabilities
pnpm bench --tests terminal-bench --models qwen3.8:27b --judges none   # hours-long: only when named
```

| Option                                 | Meaning                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `--url <url>`                          | App URL (default `$BENCH_URL` or `http://localhost:3000`)                                        |
| `--tests <ids>`                        | Comma-separated test ids. Default: all except the CLI-only ones (`terminal-bench`, `web-search`) |
| `--capabilities <ids>`                 | The tests of these capabilities, as the app at `--url` lists them. Combines with `--tests`       |
| `--models <list>` / `--exclude <list>` | Model names or `/regex/`, comma-separated                                                        |
| `--tier small\|medium\|large\|all`     | Model size: < 10B, 10–50B, > 50B                                                                 |
| `--lang <codes>`                       | Languages (default: every language with cases)                                                   |
| `--subset quick\|full`                 | Case set (default `quick`)                                                                       |
| `--judges <ids\|none>`                 | Judges to use (default: all configured)                                                          |
| `--think`                              | Enable thinking for models that support it                                                       |
| `--num-ctx <n>`                        | Context window, capped at each model's maximum. A non-default value is a separate variant        |
| `--option key=value`                   | Test option override, repeatable                                                                 |
| `--all-variants`                       | Every combination of each test's options                                                         |
| `--skip-existing`                      | Skip combinations already completed with the same model digest, suite version and SDK versions   |
| `--ignore-sdk`                         | With `--skip-existing`: an SDK version change doesn't make a combination due again               |
| `--max-sessions <n>`                   | Stop after n sessions                                                                            |
| `--report <file>`                      | Report path (default `.data/reports/bench-<timestamp>.md`)                                       |
| `--dry-run`                            | Print the plan and exit                                                                          |

- **Strict flags:** a flag with an empty or invalid value is an error, never its default. So `--judges "$JUDGES"` with
  the variable unset can't quietly use every paid judge. An empty plan is an error too, unless `--skip-existing`
  found everything already done.
- **Order:** sessions are grouped by model, so each model loads once and is unloaded when the CLI moves on.
- **Output:** progress on stdout, plus a report in two formats: `.data/reports/bench-<timestamp>.md` (readable) and
  `.json` (the same data for scripts). Results are also stored in the app's database like any session.
- **Ctrl+C** cancels the current session and still writes the report.
- **Exit code:** non-zero if any session failed or was interrupted.

More context: [Batch runs (CLI)](../README.md#batch-runs-cli) and
[Context window](../README.md#context-window-num_ctx) in the root README.

## `pnpm rejudge`

Re-runs the judges on stored answers, without re-running the models.

```bash
pnpm rejudge <sessionId>                    # whole session, every configured judge
pnpm rejudge <sessionId> openai,anthropic   # only some judges
pnpm rejudge --invalid --dry-run            # list degenerate or flat stored verdicts
pnpm rejudge --invalid                      # re-ask only those judges on those cases
```

- `--invalid` finds verdicts with missing criteria, a leaked judge scratchpad, or flat mid-scale criteria. A flat verdict on a case with attached files
  is retried without the files.
- It only repairs verdicts from the judge model configured now, so a session never mixes judge models. For older ones
  it prints the override to use, e.g. `GOOGLE_MODEL=gemini-4-carbon pnpm rejudge --invalid`.
- **Output:** stdout. New verdicts go to the database and appear on the session page.

See [Re-judging and broken verdicts](../README.md#re-judging-and-broken-verdicts).

## `pnpm datasets:fetch`

Downloads the public benchmark data. The repo holds only pinned manifests (`fixtures/<test>/manifest.json`); this
fetches exactly those items into `.data/datasets/<test>/` and builds the cases the tests read.

```bash
pnpm datasets:fetch                          # OmniDocBench, BFCL, MMMU-Pro (~180 MB on disk)
pnpm datasets:fetch bfcl mmmu-pro            # some of them
pnpm datasets:fetch terminal-bench [--pull]  # Terminal-Bench tasks (+ pre-pull the quick tasks' Docker images)
pnpm datasets:fetch --select                 # maintainer: re-select the subsets and rewrite the manifests
```

- Files already downloaded are skipped, so a run can be repeated after a network failure.
- `--select` changes `fixtures/*/manifest.json`, and so the suite version. Commit it only on purpose.
- **Licences:** OmniDocBench is research use only / non-commercial, so its data must never be committed. BFCL,
  MMMU-Pro and Terminal-Bench are Apache-2.0.

See [Public benchmarks](../README.md#public-benchmarks-omnidocbench-bfcl-mmmu-pro).

## `pnpm tb:verify`

Checks the Terminal-Bench harness, not a model. For each task it runs the reference `solution/solve.sh` in the task
container, then the verifier, exactly as a benchmark run does after the agent. Reward 1 means the harness works for
that task. Anything else is a harness or environment problem.

```bash
pnpm tb:verify               # the quick tasks
pnpm tb:verify --all         # all 89 (pulls every image: tens of GB)
pnpm tb:verify fix-git       # specific tasks
```

- Needs `pnpm datasets:fetch terminal-bench` first, and Docker.
- **Output:** a summary on stdout (`n/m reference solutions verified`, with the tail of the log for each failure) and
  `.data/datasets/terminal-bench/verify.json` with each task's reward and duration.

See [Coding test (Terminal-Bench)](../README.md#coding-test-terminal-bench).

## Security checks

Four checks, each looking at something the others don't. None runs in the pre-commit hook. That hook only scans
the staged changes for secrets and lints them (see
[Secrets and security checks](../README.md#secrets-and-security-checks)).

| Check                                            | Looks at                         | Finds                                                                            | Time        |
| ------------------------------------------------ | -------------------------------- | -------------------------------------------------------------------------------- | ----------- |
| [`pnpm security:codeql`](#pnpm-securitycodeql)   | our source code                  | vulnerable patterns: injection, unsafe file or network use, …                    | 15–20 min   |
| [`pnpm audit --prod`](#pnpm-audit---prod)        | `pnpm-lock.yaml`                 | published advisories for the npm packages the app depends on                     | seconds     |
| [`docker scout cves`](#docker-scout)             | the built image                  | CVEs in Alpine packages, Node itself and every npm package in the image          | 1–2 min     |
| [`pnpm security:secrets`](#pnpm-securitysecrets) | git history, working tree, image | secrets outside `.env`: committed, in build output or logs, baked into the image | about 1 min |

The audit and Scout overlap on npm packages but aren't redundant. The audit reads the lockfile, so it also covers
packages that never reach the image. Scout reads the image, so it also covers the OS, Node and whatever the base image
brings.

## `pnpm security`

All four checks in one run, and **one report** of what they found: `.data/security/report.md` to read,
`.data/security/findings.json` for scripts and the `security-fix` skill.

```bash
pnpm security                  # audit, scout, secrets, codeql (fastest first)
pnpm security --build          # rebuild the Docker image first: scout and the image secret scan read it
pnpm security audit scout      # some checks only (seconds); the others keep their last result in the report
pnpm security --report-only    # run nothing: rebuild the report (after editing security-suppressions.json)
pnpm security --help
```

- **Each check runs through its own tool or script**, unchanged: `pnpm audit --json` (with and without `--prod`, to
  tell production from dev dependencies), `docker scout cves --format sarif`, `scripts/gitleaks.mts`,
  `scripts/codeql.mts --report md,html`. Their own reports stay where they were and are linked from the report.
- **Every check keeps its last result** in `.data/security/checks/<check>.json`. After a fix, re-run only the check
  that found it: the report still shows the others, with the date and commit they ran on. A ⚠️ marks a check that ran
  on another state of the code.
- **A missing prerequisite** skips the check when running everything: no Docker running, image not built, no CodeQL
  CLI. Naming the check makes it an error instead.
- **One shape for every finding:**
  - severity: critical / high / medium / low / note, with the tool's 0–10 score when it has one;
  - area: `app`, `prod-dependency`, `image`, `git-history`, `config`, `scripts`, `dev-dependency`, `tests`;
  - location, with a link to the file and line when it's in the working tree;
  - a suggested fix;
  - for packages: the fixed version, and the direct dependency that pulls the package in.

  Open findings are listed most urgent first: by severity, then by area in the order above (what the running app
  exposes before dev tooling), then by score.

- **Stable IDs** such as `codeql-1a2b3c4d` or `scout-69d2405a`. Each is a hash of what identifies the finding:
  - CodeQL: the rule, the file and its fingerprint of the line content, so the ID survives code moving around;
  - pnpm audit: the advisory and the package;
  - Scout: the CVE and the package;
  - gitleaks: its fingerprint.

  Suppressions and commit messages refer to the ID.

- **Secrets:** a finding never contains a secret value: only the rule, the place and gitleaks' fingerprint. An own
  secret (a `.env` value) found in the history or the image is marked **rotate**. Deleting the copy doesn't undo the
  exposure, so the key's owner must revoke and replace it. Such a finding can't be suppressed.

**Suppressions** (`security-suppressions.json`, committed): a finding accepted on purpose, with the reason. For
example, a CodeQL alert on a dev-only script, or a CVE in an image package the app never calls:

```json
{
  "suppressions": [
    {
      "id": "codeql-1a2b3c4d",
      "reason": "Reads a URL from our own config file, never user input; the CLI runs only on a developer machine.",
      "expires": "2027-03-01"
    }
  ]
}
```

- **Required:** `reason`, at least a sentence (20 characters). An entry without one is ignored and listed in the
  report.
- **Optional:** `expires` (YYYY-MM-DD). After that date the finding is open again, so the decision gets reviewed.
- **Cleanup:** an entry that matches no current finding (the finding is fixed, or the code changed) is listed so it
  can be removed.
- **gitleaks:** a false positive can still go in `.gitleaksignore`, as before, which keeps it out of the gitleaks
  report too.

**Exit code:** 0 no open findings · 1 open findings · 2 a check that was asked for failed (or `--build` failed), or a
usage error.

**VS Code:** `security:all` runs `pnpm security --build`.

## `pnpm security:codeql`

Runs the JavaScript/TypeScript `security-extended` CodeQL queries locally, the same suite GitHub runs on every pull
request. It takes a few minutes, too long for the pre-commit hook.

```bash
pnpm security:codeql                    # build the database if the sources changed, then analyze
pnpm security:codeql --rebuild          # always rebuild the database
pnpm security:codeql --report md,html   # also write a readable report (md, html, or both)
pnpm security:codeql --report-only      # no scan: rewrite the reports from the last results.sarif
pnpm security:codeql --help
```

| Option           | Meaning                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| `--rebuild`      | Always rebuild the database (default: only when the sources changed)                                   |
| `--report <fmt>` | Also write `results.md` and/or `results.html`: `md`, `html`, or `md,html` (the option can be repeated) |
| `--report-only`  | Skip the scan and rewrite the reports from the last `results.sarif`. Formats default to `md,html`      |

An unknown format, an unknown option, or `--report-only` together with `--rebuild` is an error (exit 2) before
anything runs.

**Steps** (each line is logged with the clock time and the time since start; each step logs its duration):

1. **Locate the CLI:** `$CODEQL`, then `codeql.exe` / `codeql` on the PATH, then `%LOCALAPPDATA%\codeql\codeql.exe`.
   Install it from [codeql-cli-binaries](https://github.com/github/codeql-cli-binaries) if none is found.
2. **Build the database.** CodeQL can't update a JavaScript database incrementally, so a change means a full
   rebuild. The script hashes the files git sees (tracked plus untracked, not ignored), the CLI and the extractor
   config. If the database exists and the hash matches the last build's, it reuses the database. A change to a
   git-ignored file that CodeQL still extracts isn't detected: use `--rebuild` then.
3. **Analyze:** runs the query suite. The query packs are downloaded on first use. The SARIF includes the code around
   each location and each rule's help text, for the reports.
4. **Read the results:** findings are sorted by severity, using GitHub's buckets on the rule's security-severity score
   (critical ≥ 9, high ≥ 7, medium ≥ 4, low).
5. **Write the reports** (only with `--report`).

At the end it prints one line per finding (severity, rule, `file:line`, message), then the output files: the SARIF
and Markdown paths, and the HTML report as a `file:///` URL. Ctrl+click one in the VS Code terminal to open it.
`--report-only` runs steps 4 and 5 only.

**Files** in `.data/codeql/`:

| File             | Content                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `results.sarif`  | The full results (SARIF 2.1.0 JSON): rules, messages, locations, data flows                                  |
| `results.md`     | Markdown report (`--report md`)                                                                              |
| `results.html`   | HTML report, a single file with no external resources; follows the system light/dark theme (`--report html`) |
| `db/`            | The CodeQL database                                                                                          |
| `db.fingerprint` | Hash of the sources the database was built from                                                              |
| `config.yml`     | Extractor config: skips `node_modules`, `.next`, `.data`                                                     |
| `scan.lock`      | Present while a scan runs; holds its PID                                                                     |

**Reading the reports.** Both reports have the same content:

- a header: scan time, commit (marked when there are uncommitted changes), whether the database was rebuilt or
  reused, CodeQL version, rules run, files scanned, duration;
- a summary: counts per severity and per rule;
- one section per finding:
  - the rule, its severity score, precision and CWE links;
  - the location and the message, whose references point to the related lines;
  - the code around the finding, with the reported lines marked;
  - the data-flow path from source to sink, when the rule tracks one;
  - the rule's help, collapsed.

The Markdown report links to the files relative to itself (`#L<line>`): open it in VS Code with the preview
(Ctrl+Shift+V) and the links jump to the line. The HTML report uses `vscode://file/…` links, which open VS Code at
the line from the browser.

With `--report-only`, any file that changed after the scan is flagged in the report: its code is read from disk and
may no longer match the reported lines.

The VS Code **SARIF Viewer** extension (Microsoft) also opens `results.sarif` directly.

**Exit codes:** `0` no findings · `1` findings, or a CodeQL step failed (its own exit code is passed on) · `2` usage
error, CLI not found, no SARIF for `--report-only`, or another scan holds the lock.

**`Another CodeQL scan is running`:** check whether the PID in `scan.lock` is still alive (`tasklist /FI "PID eq
<pid>"` on Windows). If it isn't, a scan crashed: delete the file and retry.

**VS Code:** `security:codeql` runs `pnpm security:codeql --report md,html`.

## `pnpm audit --prod`

Checks the production dependencies in `pnpm-lock.yaml`, direct and nested, against the advisories published for
npm packages (GitHub's advisory database, through the registry). `--prod` leaves out dev dependencies: build, lint
and test tools never run in the app.

```bash
pnpm audit --prod                           # every advisory
pnpm audit --prod --audit-level high        # only high and critical
pnpm audit --prod --json                    # machine-readable
pnpm audit --prod --fix                     # add pnpm overrides that force patched versions
pnpm audit --prod --fix update              # re-resolve the lockfile to patched versions instead
pnpm audit --prod --ignore GHSA-xxxx-xxxx-xxxx   # accept one advisory (repeatable)
```

- **Output:** stdout. A table per advisory: the package, its severity, the vulnerable and patched versions, the
  dependency path that pulls it in, and a link to the advisory.
- **Exit code:** non-zero when it finds an advisory at or above `--audit-level` (default: any).
- **Fixing:**
  - **Direct dependency:** upgrade it.
  - **Nested one:** upgrading the direct dependency that pulls it in is the clean fix. `--fix` adds an override to
    `pnpm-workspace.yaml` instead, which forces that version across the whole tree. Check that the package still
    works, and remove the override once the direct dependency ships the fix.
- **VS Code:** `security:audit`.

## `docker scout`

Scans the Docker image built from the [Dockerfile](../Dockerfile) for known CVEs: Alpine packages, the Node binary,
and every npm package in the image, including the ones the base image brings. It needs Docker Desktop signed in to a
Docker account.

Scout reads the image as built. After a code, dependency or Dockerfile change, rebuild it first: the `docker:build`
task in VS Code, or the `docker build` command in the root README's [Docker](../README.md#docker) section.

```bash
docker scout cves --only-fixed ollama-bench:local             # CVEs that have a fix: the ones you can act on
docker scout cves ollama-bench:local                          # every CVE, fixed upstream or not
docker scout cves --locations ollama-bench:local              # with the file path of each package
docker scout cves --only-severity critical,high ollama-bench:local
docker scout cves --format markdown --output .data/scout.md ollama-bench:local   # report (also sarif, spdx)
docker scout recommendations ollama-bench:local               # newer or smaller base images
```

- **Reading a finding:** `--locations` shows where a package sits in the image:
  - `/app/node_modules/...`: an app dependency. Fix it as for `pnpm audit`.
  - `/usr/local/lib/node_modules/...`: tools bundled with the base image. The Dockerfile removes npm, corepack and
    yarn for this reason.
  - `pkg:apk/...`: an Alpine package. Fixed by a rebuild once Alpine publishes the patched package.
- **Rebuild with `--pull`** (the `docker:build` task does): the final stage runs `apk upgrade`, but Docker caches
  that step until the base image changes. `--pull` fetches the current `node:24-alpine`, so a new base image or an
  Alpine fix reaches the image. A CVE whose fix Alpine hasn't published yet stays listed even with `--only-fixed`
  until then.
- **Exit code:** `0` even with findings. Add `--exit-code` to get `2` when there are any.
- **VS Code:** `security:scout` runs `cves --only-fixed`, then `recommendations`, on the image `docker:build` makes
  (`<folder>:local`, i.e. `ollama-bench:local`).

## `pnpm security:secrets`

gitleaks on what the two automatic scans don't cover. The pre-commit hook sees only the staged changes, and the
GitHub workflow only the commits of each push or pull request.

```bash
pnpm security:secrets                          # all three scans below
pnpm security:secrets history tree             # some of them
pnpm security:secrets image --image my-tag     # another local image (default ollama-bench:local)
pnpm security:secrets --env-file .env.prod     # also look for the values in another env file (repeatable)
pnpm security:secrets --help
```

| Scan      | Looks at                                                   | Catches                                                                                                                                                     |
| --------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `history` | every commit of every branch and tag                       | secrets committed before the hook existed, or with `git commit --no-verify`                                                                                 |
| `tree`    | the working tree, git-ignored files included               | secrets in build output (`.next`), `.data/` (reports, the CodeQL database), logs, stray files: anything one `git add -f`, paste or upload away from leaking |
| `image`   | the filesystem of the local Docker image (`docker export`) | a secret baked into the image, e.g. a `.env` that `next build` copied into the standalone output                                                            |

With no scan named, it runs all three, and skips `image` with a note when the image isn't built. Named explicitly,
a missing image is an error.

**Own secrets.** Besides gitleaks' default rules, every scan searches for the actual values in `.env` and
`.env.docker`, plus any `--env-file`. These are the variables named like `*KEY*`, `*TOKEN*`, `*SECRET*`,
`*PASSWORD*` or `*CREDENTIAL*`, 8 characters or longer. So a key is found wherever it was copied, even in a format
no default rule recognises, such as an `OLLAMA_API_KEY` for a proxy.

- The values reach gitleaks only through the `GITLEAKS_CONFIG_TOML` environment variable of its own process, never a
  file.
- Every report and every line of output is redacted.
- A finding shows the variable's name, never its value.

**What each scan skips** (allowlists; everything else is scanned):

| Skipped                                                                                                                               | Why                                                                         | Scans       |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------- |
| the env files themselves                                                                                                              | that's where secrets belong                                                 | tree        |
| `node_modules/`                                                                                                                       | third-party code, covered by `pnpm audit` and Scout                         | tree, image |
| Next's per-build keys (`preview-props.json`, `server-reference-manifest.json`, `prerender-manifest.json`, `.rscinfo`, `.previewinfo`) | generated by Next.js for each build, not ours                               | tree, image |
| `*.js.map`                                                                                                                            | source maps repeat the code next to them, which is scanned                  | tree, image |
| `.git/`, `.data/datasets/`, `.data/gitleaks/`                                                                                         | read properly by the history scan / third-party data / this script's output | tree        |

`history` skips nothing: a committed `.env` or build output is a finding. All three scans honour `.gitleaksignore`.

- **Output:** every run, clean or not, writes **`.data/gitleaks/report.md`** with all its scans and prints its path
  at the end. The report has:
  - a header: run time, commit, gitleaks version, and the names of the own secrets searched for (never their values);
  - a summary table: each scan, what it covered, its result and time;
  - the findings per scan, own secrets first: rule, location (a link to the file and line for `tree`; the commit for
    `history`; the path inside the image for `image`) and fingerprint;
  - what to do about them;
  - what each scan skipped.

  stdout lists the same findings as `[rule] file:line`, each with its fingerprint. `.data/gitleaks/<scan>.json` keeps
  gitleaks' raw, redacted report per scan.

- **Acting on a finding:**
  - **`OWN SECRET`:** a real key outside its env file. Remove that copy. If it was committed, pushed, or shipped in an
    image, rotate the key: removing it doesn't undo the exposure.
  - **Any other finding:** check it. A false positive goes in `.gitleaksignore`, one fingerprint per line.
- **Exit codes:** `0` clean · `1` findings · `2` usage error, gitleaks not installed, a gitleaks error, or the image
  missing when `image` was named.
- **The image scan** exports the filesystem of a container created from the image (never started) to
  `.data/gitleaks/image.tar`, about 1 GB, scans it and deletes it. The image is scanned as built, so rebuild it first.
- **VS Code:** `security:secrets` runs all three scans, on the image `docker:build` makes (`ollama-bench:local`).

## Reference data builders

These rewrite fixtures, the ground truth of some tests. Review the diff before committing. A fixture change also
changes the suite version, which keeps old and new results apart.

```bash
# doc-to-markdown references (fixtures/doc-to-markdown/reference/*.md), any of: csv xlsx docx pdf
pnpm tsx --conditions=react-server --env-file=.env scripts/build-doc2md-refs.mts csv xlsx docx

# image-recognition pages (fixtures/image-recognition/images/i1095a-p<n>.png) from .data/files/i1095a.pdf
node scripts/render-pdf-pages.mjs
```

- `build-doc2md-refs.mts`: CSV, XLSX and DOCX are converted deterministically. `pdf` asks Claude to read the PDF
  (needs `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL`) and produces a draft that must be reviewed. With no arguments, it
  rebuilds all four. The image reference is hand-written.
- Both read their sources from `.data/files/`.

## Judge image experiment

A calibration experiment, kept for reference rather than routine use. It re-judges one stored, known-good answer N
times per image variant (format, size, position in the message) to see whether the Google judge's flat 7 on image
cases depends on them. It found it doesn't (see
[Re-judging and broken verdicts](../README.md#re-judging-and-broken-verdicts)).

```bash
pnpm tsx --conditions=react-server --env-file=.env scripts/judge-image-experiment.mts [reps=4] [variant-filter]
```

**Output:** stdout only. It loads `sharp` by its path inside `node_modules/.pnpm`, so it breaks when that version
changes.
