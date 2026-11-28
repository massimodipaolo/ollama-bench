# ollama-bench — Plan

Benchmark the Ollama models on `OLLAMA_HOST` across several kinds of test. Compare 1–2 models per run. Three blind
judges (OpenAI, Google, Anthropic) score each run. Results are stored in a local SQLite database to build a history.

## Stack

| Concern | Choice |
|---|---|
| App | Next.js 16 (App Router) + TypeScript, pnpm |
| LLM | `ai` v7, `ai-sdk-ollama` (models under test + embeddings + embedding reranking), `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/anthropic` (judges), `@ai-sdk/cohere` (rerank baseline) |
| Schemas | zod v4 |
| DB | SQLite (`better-sqlite3`) + Drizzle ORM, at `.data/bench.db` |
| Vectors | embeddings stored as BLOBs in SQLite, cosine similarity in JS (benchmark-sized corpus) |
| Parsing | `unpdf` (text + page rasterizing), `mammoth` + `turndown` (DOCX), `papaparse` (CSV), `exceljs` (XLSX) |
| UI | Tailwind + shadcn/ui, Recharts |

## Core concepts

- **Test** = versioned suite of **cases** (`fixtures/<test>/…`). Each test declares `requires` (capabilities from
  Ollama `/api/tags`: completion, vision, tools, thinking, embedding), and the model picker filters on it.
- **Languages** are configurable: `src/config/languages.ts` (`en`, `it` to start). Cases live in
  `fixtures/<test>/cases/<lang>.json` and share case ids across languages. To add a language, add one entry and its
  case files. Judges are told the expected response language and penalize answers in the wrong one.
- **Scores (0–10)**: every judge returns `{ score, criteria[], rationale }`. The run shows **each judge's score and
  their average**, which is the headline number. **Automatic checks** (schema validity, recall@k, nDCG, tool-call
  correctness, …) are normalized to 0–10 and shown as a separate "auto" score. They are never blended into the
  judges' average.
- **Blind judging**: judges see anonymous candidates ("A", "B", "C") and never model or provider names. In
  comparisons, the order is randomized and recorded.
- **Baselines**: the Cohere reranker (`COHERE_MODEL`) is a model in the DB with `provider = 'cohere'`. In
  reranking/RAG tests it runs automatically next to the Ollama models and is judged blind like any other candidate,
  so it builds its own history.
- **Reproducibility**: each run stores temperature, seed, num_ctx, think on/off, the **model digest**, the Ollama
  version, the language, and the **suite version** (hash of fixtures + prompts + rubric). History is keyed by
  model + digest.
- **Fair timing**: Ollama calls run one at a time (single GPU). Each model is warmed up first, and load time is
  recorded apart from generation time. Metrics: time to first token, tokens/s (`eval_count/eval_duration`), total
  latency, reasoning tokens.
- **Judge cache**: judgments are reused by (output hash, judge model, rubric version).

## Test catalog

Source files: `.data/files/` (PDF form 1095-A, DOCX documentation guide, CSV of FFI entries, XLSX table, JPG infographic).
I draft the gold references, Q&A sets and relevance labels in `fixtures/`, and you review them.

| # | Test | Requires | Run | Automatic checks | Judges score |
|---|---|---|---|---|---|
| 1 | Text generation | completion | summarize, follow constrained instructions, reasoning, rewrite/translate (en/it), a medium Mermaid flowchart of a procedure | length/format limits, response language, Mermaid parses + graph structure | relevance, accuracy, instruction following, fluency |
| 2 | Structured output | completion | zod schemas that get harder (flat → nested → arrays/enums/unions) extracted from the sample docs | schema valid, per-field accuracy, retries | meaning of free-text fields |
| 3 | Image recognition | vision | JPG infographic + rasterized PDF pages: OCR, layout, Q&A, description | exact/numeric match on key facts | completeness, made-up details |
| 4 | Doc → Markdown | completion (+vision) | PDF/DOCX/CSV/XLSX → Markdown. Mode A: extracted text, model rebuilds the structure. Mode B: page image → vision model | similarity to gold .md, headings/tables kept, cell accuracy | fidelity, structure |
| 5 | Embeddings & retrieval | embedding | chunk the gold .md corpus → `embedMany` → labeled queries (en + it, so it also tests cross-language) | recall@k, MRR, nDCG@k, docs/s | relevance of the top-k chunks (blind) |
| 6 | Reranking | embedding or completion | fixed top-20 candidates per query → rerank with Ollama embedding reranking / Ollama listwise LLM / **Cohere baseline** | nDCG@5, MRR vs labels | quality of the top-5 ranking (blind, Cohere included) |
| 7 | RAG | completion + embedding | embedder → reranker (none / Ollama / Cohere) → answer with citations | right source cited, retrieval hit | faithfulness to sources, correctness, citations |
| 8 | Tool use | tools | mock tools (calculator, FFI/GIIN lookup on the CSV, date helper, multi-step chains) | right tools and order, valid arguments, steps, final answer | final answer quality |

