# Ollama Benchmark

Benchmark Ollama models through a set of tests. You can compare two models side by side. Blind judges from OpenAI,
Google and Anthropic score each run, and every result is stored in a local SQLite history. See [PLAN.md](PLAN.md) for
the design and roadmap.

## Setup

```bash
pnpm install
pnpm smoke   # checks Ollama + each judge with one tiny call
pnpm dev     # http://localhost:3000
```

`.env` (never committed):

| Var | Purpose |
|---|---|
| `OLLAMA_HOST` | `host`, `host:port` or a full URL (port defaults to 11434) |
| `OLLAMA_API_KEY` | optional; sent as a Bearer token |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | OpenAI judge |
| `GOOGLE_GENERATIVE_AI_API_KEY` / `GOOGLE_MODEL` | Google judge |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | Anthropic judge |
| `COHERE_API_KEY` / `COHERE_MODEL` | reranking baseline (RAG / rerank tests) |
| `COHERE_RPM` | optional; Cohere calls per minute (default 10, the trial-key limit) |

A judge without a key and a model is skipped. The DB lives at `~/.ollama-benchmark/bench.db` (override with `BENCH_DB_PATH`), outside the project so the dev server's file watcher never sees its writes. Migrations in `drizzle/` are applied
automatically when the DB opens.

## How a run works

