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
then smoke test), `bench:dry-run` (`pnpm bench --skip-existing --dry-run`), `dev` and `start`.

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

- **web-search** uses `ollama.tools.webSearch()` / `webFetch()`. They call Ollama's cloud API with `OLLAMA_API_KEY`
  (usage credits required); a preflight fails the run clearly when unavailable. Answers that change over time are
  checked against the npm registry / GitHub API at run time.
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