## Data model

```
models        id, provider(ollama|cohere), name, digest, family, params, quant, capabilities, first_seen
runs          id, test_id, suite_version, lang, model_id, config_json, compare_group_id, status, started_at, finished_at, error
case_results  id, run_id, case_id, output, reasoning, latency_ms, ttft_ms, load_ms, tokens_in, tokens_out, tok_s, auto_score, checks_json, error
judgments     id, case_result_id, provider, judge_model, rubric_version, score, criteria_json, rationale, output_hash
run_scores    run_id, auto_score, judge_openai, judge_google, judge_anthropic, judge_avg   (cached aggregate)
```

## UI

- `/`: **By test** (leaderboard per test: OpenAI · Google · Anthropic · **Avg** · Auto · tok/s) or **By capability**
  (overview matrix, or one capability's tests per model), plus recent runs
- `/run`: **Single test** (test → language → 1–2 models → options) or **Capability** (capability → tests → language →
  1–2 models → batch) → live side-by-side progress (server-sent events)
- `/batches/[id]`: a capability batch, test × model grid
- `/models/compare?a=&b=`: two models (sharing an Ollama capability) side by side: polar charts by capability and by
  test (bars below 3 axes), a score table with differences, and both histories per test
- `/runs/[id]`: per-case outputs, checks, each judge's score and rationale, metrics
- `/models/[id]`: history across tests and digests, speed vs quality chart
- `/tests/[id]`: history of every model on that test

## Milestones

1. ✅ **Setup**: scaffold the app, env/providers, Ollama model discovery, DB schema and migrations, `.gitignore`
2. ✅ **One full test end to end**: text generation (8 cases, en + it) → judges → DB → run page with live progress → run detail
3. ✅ Structured output (6 cases, `native` / `prompt` mode) + tool use (7 cases, 5 mock tools over the FFI CSV and refund rules). Tests can declare options; each option combination gets its own leaderboard row
4. ✅ Image recognition (8 cases: OCR, layout and reading order, visual Q&A, a hallucination trap, an accessibility description) + Document → Markdown (5 cases: CSV, PDF, DOCX, XLSX, JPG). Files are sent as AI SDK file parts through the ported `file-part.ts` policy: images native, everything else as a `<file>` text part. Judges receive images and PDFs natively. Cases can require a capability (models without it skip the case). Sessions can be re-judged.
5. ✅ Embeddings & retrieval + Reranking (Cohere baseline) + RAG. Shared corpus (`fixtures/corpus/docs`, the reviewed reference Markdown; the 152-column XLSX is excluded) with Markdown-aware chunking (55 chunks), and 22 labeled questions in en + it (Italian over an English corpus = cross-lingual), shared by all three tests. Embeddings: timed index build, hit@1, hit@5, MRR, nDCG@10. Reranking: fixed shuffled BM25 pool of 20 candidates; embedding models score by cosine, chat models rerank listwise, Cohere joins as a blind baseline run. RAG: the generator is the model under test; retrieval (embedder + optional Cohere) is identical for all generators; checks cover key facts, citations, and an unanswerable question.
6. ✅ History, leaderboards, charts, CSV export: `/tests/[id]` (leaderboard per language, speed-vs-quality scatter, all runs), `/models` and `/models/[...name]` (one history chart per test/language/variant, digest in the tooltip, all runs), CSV export of runs or cases (`/api/export`), leaderboards prefer the latest judged run, and capability overrides (`src/config/model-overrides.ts`).
7. ✅ CLI batch runner (`pnpm bench`): every selected test × every compatible model (or a filtered set), as sessions run through the app's API, so the GPU lock, judges, history and live view are shared with the web UI. Grouped by model, `--skip-existing` per (digest, test, lang, variant, set, suite version), the Cohere baseline once per test/language, `--all-variants`, `--dry-run`, Markdown + JSON report in `.data/reports/`.

8. ✅ Follow-ups (2026-11-26):
   - Embedding reranking via `ollama.embeddingReranking()` (option: SDK vs cosine + prefixes).
   - Size tiers (< 10B / 10–50B / > 50B) in the UI and `--tier` in the CLI.
   - **web-search** test (`ollama.tools.webSearch/webFetch`; live references from npm/GitHub; preflight). Replaced
     2026-11-27 (v2) by a DuckDuckGo MCP server, since Ollama's web API needs paid credits.
   - **mcp** test (`@ai-sdk/mcp`, local stdio server with the tool-use tools + MCP Apps).
   - SDK versions recorded per session (UI, CSV, CLI skip-existing).
   - VS Code tasks to update the SDK packages.
   - Benchmark research in `docs/benchmark-research.md`.
9. ✅ Public benchmarks: **OmniDocBench** (42 English pages; text NED, table cell F1, formula NED + judges), **BFCL**
   (60 single-turn items; ported AST checker), **MMMU-Pro** (30 items, standard-10 / vision; accuracy). Pinned
   manifests in the repo; `pnpm datasets:fetch` downloads the data.
    First quick runs (2026-11-26, gemma4:e4b / qwen3.8:27b): OmniDocBench auto 8.2 / 9.4, judges 4.7 / 8.8; BFCL 3/5
    for both (both misses are BFCL label noise: the real Principia title isn't accepted, and a relevant function is labelled
    "irrelevance"); MMMU-Pro standard 0/5 / 2/5, vision 2/5 / 2/5 (qwen truncated at 4,096 tokens in 4 cases → CoT budget
    raised to 8,192, test v2). hyparquet pitfall: read binary columns with `utf8: false`, or image bytes get decoded as
    UTF-8 text.
10. ✅ Capabilities (2026-11-27): dashboard and run form switch between **By test** and **By capability**
    (Text, Vision, Tools, Retrieval; `src/config/capabilities.ts`). Capability leaderboards average the current-suite
    default-variant results; a model is ranked only with every test it can take (eligibility by Ollama capabilities,
    baselines never ranked). Capability **batches** (`batches` table, `sessions.batch_id`, `/batches/[id]`) run one
    session per test with the same 1–2 models. Also: sessions left queued/running by a stopped server are marked
    interrupted at startup (`src/instrumentation.ts`); a capped default `num_ctx` is no longer labelled as a variant
    (the label follows the requested value).
11. ✅ Mermaid generation (2026-11-27): text-generation v2 adds `mermaid-flowchart` (en + it, quick). The
    model turns a refund-status procedure into a `flowchart TD` with two named subgraphs, labelled decision diamonds, a
    retry loop and 12–25 nodes. The real Mermaid parser runs server-side
    (`src/lib/mermaid-check.ts`; DOMPurify gets pass-through functions because Node has no window; `mermaid` and
    `dompurify` are server externals). Checks: `mermaid` (one block, parses, flowchart, nothing else) and
    `mermaidGraph` (node / decision / subgraph / labelled-edge counts, a loop, required labels in nodes or edges,
    subgraph titles; partial credit). Judges cover fidelity, e.g. which steps sit in which subgraph. First run:
    gemma4:e4b valid (structure 10, judges about 5: its "Prepare" subgraph holds only one step); granite4.2:8b invalid
    (`::` suffixes, stray `end`; auto 0, judges 2.5–3).
12. ✅ Coding (2026-11-27). **Polyglot** (Aider's 225 exercises, 6 languages; Aider's prompts, 2 tries, test
    commands; whole-file edit format) in a no-network Docker sandbox built on this machine. `polyglot:verify` passes
    225/225 reference solutions after three harness fixes: Jest pinned to 29 (Jest 30 dropped `toThrowError`), C++
    folder naming, and Rust `Cargo-example.toml` for verify. **Terminal-Bench 2.1** (89 tasks, CLI only): AI SDK agent
    with a `bash` tool in each task's prebuilt image, then Harbor's verifier protocol. `tb:verify` gives 5/5 on the
    quick tasks. New Coding capability (polyglot + terminal-bench); `cliOnly` tests are excluded from plain
    `pnpm bench` and from the run form. First Polyglot quick: qwen3.8:27b 4/6 (3 on the second try), gemma4:e4b 0/6
    (genuine test failures).
    Follow-ups the first real runs exposed:
    - Polyglot v2–v4: Java feedback without `-q`; a path on the code block's first line names the file; framework
      stack frames dropped from retry feedback.
    - Terminal-Bench: stop after 8 identical commands ("stuck"); the docker helper always settles on timeout (a stalled
      `docker exec` on Windows blocked a whole task).
    - App servers register in `server_instances` and heartbeat every 20 s. Startup recovery only takes over sessions
      and containers of dead servers: a second dev server on :3000 had marked a live server's sessions as interrupted.
    - Confirmation runs (quick, qwen3.8:27b): Terminal-Bench 2/5 in 11 min (was 1/5 in 33 min); Polyglot v3 4/6.
    - Model memory (2026-11-27): models are unloaded as soon as no queued session needs them (`runner/residency.ts`;
      the CLI passes `keepLoaded` for its next same-model session; helper models via `TestDefinition.helperModels`).
      `/run` shows the host's loaded models with Unload. MoE tag from `/api/show` expert counts.
    - **Polyglot removed** (2026-11-27): too expensive to run (6 toolchains, ~5 GB image, long sessions). Code, image
      definition, manifest and `polyglot:verify` deleted; the docker helper moved to `src/lib/docker.ts`. Its 12 past
      sessions stay in the database; `isKnownTest` leaves them out of lists, leaderboards and charts. Coding is now
      Terminal-Bench only.
13. Next candidates: MCP-Atlas (no-key servers), IFEval/IFBench, RULER; a real TEDS for OmniDocBench tables.

## Local rerankers in Ollama (tested 2026-11-26, Ollama 0.40.18)

- **qllama/bge-reranker-v2-m3**: the GGUF is complete (cls head present), but Ollama can't run it. There's no rerank
  endpoint (`/api/rerank`, `/v1/rerank` → 404), embeddings are refused ("Start it with --embeddings", 501, on
  `/api/embed` and `/v1/embeddings`) because Ollama classifies the model as completion, and generation fails ("does
  not support logits computation"). It would need llama.cpp `llama-server --reranking` outside Ollama.
- **sam860/qwen3-reranker:0.6b-Q8_0**: runs, but is degenerate. Plain generation gives "333333…" and the next-token
  log-probabilities are flat (−11.93 = −ln(vocab) for every token), so yes/no can't be scored. The file has no
  separate output layer (only `output_norm`). It needs a different build of Qwen3-Reranker.
- ✅ Implemented as reranking method `yesno` (chat models, option `llmMethod`) and for decoder rerankers (capability
  `rerank-llm`, Qwen3-Reranker prompt format). `ai-sdk-ollama` 4.6.3 has no logprobs support, so it calls Ollama's API
  directly.
- **The yes/no log-probability method works in Ollama**: `/api/chat` with `logprobs: true, top_logprobs: N,
  num_predict: 1`. On granite4.2:3b, P(yes) was 0.956 for a relevant passage and 0.000 for an irrelevant one, about
  37 ms per passage. This allows pointwise LLM reranking with any chat model, and with any Qwen3-Reranker build whose
  output head works.

## Library findings (ai-sdk-ollama 4.6.3 / ai 7.0.183)

- `ollama.embeddingReranking()` embeds raw text: it doesn't apply a model's documented task prompts. embeddinggemma
  scored 8.4 through the SDK vs 9.1 with its `task: search result | query:` prompts (reranking, EN quick).
- README vs types: `ollama.tools.webSearch({ maxResults })` isn't a factory option. `maxResults` is a tool argument
  the model picks (1–10, default 5).
- `webFetch` doesn't throw on failure: it returns `{ content: "", error }`, so a model silently sees an empty page.
  `webSearch` throws.
- Web search/fetch always call `https://ollama.com/api/web_search|web_fetch` with `OLLAMA_API_KEY`, whatever
  `baseURL` is. They need ollama.com usage credits (the current key has none: "Add usage credits"). The web-search
  test no longer uses them (DuckDuckGo MCP server since v2).
- Native structured output isn't enforced for gpt-oss:20b (returned `{"order": …}` instead of `{"ranking": …}`).
- Non-image file parts are dropped silently (Ollama accepts only images); see `src/lib/files/file-part.ts`.

## Notes

- 2026-11-26: `gemini-4-carbon` was temporarily unresponsive (every request hung, even without parameters) and then
  recovered by itself. If a judge's API stalls, its calls time out after 120 s (one retry). The case is recorded as an
  error for that judge, and the other judges still score.
- **Judge calibration (2026-11-26)**: with an image attached, Gemini (`gemini-4-carbon` and `-hydrogen`) scores
  flawless answers a flat 7. It cites cosmetic issues such as "1" vs "1.", while its rationale says there are no
  errors. Without the image it gives 10. This happens with and without structured output, and even when the judge
  prompt explicitly says cosmetic differences aren't errors. Rankings remain fair (same judge for every model), but
  Google's column runs about 1–2 points lower on image tests. Decision pending: keep it, don't attach images for
  Google, or use a different Google judge for vision.
  Experiment (2026-11-26, `gemini-4-hydrogen`, `scripts/judge-image-experiment.mts`): one known-good answer judged
  4× per variant. Any attached image gives a flat 7 (every criterion 7, comments all positive). Converting to PNG,
  upscaling 2×, putting the image before the text, `mediaResolution: HIGH` and `thinkingLevel: high` all still give
  7. Without the image it gives 10 (8/8). OmniDocBench page images are not affected. Across the database, a
  mid-scale "flat" verdict (all criteria equal, between 3 and 9) occurs only for Google on image-recognition (12/25).
  The other judges' flat verdicts are all at the extremes (0–2, 9.8).
  **Decision: fall back to judging without the image.** A mid-scale flat verdict on a case with attachments is
  re-asked without the files (`judgments.without_attachments`, "(no file)" badge). The 12 stored flat verdicts were
  repaired, each with its original model: 8 used the fallback (all 10, in line with the other judges), and 4 came
  back non-flat with the image. Google's image-recognition average rose from 7.40 to 8.76 (carbon) and from 8.0 to
  10 (hydrogen, 3 verdicts).
- Judge prompt v3: rationale → criteria → score (reasoning before numbers), plus explicit anchors. `JUDGE_VERSION` is
  part of the judgment cache key.
- **Thinking models that ignore `think: false`** (2026-11-26, Ollama 0.40.18): qwen3-vl:8b still returns hidden
  reasoning. On long outputs it can spend the entire output budget there and return an empty answer. Those cases
  are now marked "empty answer: the whole output budget went to reasoning", and judges skip them.
- **gpt-oss:20b and native structured output**: the JSON schema is not always enforced. It returned `{"order": […]}`
  instead of `{"ranking": […]}`. The reranking check "valid ranking ids" flags it.
- **Cohere trial keys** allow 10 calls/minute. Calls are paced by `COHERE_RPM` (default 10); the wait is excluded
  from latency.
- **Dev reload loop (fixed)**: Tailwind's default source root (the project) made `.data/bench.db-shm` a CSS
  dependency. SQLite touches it even on reads, so every page view recompiled the CSS, which triggered a refresh,
  which read the database again. The resulting endless loop froze the browser. Tailwind now scans only `src/`
  (`@import "tailwindcss" source("..")`).
- **num_ctx (2026-11-26)**: the host default is 65536 (`OLLAMA_CONTEXT_LENGTH`, a default, not a limit). The
  benchmark always sends `num_ctx` explicitly, capped at the model's maximum. A non-default value is its own variant
  (`num_ctx=<n>` in the leaderboard and in the `--skip-existing` key). Run form: max ctx per model, cap warning,
  "Detect host default" (`/api/models/host-context`). CLI: `--num-ctx`.
- Warm-up runs a real 1-token chat, not just a load. Without it, the first case after a model load showed 10–16 s
  to first token.

- `OLLAMA_HOST` has no scheme or port. It is normalized to `http://<host>:11434`, and `OLLAMA_API_KEY` is sent as a Bearer token.
- Thinking models: think is on/off per run. Reasoning is stored separately, and judges see only the final answer.
- Large models (65B/120B) are slow: each test has a `quick` subset (~5 cases) and a `full` set.
- Judges may favor answers in their own model family's style. The per-judge columns make this visible.