1. Choose a test, a language and 1–2 models. The list only shows models whose Ollama capabilities match the test.
2. Models run **one at a time**: each model is warmed up first (load time is reported separately), then every case
   is streamed. Metrics: latency, time to first token, tokens/s (from Ollama's `eval_duration`), reasoning tokens.
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

- **By test:** one leaderboard per test, or one test per run (as before).
- **By capability:** tests grouped by what they measure (`src/config/capabilities.ts`; a test can be in several).

| Capability | Tests |
|---|---|
| Text | text-generation, structured-output, doc-to-markdown, rag |
| Vision | image-recognition, omnidocbench, mmmu-pro |
| Tools | tool-use, bfcl, mcp, web-search |
| Retrieval | embeddings, reranking, rag |

**Capability leaderboard** (`/?view=capability&cap=vision&lang=en`):

- A model's capability score is the mean of its scores on the capability's tests. Each test score is the one its
  leaderboard shows (latest judged run, otherwise the automatic score), for the default test options and default
  `num_ctx`, in the chosen language.
- Only results from each test's **current suite version** count. Older ones are shown struck out.
- A model is **ranked** only with a current result on every test it can take, by its Ollama capabilities. An embedding
  model can't run RAG, and a chat model can't run the embeddings test. Tests that nobody has run yet (e.g. web search
  without credits) are not required. Partial rows are shown in brackets. Remote baselines (Cohere) are shown for
  reference and never ranked.
- **Overview** shows a model × capability matrix. Each score cell links to its session.

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

**Run benchmarks from one server at a time.** The GPU lock that keeps sessions sequential lives inside each server
process. Two servers running sessions at once both load models on the Ollama host, which skews timings and can
exhaust its memory. The top of `/run` lists sessions from every server.

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

## Coding tests (Polyglot, Terminal-Bench)

Both need **Docker** on the machine that runs the app (here: Docker Desktop, x86_64). Models stay on the Ollama host,
and code only ever runs in containers.

**Polyglot** (`polyglot`, Coding capability): [Aider's polyglot benchmark](https://github.com/Aider-AI/polyglot-benchmark),
225 hard Exercism exercises in C++, Go, Java, JavaScript, Python and Rust (quick: one per language).

```bash
pnpm datasets:fetch polyglot     # repo at the pinned commit + builds the sandbox image (~5 GB, a few minutes)
pnpm polyglot:verify             # optional: every reference solution must pass (225/225, ~11 min)
```

- **Protocol (as Aider's harness):** the prompt is the exercise instructions plus Aider's addendum. The model sees and
  edits only the solution files. The unit tests stay hidden, run with Aider's per-language commands and a 3-minute
  timeout. On failure, the model gets the test output and one more try. **Score = pass rate after 2 tries**
  (`pass_rate_2`); the session shows each try with its test output.
- **Difference from Aider:** answers use a whole-file format (the model returns each changed file in full), not Aider's
  diff formats. The parser accepts the path on the line above the code block or as the block's first line (some
  models do the latter). Test output for the retry is capped at 12k characters (Aider passes it uncapped).
  JUnit/Gradle/JDK stack frames are dropped first, so failing tests and their messages survive the cap.
- **Sandbox:** image `ollama-bench-polyglot:<hash>` (`docker/polyglot/Dockerfile`). Tests run with **no network**,
  6 GB / 4 CPUs / 1,024 processes, no host mounts. Gradle, Cargo and npm dependencies are baked in at build time.
- **Fixes found by `polyglot:verify`:** Jest pinned to 29.7 (Aider installs it unpinned, and Jest 30 removed
  `toThrowError`, failing correct JavaScript answers). C++ exercises must sit in a folder with the exercise's own name.
  Rust reference solutions with extra crates use `.meta/Cargo-example.toml`; models still get the plain `Cargo.toml`.

**Terminal-Bench 2.1** (`terminal-bench`, CLI only): [89 agentic tasks](https://github.com/harbor-framework/terminal-bench-2-1)
(software engineering, debugging, security, data, sysadmin…) in each task's own container. Quick: the 4 easy tasks plus
the medium task with the shortest time limit.

```bash
pnpm datasets:fetch terminal-bench [--pull]       # tasks at the pinned commit (+ pre-pull the quick images)
pnpm tb:verify                                    # optional: reference solve.sh + verifier must give reward 1
pnpm bench --tests terminal-bench --models qwen3.8:27b --judges none
```

- **Agent:** our AI SDK loop with one `bash` tool that runs inside the task container (up to 80 steps, within the task's
  own time limit). Command output is clipped to its start and end.
- **Verifier (Harbor's protocol):** `tests/` copied to `/tests`, then `bash /tests/test.sh`. The reward comes from
  `/logs/verifier/reward.txt`, and the verifier also runs after an agent timeout. **Score = share of tasks with reward 1.**
- **Hours per model** (task time limits sum to 42 hours for the full set), so it's started only from the CLI. A plain
  `pnpm bench` skips it, and the run form shows it as "CLI only". Results and transcripts appear in the app like any
  session. Images are pulled on first use (tens of GB for all 89).
- **Not comparable 1:1 with the [leaderboard](https://www.tbench.ai/leaderboard/terminal-bench/2.1)**, which uses the
  Terminus 2 agent (tmux) and 5 trials per task. Tasks have internet access, as upstream.

## Mermaid diagrams

Text generation includes `mermaid-flowchart` (en + it): turn a refund-status procedure into a medium-size Mermaid
flowchart. It needs two named subgraphs, labelled decision diamonds, a retry loop and 12–25 nodes, returned as a
single code block. Answers are checked with **the real Mermaid parser**, server-side (`src/lib/mermaid-check.ts`):

- `{ "type": "mermaid", "diagram": "flowchart", "onlyBlock": true }`: exactly one ```` ```mermaid ```` block that
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

| Media type | Sent as |
|---|---|
| `image/*` | native image part |
| text formats (CSV, JSON, XML, MD…) | `<file name type>` text part, decoded as UTF-8 (falls back to Windows-1252) |
| XLSX | text part with one CSV per sheet (no blank rows or trailing empty cells, merged cells once) |
| DOCX / PDF | text part with the extracted text (mammoth / unpdf) |
| audio / video | unsupported |

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
pnpm bench --help
```

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
+ smoke) and "AI SDK: update + verify". Then "Bench: re-run after SDK update" (`pnpm bench --skip-existing`) re-runs
every combination whose last run used other `ai` / `ai-sdk-ollama` versions. Every session records the installed
versions of `ai`, `@ai-sdk/*`, `ai-sdk-ollama` and the `ollama` JS client (session header, run tables, CSV), so score
changes can be traced to a library update. `.vscode/launch.json` (Run and Debug) has `ai-sdk:update` (update packages,
then smoke test), `bench:dry-run` (`pnpm bench --skip-existing --dry-run`), `dev`, `start`, and `bench:quick`. The
last one builds and starts the production server on :3000 (task "App: build + start (production)", left running in
its terminal), then runs `pnpm bench --subset quick --lang en --judges openai --skip-existing`. Stop any other app
server first: :3000 must be free, and benchmarks must run from one server at a time.

## Public benchmarks (OmniDocBench, BFCL, MMMU-Pro)

The repo holds only pinned manifests (`fixtures/<test>/manifest.json`: dataset revision + selected item ids). Download
the data once (into `.data/datasets/`, git-ignored):

```bash
pnpm datasets:fetch                 # all three (~180 MB on disk; ~200 MB transferred)
pnpm datasets:fetch bfcl            # just one
pnpm datasets:fetch --select        # maintainer: re-select the subsets and rewrite the manifests
```

| Test | Subset | Scoring | Judges |
|---|---|---|---|
| `omnidocbench` | 42 English pages, 6 per document type (quick 5) | text similarity (1 − NED), table cell F1 (TEDS not ported), formula similarity (CDM not ported) | yes (they see the page) |
| `bfcl` | 60 single-turn items: simple, multiple, parallel, parallel-multiple, irrelevance (quick 5) | ported BFCL AST checker, accuracy | no (deterministic) |
| `mmmu-pro` | 30 items, one per subject (quick 5); option `config`: standard (10 options) / vision; `prompt`: cot / direct | answer letter, accuracy (an unparseable answer counts as wrong instead of the official random guess) | no (deterministic) |

Licences: **OmniDocBench is research use only / non-commercial**, so its data is downloaded, never committed. BFCL and
MMMU-Pro are Apache-2.0. MMMU-Pro is read from the dataset's Parquet files with HTTP range requests and the page index
(hyparquet), so only the pages holding the selected rows are downloaded.

## Web search and MCP tests

- **web-search** (v2) gives the model a **DuckDuckGo MCP server**: tools `search` and `fetch_content`, from Docker's
  `mcp/duckduckgo` image, connected with `@ai-sdk/mcp` over stdio. It replaced ai-sdk-ollama's `webSearch`/`webFetch`,
  which call Ollama's cloud API and need paid credits. Answers that change over time are checked against the npm
  registry / GitHub API at run time.
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
