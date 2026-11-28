# ollama-bench

Benchmark Ollama models through a set of tests. You can compare two models side by side. Blind judges from OpenAI,
Google and Anthropic score each run, and every result is stored in a local SQLite history. See [PLAN.md](PLAN.md) for
the design and roadmap.

## Setup

Node **24**, the major named in `.nvmrc` (`nvm install && nvm use`) and in the Dockerfile's `NODE_VERSION`. Both name
the major only, so every install or image build picks up the latest 24.x security fixes; a test checks that the two
agree.

```bash
pnpm install
pnpm smoke   # checks Ollama + each judge with one tiny call
pnpm dev     # http://localhost:3000
pnpm verify  # typecheck + lint + tests (Vitest; coverage with pnpm test:coverage)
```

Every command-line script (tests, benchmarks, re-judging, dataset downloads, fixture builders, security scans) is
documented, with its options, output files and exit codes, in [scripts/README.md](scripts/README.md#pnpm-test).

The app is local-only: `pnpm dev` and `pnpm start` bind to loopback, and requests using non-local hostnames or
cross-origin API writes are rejected. Do not expose the app through a LAN address or reverse proxy without adding
authentication and CSRF protection for that deployment.

`.env` (never committed):

| Var                                             | Purpose                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| `OLLAMA_HOST`                                   | `host`, `host:port` or a full URL (port defaults to 11434)          |
| `OLLAMA_API_KEY`                                | optional; sent as a Bearer token                                    |
| `OPENAI_API_KEY` / `OPENAI_MODEL`               | OpenAI judge                                                        |
| `GOOGLE_GENERATIVE_AI_API_KEY` / `GOOGLE_MODEL` | Google judge                                                        |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL`         | Anthropic judge                                                     |
| `COHERE_API_KEY` / `COHERE_MODEL`               | reranking baseline (RAG / rerank tests)                             |
| `COHERE_RPM`                                    | optional; Cohere calls per minute (default 10, the trial-key limit) |

A judge without a key and a model is skipped. The DB lives at `~/.ollama-bench/bench.db` (override with `BENCH_DB_PATH`), outside the project so the dev server's file watcher never sees its writes. Migrations in `drizzle/` are applied
automatically when the DB opens.

### Secrets and security checks

- **Pre-commit hook** (`.githooks/pre-commit`, turned on by `pnpm install`): blocks a commit when
  [gitleaks](https://github.com/gitleaks/gitleaks#installing) finds a secret in the staged changes (shown redacted),
  or when the staged files fail Prettier or ESLint. It needs gitleaks on the PATH. `git commit --no-verify` skips
  it once.
- **False positives**: add the fingerprint gitleaks prints to `.gitleaksignore`. A real secret belongs in `.env`; if
  one was committed, rotate it, because removing it from a later commit doesn't remove it from history.
- **GitHub**: the `gitleaks` workflow scans every push and pull request, so a skipped hook is still caught. CodeQL
  (GitHub's default setup) checks every pull request.
- **Local security checks**, each with a Run and Debug entry in the **security** group. Usage, options and how to
  act on findings: [scripts/README.md](scripts/README.md#security-checks).
  - `pnpm security` (`security:all`): the four checks below in one run, and one report of every open finding, most
    urgent first, with its fix (`.data/security/report.md`, plus `findings.json`). Accepted findings go in
    `security-suppressions.json`, each with its reason.
  - `pnpm security:codeql` (`security:codeql`): CodeQL's security-extended queries on the sources. It takes 15–20
    minutes, too long for a hook. `--report md,html` writes a readable report.
  - `pnpm audit --prod` (`security:audit`): known vulnerabilities in the production dependencies of
    `pnpm-lock.yaml`.
  - `docker scout cves --only-fixed ollama-bench:local` (`security:scout`): CVEs in everything the
    [Docker image](#docker) ships: Alpine packages, Node and the npm packages. Rebuild the image first.
  - `pnpm security:secrets` (`security:secrets`): gitleaks on the whole history, the working tree (git-ignored files
    included) and the Docker image. It also searches for the values in `.env` / `.env.docker` wherever they were
    copied. It writes a Markdown report every time (`.data/gitleaks/report.md`).

## Docker

The [Dockerfile](Dockerfile) builds the production app on `node:24-alpine`, for running it in a container on this
machine. In VS Code, **`docker:run`** (Run and Debug) builds the image (`docker:build` task) and starts it on
http://localhost:3300. On the command line:

```bash
docker build --pull -t ollama-bench:local .
docker run --rm --name ollama-bench-local --hostname ollama-bench-local -p 127.0.0.1:3300:3000 \
  --add-host=host.docker.internal:host-gateway -v "$PWD/.env.docker:/app/.env:ro" ollama-bench:local
```

- **Names:** the image is `<folder>:local` and the container (and its hostname) `<folder>-local`, where `<folder>`
  is the workspace folder name: `ollama-bench:local` and `ollama-bench-local` here. The VS Code tasks and launch
  entries derive them from `${workspaceFolderBasename}`, and `pnpm security:secrets` uses the same default. Docker
  names must be lowercase, so keep the folder name lowercase.
- **Tests that need Docker don't run in the container:** `terminal-bench` and `web-search` start containers of
  their own, and the app's container has no Docker client or daemon. Giving it the host's Docker socket would hand the
  web app root-equivalent control of the machine. Both tests are CLI only: run them with `pnpm bench --tests …`
  against the app on the host (`pnpm dev` or `pnpm start`).
- **Settings:** create `.env.docker` from `.env.example` before the first build (git-ignored like every `.env*`
  file). Services running on this machine are reached as `host.docker.internal`, e.g.
  `OLLAMA_HOST=host.docker.internal`. The file is mounted as the server's `.env` at run time, and only then:
  the build gets no settings. `next build` copies every `.env` file it loads into the standalone output, which the
  image ships, so `.dockerignore` keeps `.env*` out of the build context (and the build deletes any copy, just in
  case). `pnpm security` checks the image for them.
- **Loopback only:** the port is published on `127.0.0.1`. Inside the container the server must listen on every
  interface for Docker to reach it, and the app has no authentication.
- **History:** the database lives in the container (`/home/node/.ollama-bench/bench.db`), so `--rm` throws it
  away. To keep it, add `-v ollama-bench-db:/home/node/.ollama-bench`.
- **Not in the image:**
  - The downloaded public benchmarks (`.data/datasets/`). Mount them with
    `-v "$PWD/.data/datasets:/app/.data/datasets:ro"` to run OmniDocBench, BFCL or MMMU-Pro.
  - The Docker CLI. Terminal-Bench and web search start containers of their own, so they don't work from inside
    this one.
- **Contents:** Next's standalone output (`output: 'standalone'` in `next.config.ts`), about 400 MB. It holds
  `server.js` with only the `node_modules` the server loads, running as the non-root `node` user. The rest:
  - **Files read by path:** migrations, fixtures and the sample files are listed in `outputFileTracingIncludes`.
  - **The MCP test's server** (`scripts/mcp/benchmark-server.mjs`) runs as its own Node process, so Next doesn't
    trace its imports. The build bundles it with esbuild into one self-contained file.
  - **SDK versions:** Turbopack compiles `ai` and the providers into the server code, so their `package.json` files
    aren't there. The versions each session records come from the build (`next.config.ts` `env`).
  - **Removed:** npm, corepack, yarn, the C headers and the APK index cache. The server doesn't use them, and they
    only added CVEs or secret-scan false positives.

  Locally, `pnpm start` (`next start`) still works with this config, and prints a warning that standalone output
  should use `node .next/standalone/server.js`.

## How a run works

1. Choose a test, a language and 1–2 models. The list only shows models whose Ollama capabilities match the test.
2. Models run **one at a time**: each model is warmed up first (load time is reported separately), then every case
   is streamed. Metrics: latency, time to first token, tokens/s (from Ollama's `eval_duration`), reasoning tokens,
   and **execution time**. Execution time measures only the model's work, never the automatic checks, the judges or
   time spent queued:
   - **per case:** the whole case, so every model call, tool call and test step (for Terminal-Bench, the container,
     agent loop and verifier);
   - **per model run:** warm-up + preparation + its cases;
   - **per session:** the sum of its runs.

   It's shown on the dashboard (recent runs), on the session page (header, each model, each case), in the
   leaderboards and run tables, and in the CSV export (`exec_ms`). Runs recorded before it was measured show the run's
   start → end, which never included judging (it runs alongside the next generation); their cases show none.

3. Automatic checks (format, limits, exact answers, language) produce the **Auto** score (0–10).
4. Each judge scores every answer **blind**, on 0–10 with per-criterion detail. A run reports **each judge's mean
   and their average**. Judgments are cached by (rubric, judge model, prompt + response).

### Context window (`num_ctx`)

Every request sends `num_ctx` explicitly: each test's default (8192 for most tests, more where long documents need it),
or the value set in the run form / `pnpm bench --num-ctx`. It therefore never depends on the host's
`OLLAMA_CONTEXT_LENGTH`, which only applies to requests that don't set it. That keeps results comparable across hosts.

- The run form shows each model's maximum context (from `/api/show`). A value above the smallest maximum of the
  selected models is capped at that maximum, and the session header says "capped from …".
- A non-default `num_ctx` is a separate variant (like a test option): it gets its own leaderboard row, and
  `--skip-existing` treats it as its own key.
- "Detect host default" loads a small model briefly without `num_ctx`, then reads the context Ollama gave it from
  `/api/ps`. It waits for any running benchmark (GPU lock). If even the largest-context model was capped by its own
  maximum, the result is shown as "≥".
- A larger context costs VRAM (KV cache) and, for some models, speed. For example, granite4.2:3b uses about 5 GB at 8k
  and 24 GB at 64k. It changes scores only when inputs are actually long (documents, RAG, many tool turns).

## By test or by capability

The dashboard and the run form both have two views.

- **By test:** one leaderboard per test, or one test per run. The dashboard shows each model once, with its best result
  (current suite version first, judged before unjudged, then score); `+N` links to the test page, which lists every
  language, variant and digest.
- **By capability:** tests grouped by what they measure (`src/config/capabilities.ts`; a test can be in several).

| Capability | Tests                                                    |
| ---------- | -------------------------------------------------------- |
| Text       | text-generation, structured-output, doc-to-markdown, rag |
| Vision     | image-recognition, omnidocbench, mmmu-pro                |
| Tools      | tool-use, bfcl, mcp, web-search                          |
| Coding     | terminal-bench                                           |
| Retrieval  | embeddings, reranking, rag                               |

**Capability leaderboard** (`/?view=capability&cap=vision&lang=en`):

- A model's capability score is the mean of its scores on the capability's tests. Each test score is the one its
  leaderboard shows (judge average, otherwise the automatic score): the model's **best** run in the chosen language,
  over every variant and digest (same rule as the per-test tables). A non-default variant is marked in the cell: a
  `32k`-style superscript for another `num_ctx`, `*` for other test options; hovering shows it.
- Only results from each test's **current suite version** count. Older ones are shown struck out.
- A model is **ranked** only with a current result on every test it can take, by its Ollama capabilities. An embedding
  model can't run RAG, and a chat model can't run the embeddings test. Tests that nobody has run yet (e.g. web search
  without credits) are not required. Partial rows are shown in brackets. Remote baselines (Cohere) are shown for
  reference and never ranked.
- **Overview** shows a model × capability matrix. Each score cell links to its session.
- **Speed vs quality** under each table: ranked models only, score against mean tokens/s over the same results. In
  Overview the score is the mean of the model's ranked capabilities (tooltip lists them), and tokens/s counts each test
  once. Models with no tokens/s (embedding, reranking) are left out and counted in the note.

**Capability runs** (`/run`, Capability tab): pick a capability, uncheck any tests you don't want, then pick 1–2
models. The model list only shows models that can take every checked test. This starts a **batch**: one session per
test, each with the selected models side by side. The sessions run one after another (the GPU lock is first come,
first served). Test options stay at their defaults, so the results count toward the capability score.
`/batches/[id]` shows a test × model grid that updates while the batch runs, with a link to each session and a
"Cancel batch" button.

The top of `/run` shows the session running now (test, models, cases done, and whether it is still generating or
already judging) and any queued behind it. A run started then waits its turn (`/api/active` returns the same list).

A session only runs inside the server process that started it. Each server records itself in the database and
sends a heartbeat every 20 s, and every session stores its owner. When a server starts, it marks as **interrupted**
the queued/running sessions of servers that stopped (silent for 90 s), and removes the Docker containers they left
behind (labelled `ollama-bench.instance=<id>`). Sessions of a server that's still running are never touched, so
several servers can share the database, e.g. the VS Code `dev` configuration on :3000 next to another one.

**Dev server reloading in a loop** (an open page refreshes several times a second; the log shows endless
`GET /…` plus `Compiled in 1ms`): the dev cache is stale, typically after a `pnpm build` in the same folder. Stop
`pnpm dev`, delete `.next/dev` (the dev server's own cache; the production build is untouched), and start again.

**Model memory on the Ollama host.** A model stays loaded only while something needs it:

- When a session's GPU work ends, the runner unloads its model **unless a queued session uses it next**. It keeps it
  warm for that session; capability batches queue all their sessions up front, so they benefit automatically.
  Helper models (RAG's embedder) are released the same way.
- `pnpm bench` sends sessions one at a time, grouped by model. Each session tells the server whether the next one uses
  the same model (`keepLoaded`), so a model loads once for all its tests and is freed when the CLI moves on.
- A session with two models unloads each one right after its run, so the second never shares the GPU with the first.
- `keep_alive: 15m` stays as the safety net: if the app stops mid-run, Ollama frees the memory by itself.
- `/run` lists what the host holds right now (memory, context, when it unloads), with an **Unload** button for
  leftovers, e.g. from another app or a stopped server. Models a queued or running session needs can't be
  unloaded (HTTP 409). API: `GET /api/ollama/loaded`, `POST /api/ollama/unload {model}`.

**Run benchmarks from one server at a time.** The GPU lock that keeps sessions sequential lives inside each server
process. Two servers running sessions at once both load models on the Ollama host, which skews timings and can
exhaust its memory. The top of `/run` lists sessions from every server.

## Mixture-of-experts models

Models built from experts get a **MoE** tag on `/models` and on their own page. Hovering shows the details, e.g.
"128 experts, 8 active per token". The counts come from Ollama's `/api/show` (`model_info`: `<arch>.expert_count`
and `<arch>.expert_used_count`), are cached per digest, and are stored with the model (`models.experts`,
`models.experts_active`).

## Comparing two models

On `/models`, **Compare** takes a first model, then a second one from the models that share at least one Ollama
capability with it. A model's page has a "Compare with…" link that preselects it. `/models/compare?a=…&b=…&lang=…`
shows:

- **Two polar charts:** by capability (Text, Vision, Tools, Coding, Retrieval) and by test. They use the same scores
  as the dashboard (latest current-version results, default options, judge average or automatic score). Only axes
  where both models have a score are drawn, since a missing value would read as 0. With fewer than 3 axes the same
  values become grouped bars.
- **A table** with both scores and the difference (A − B) per capability and per test. Partial capability scores are
  in brackets; results from older test versions are struck through and not compared.
- **History by test:** both models' runs over time, one chart per test and variant, in the chosen language.

⇄ Swap exchanges A and B.

## Session page

Each case card has a **Prompt** button. It opens an overlay with what the case gave the model: the task, the input
(system prompt, tools, user message, retrieved passages), any attached files, and, collapsed, the reference only the
judges see. It is loaded on demand from `/api/sessions/[id]/prompt?case=…`. By default it is the test's judge material
without the response. Tests whose judge material is thinner than the real prompt define `promptPreview` (BFCL: the
messages and function definitions; MMMU-Pro: the message built for the session's options).
Attached files are links (`/api/sessions/[id]/prompt/file?case=…&i=n`): images, PDFs and plain text open in the
browser; other types (DOCX, XLSX) download. Doc-to-markdown shows the real prompt: the system rules, the instruction and
the extracted text exactly as sent, with the original file linked.

**Raw / Preview:** outputs can be shown as returned (Raw) or rendered as Markdown (Preview). There is one switch for
the whole page and one per case, and it applies to every model column of the case so they stay comparable. The
preview renders GFM (tables, task lists), LaTeX math with KaTeX (`$…$`, `$$…$$`, and the `\(…\)` / `\[…\]` forms
models often use) and ` ```mermaid ` diagrams. Dollar amounts such as `$5` stay text. Model output is untrusted:
raw HTML is ignored, images are shown as links rather than loaded, KaTeX runs with `trust: false`, and Mermaid runs in
strict mode. Scores always come from the raw text.

## Coding test (Terminal-Bench)

Needs **Docker** on the machine that runs the app (here: Docker Desktop, x86_64). Models stay on the Ollama host,
and code only ever runs in containers. (A Polyglot test, Aider's 225 Exercism exercises, was tried and removed as too
expensive to run; its past sessions stay in the database but no longer show in lists or charts.)

**Terminal-Bench 2.1** (`terminal-bench`, CLI only): [89 agentic tasks](https://github.com/harbor-framework/terminal-bench-2-1)
(software engineering, debugging, security, data, sysadmin…) in each task's own container. Quick: the 4 easy tasks plus
the medium task with the shortest time limit.

```bash
pnpm datasets:fetch terminal-bench [--pull]       # tasks at the pinned commit (+ pre-pull the quick images)
pnpm tb:verify                                    # optional: reference solve.sh + verifier must give reward 1
pnpm bench --tests terminal-bench --models qwen3.8:27b --judges none
```

- **Agent:** our AI SDK loop with one `bash` tool that runs inside the task container (up to 80 steps, within the task's
  own time limit). Command output is clipped to its start and end. Task containers have no network access and a 10 GB
  writable-layer limit; Docker must support per-container storage quotas.
- **Verifier (Harbor's protocol):** the task workspace is snapshotted into a fresh, network-isolated container;
  `tests/` is copied to `/tests`, then `bash /tests/test.sh`. The reward comes from
  `/logs/verifier/reward.txt`, and the verifier also runs after an agent timeout. **Score = share of tasks with reward 1.**
- **Hours per model** (task time limits sum to 42 hours for the full set), so it's started only from the CLI. A plain
  `pnpm bench` skips it, and the run form shows it as "CLI only". Results and transcripts appear in the app like any
  session. Images are pulled on first use (tens of GB for all 89).
- **Not comparable 1:1 with the [leaderboard](https://www.tbench.ai/leaderboard/terminal-bench/2.1)**, which uses the
  Terminus 2 agent (tmux) and 5 trials per task. Upstream tasks may use the internet; this harness disables networking
  to keep model-generated commands isolated.

## Mermaid diagrams

Text generation includes `mermaid-flowchart` (en + it): turn a refund-status procedure into a medium-size Mermaid
flowchart. It needs two named subgraphs, labelled decision diamonds, a retry loop and 12–25 nodes, returned as a
single code block. Answers are checked with **the real Mermaid parser**, server-side (`src/lib/mermaid-check.ts`):

- `{ "type": "mermaid", "diagram": "flowchart", "onlyBlock": true }`: exactly one ` ```mermaid ` block that
  parses, of that diagram type, with no other text. The parse error is shown in the check detail.
- `{ "type": "mermaidGraph", ... }`: structure of the parsed flowchart: `minNodes`/`maxNodes`, `minDecisions`
  (diamonds), `minSubgraphs`, `minLabelledEdges`, `cycle`, `labels` (found in node or edge labels), `subgraphTitles`.
  Partial credit is the share of requirements met.

Both check types can be used in any text-generation case. The judges assess fidelity to the described process,
which the checks can't (for example, whether the right steps sit inside each subgraph). Use **Preview** on the
session page to see the rendered diagram.

## Files sent to models

Doc → Markdown and image tests build standard AI SDK file parts (bytes + media type). `src/lib/files/file-part.ts`
adapts them for Ollama, which only accepts images:

| Media type                         | Sent as                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| `image/*`                          | native image part                                                                           |
| text formats (CSV, JSON, XML, MD…) | `<file name type>` text part, decoded as UTF-8 (falls back to Windows-1252)                 |
| XLSX                               | text part with one CSV per sheet (no blank rows or trailing empty cells, merged cells once) |
| DOCX / PDF                         | text part with the extracted text (mammoth / unpdf)                                         |
| audio / video                      | unsupported                                                                                 |

Judges receive the original images and PDFs natively, so they can check fidelity against the source.

## Batch runs (CLI)

With the app running (`pnpm dev`, or `pnpm build && pnpm start` for long runs):

```bash
pnpm bench --dry-run                                  # the plan: sessions and case counts
pnpm bench                                            # every test × every compatible model, quick set, all judges
pnpm bench --subset full --skip-existing              # overnight: only what's missing for the current suites
pnpm bench --tests rag,tool-use --models "/^qwen/,gemma4:31b" --lang it --judges openai,anthropic
pnpm bench --tests structured-output --all-variants   # every option combination (native + prompt)
pnpm bench --tests doc-to-markdown --num-ctx 32768    # non-default context: separate variant, capped per model
pnpm bench --capabilities vision,tools --tier small   # every test of these capabilities (src/config/capabilities.ts)
pnpm bench --help
```

Every option is listed in [scripts/README.md](scripts/README.md#pnpm-bench).

`--capabilities` takes the capability → tests mapping (`src/config/capabilities.ts`) from the app it talks to
(`/api/tests`), so it matches that build, and a test added to a capability there is included without touching the
CLI. An older build that doesn't report it falls back to the local checkout's config, with a warning. It combines
with `--tests`. Hours-long tests are included when their capability is named (`coding` → Terminal-Bench); a plain
`pnpm bench` still skips them.

A flag given with an empty or invalid value is an error, never its default, so `--judges "$JUDGES"` with the
variable unset can't quietly use every paid judge. That covers unknown tests, capabilities, judges and `--option`
keys or values, a language none of the selected tests has, and `--tier`, `--subset`, `--num-ctx` or
`--max-sessions` out of range. A plan that comes out empty is an error too, unless `--skip-existing` found
everything already done.

- It talks to the app through its API (`--url`, default `$BENCH_URL` or `http://localhost:3000`). Sessions share the
  app's single-GPU lock, so batch and browser runs never overlap, and every session can be watched live in the UI.
- Sessions are grouped by model (one load per model). `--skip-existing` skips any (model digest, test, language,
  variant, set, suite version) combination already completed, so editing fixtures or re-pulling a model makes it due
  again. Remote baselines (Cohere) join only the first session per test and language.
- Each run writes `.data/reports/bench-<timestamp>.md` and `.json`. Ctrl+C cancels the current session and still
  writes the report. The exit code is non-zero if anything failed or was interrupted.

## History & export

- `/tests/<id>`: leaderboard per language, speed vs quality (tokens/s, or latency for retrieval tests), every run.
- `/models` and `/models/<name>`: every benchmarked model; per model, one history chart per test/language/variant.
- `/api/export?testId=…&model=…&level=run|case`: CSV export (UTF-8 with BOM, opens in Excel).

## Updating the SDK (VS Code)

`.vscode/tasks.json` provides "AI SDK: check outdated", "AI SDK: update packages", "AI SDK: verify" (typecheck + lint

- smoke) and "AI SDK: update + verify". Then "Bench: re-run after SDK update" (`pnpm bench --skip-existing`) re-runs
  every combination whose last run used other `ai` / `ai-sdk-ollama` versions. Every session records the installed
  versions of `ai`, `@ai-sdk/*`, `ai-sdk-ollama` and the `ollama` JS client (session header, run tables, CSV), so score
  changes can be traced to a library update.

`.vscode/launch.json` (Run and Debug) groups its entries in three groups:

- **run:** `dev`, `start`, and `docker:run` (see [Docker](#docker)).
- **bench:**
  - `bench:dry-run` (`pnpm bench --skip-existing --dry-run`).
  - `bench:quick` builds and starts the production server on :3000 (task "App: build + start (production)", left
    running in its terminal), then runs `pnpm bench --subset quick --lang en --judges openai --skip-existing`.
  - `bench:terminal-bench` uses the same server and runs the quick Terminal-Bench tasks.
  - `ai-sdk:update` updates the packages, then runs the smoke test.
- **security:** `security:all`, `security:audit`, `security:scout`, `security:secrets` and `security:codeql` (see
  [scripts/README.md](scripts/README.md#security-checks)).

Before the bench entries, stop any other app server: :3000 must be free, and benchmarks must run from one server at
a time.

## Public benchmarks (OmniDocBench, BFCL, MMMU-Pro)

The repo holds only pinned manifests (`fixtures/<test>/manifest.json`: dataset revision + selected item ids). Download
the data once (into `.data/datasets/`, git-ignored):

```bash
pnpm datasets:fetch                 # all three (~180 MB on disk; ~200 MB transferred)
pnpm datasets:fetch bfcl            # just one
pnpm datasets:fetch --select        # maintainer: re-select the subsets and rewrite the manifests
```

| Test           | Subset                                                                                                       | Scoring                                                                                              | Judges                  |
| -------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------- |
| `omnidocbench` | 42 English pages, 6 per document type (quick 5)                                                              | text similarity (1 − NED), table cell F1 (TEDS not ported), formula similarity (CDM not ported)      | yes (they see the page) |
| `bfcl`         | 60 single-turn items: simple, multiple, parallel, parallel-multiple, irrelevance (quick 5)                   | ported BFCL AST checker, accuracy                                                                    | no (deterministic)      |
| `mmmu-pro`     | 30 items, one per subject (quick 5); option `config`: standard (10 options) / vision; `prompt`: cot / direct | answer letter, accuracy (an unparseable answer counts as wrong instead of the official random guess) | no (deterministic)      |

Licences: **OmniDocBench is research use only / non-commercial**, so its data is downloaded, never committed. BFCL and
MMMU-Pro are Apache-2.0. MMMU-Pro is read from the dataset's Parquet files with HTTP range requests and the page index
(hyparquet), so only the pages holding the selected rows are downloaded.

## Web search and MCP tests

- **web-search** (v2, CLI only: `pnpm bench --tests web-search`) gives the model a **DuckDuckGo MCP server**: tools `search` and `fetch_content`, from Docker's
  `mcp/duckduckgo` image, connected with `@ai-sdk/mcp` over stdio. It replaced ai-sdk-ollama's `webSearch`/`webFetch`,
  which call Ollama's cloud API and need paid credits. Answers that change over time are checked against the npm
  registry / GitHub API at run time.
  - **CLI only**, like Terminal-Bench: the run form doesn't offer it, and a plain `pnpm bench` skips it. It starts
    its MCP server with `docker run`, which works only when the app runs on the host, not in its
    [container](#docker).
  - **Image:** `docker/duckduckgo/Dockerfile`, built automatically on first use as `ollama-bench-duckduckgo:<hash>`.
    It's the upstream image pinned by digest, plus the optional `curl_cffi` backend with Firefox impersonation. Without
    those, DuckDuckGo blocks the server (HTTP 202, empty results); its hardcoded Chrome impersonation was blocked too
    (checked 2026-11-27).
  - **Sandbox:** one container per run, with internet access, no host mounts, 512 MB / 1 CPU and the owner label used
    for recovery. A preflight search fails the run up front if DuckDuckGo blocks it.
  - **Live web:** rankings and pages change, and DuckDuckGo rate-limits (the server caps at 30 searches / 20 fetches
    a minute). Empty or failed searches aren't scored against the model; judges see them flagged as infrastructure
    problems.
- **mcp** runs the tool-use cases with tools served by `scripts/mcp/benchmark-server.mjs` (stdio) through
  `@ai-sdk/mcp`, so MCP and native tool-calling scores are comparable. It also checks MCP Apps: only model-visible
  tools (`splitMCPAppTools`) reach the model.

## Size tiers

Dashboard, test pages and the models list can be filtered by parameter count (< 10B, 10–50B, > 50B); CLI: `--tier`.
Remote baselines (no size) stay visible in every tier.

## Capability overrides

`src/config/model-overrides.ts` corrects capabilities Ollama reports wrongly: BERT-family models are never chat
models, and models whose name contains `reranker` get `rerank` (Ollama 0.40 cannot run them yet), so they don't
appear in tests they can't run.

## Re-judging and broken verdicts

- **Verdict validation:** a judge's answer must score every rubric criterion (by name) and give a real rationale. A
  degenerate verdict is retried up to 3 times; if it stays broken it is stored as a **judge error, excluded from the
  averages, never counted as 0**. One example: Gemini once returned no criteria and its own scratchpad ("Wait—no extra
  text outside JSON!") with score 0. Cached verdicts are validated before reuse.
- **Flat verdicts with attachments:** with an image attached, Gemini often scores answers it calls flawless a flat 7:
  every criterion gets 7, and every comment is positive. Converting the format, upscaling, moving the image, raising
  media resolution or thinking level don't change this (see `scripts/judge-image-experiment.mts`). When a verdict on
  a case with attached files has every criterion at the same mid-scale score (above 3, below 9), that judge is
  re-asked **without the files** and scores against the reference only. The other judges still see the files. The
  verdict shows **(no file)** on the session page, and the `judgments.without_attachments` column records it.
- **Session page:** each case flags **"judges disagree"** when its judge scores are 4+ points apart. Open a judge's
  verdict, and **↻ Re-judge with …** re-asks only that judge on that case. **Re-judge** in the header redoes the
  whole session.
- **CLI:** `pnpm rejudge <sessionId> [openai,google,anthropic]` re-judges a session.
  `pnpm rejudge --invalid [--dry-run]` finds every degenerate or flat stored verdict and re-asks only those. It only
  repairs verdicts from the judge model currently configured, so a session never mixes judge models. For older
  ones, it prints the override to use, e.g. `GOOGLE_MODEL=gemini-4-carbon pnpm rejudge --invalid`.

## Reference data

- `fixtures/doc-to-markdown/reference/*.md` is the ground truth for conversions. Rebuild the deterministic ones (CSV,
  XLSX, DOCX) with `pnpm tsx --conditions=react-server --env-file=.env scripts/build-doc2md-refs.mts csv xlsx docx`.
  The PDF draft was produced by Claude reading the PDF (`… build-doc2md-refs.mts pdf`) and then reviewed. The image
  reference is hand-written.
- `fixtures/image-recognition/images/` holds the PDF pages rendered with `node scripts/render-pdf-pages.mjs`.

## Retrieval tests (embeddings, reranking, RAG)

- Corpus: `fixtures/corpus/docs/*.md`, chunked by heading (each chunk is prefixed with its heading path); tables are
  split into groups of 12 rows with the header repeated.
- Questions: `fixtures/corpus/cases/<lang>.json`. A question's relevant chunks are the chunks containing the text in
  `relevant[].contains`, so labels survive chunker changes. `unanswerable` questions are used only by RAG.
- Reranking candidates: BM25 top 20 per question (relevant chunks guaranteed to be included), in a deterministic
  shuffled order, identical for every reranker. The Cohere baseline runs in every session and is judged blind.
- Reranking methods:
  - **embedding models**: `ollama.embeddingReranking()`, or cosine with prefixes (option `embeddingImpl`);
  - **chat models**: `listwise` (one structured-output call returns the order) or `yesno` (option `llmMethod`: one
    1-token call per passage, score = P("yes") / (P("yes") + P("no")) from Ollama's log-probabilities);
  - **LLM rerankers** (models named `*reranker*` that aren't BERT, e.g. Qwen3-Reranker; capability `rerank-llm`):
    always `yesno`, with the Qwen3-Reranker prompt format.

  Log-probabilities come straight from Ollama's API (`logprobs`, `top_logprobs`): `ai-sdk-ollama` 4.6.3 doesn't
  expose them. Cases where every passage gets the same score, or where no "yes"/"no" appears among the top tokens,
  are flagged.

## Adding things

- **Language**: add an entry in `src/config/languages.ts`, then add `fixtures/<test>/cases/<code>.json`.
- **Test cases**: edit `fixtures/<test>/cases/*.json`. The suite version is a hash of the fixtures, so the history
  keeps old and new suites apart.
- **Test**: create `src/lib/tests/<id>/index.ts` implementing `TestDefinition` and register it in
  `src/lib/tests/registry.ts`.
- **Schema change**: edit `src/db/schema.ts`, then run `pnpm db:generate`.

Source documents used by the fixtures are in `.data/files/`.
