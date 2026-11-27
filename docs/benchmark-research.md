# Popular benchmarks: what fits this app

Research notes from 2026-11-26, compiled from web sources linked below. Licenses, dataset revisions and dates should
be re-checked on the linked pages before importing anything.

## Constraints that shape the choice

- **Hardware:** a DGX Spark (GB10) is **ARM64**. Most prebuilt evaluation Docker images (SWE-bench, DeepSWE/Harbor)
  are x86 only, so Docker-based harnesses mean building arm64 images locally.
- **Run time:** one model on one test should take minutes. Coding-agent benchmarks take 5–20 minutes per task.
- **Licensing:** commit only task IDs, our adapters and a pinned Hugging Face revision, then download data at
  runtime. Never commit gated sets (GPQA, DeepSWE) or research-only sets (OmniDocBench).

## The benchmarks you named

| Benchmark | What it is | Fit for this app |
|---|---|---|
| **SWE-bench** (Lite 300, Verified 500, [Verified-mini 50](https://hal.cs.princeton.edu/swebench_verified_mini)) | Fix real GitHub issues; scored by unit tests in per-task Docker | **Poor.** Docker + arm64 builds (100 GB+ disk), 5–20 minutes per task, models of 30B and below score near 0. OpenAI [stopped reporting Verified](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/) (flawed tests, contamination). |
| **DeepSWE** | Two things share the name: an RL-trained Qwen3-32B coding *agent* (Agentica/Together), and a 2026 Datacurve *benchmark* ([paper](https://arxiv.org/abs/2607.07946)) of 113 long-horizon tasks | **Skip.** The dataset is gated "held-out evaluation data" ([HF](https://huggingface.co/datasets/datacurve/deep-swe)), Epoch [rates it flawed](https://epoch.ai/benchmarks/deepswe/review), and tasks need x86 multi-language toolchains. |
| **MCP-Atlas** (Scale AI, [paper](https://arxiv.org/abs/2602.00933)) | 1,000 tasks, 36 real MCP servers, 3–6 tool calls each among distractor tools; scored by judge claim coverage. **500 public tasks, CC-BY-4.0** ([HF](https://huggingface.co/datasets/ScaleAI/MCP-Atlas)) | **Good.** Use tasks whose servers need no API key (20 of 36), connected through our `@ai-sdk/mcp` client. Our 3 judges can score the claims. |
| **DeepSearchQA** (Google DeepMind, [HF](https://huggingface.co/datasets/google/deepsearchqa), Apache-2.0) | 900 web research prompts, mostly set-valued answers, scored by an autorater | **Medium.** Needs live web search (our web-search test, now on a DuckDuckGo MCP server). Answers drift over time, and the official judge is Gemini. **BrowseComp-Plus** (below) is the reproducible offline alternative. |
| **MMMU-Pro** ([HF](https://huggingface.co/datasets/MMMU/MMMU_Pro), Apache-2.0) | Multimodal multiple choice, 10 options, plus a "vision" config where the question is embedded in a screenshot | **Very good.** Deterministic letter match, no infrastructure. Fits the image-recognition test type. |
| **OmniDocBench** (CVPR 2025, [repo](https://github.com/opendatalab/OmniDocBench)) | 1,651 PDF pages, 10 document types → Markdown; scored by edit distance, TEDS (tables) and CDM (formulas) | **Very good, with a licence caveat.** It is exactly the Document → Markdown use case. The data is **research-only, not for commercial use**, so download at runtime and never commit it. Edit distance is trivial; TEDS needs a tree edit distance (port or Python sidecar); skip CDM (needs TeX) and let judges handle formulas. |

## Other benchmarks worth adding

| Benchmark | Why | Scoring | Effort |
|---|---|---|---|
| **[BFCL v4](https://github.com/ShishirPatil/gorilla/tree/main/berkeley-function-call-leaderboard)** (Apache-2.0) | The standard for function calling; directly tests Ollama tool templates (simple, multiple, parallel, irrelevance) | Deterministic match of the call's structure (AST) | S |
| **IFEval / [IFBench](https://huggingface.co/datasets/allenai/IFBench_test)** | Instruction following with programmatically verifiable constraints; IFBench isn't saturated | Deterministic verifiers | S |
| **RULER** (NVIDIA, Apache-2.0) | Long context at 8K–64K, generated so there's no contamination; catches `num_ctx` truncation, which matters for RAG | Deterministic | S–M |
| **[τ²-bench](https://github.com/sierra-research/tau2-bench)** (MIT) | Realistic agent with policies and a database (retail, airline) | Deterministic database/action check; needs an LLM user simulator | M |
| **[BrowseComp-Plus](https://huggingface.co/datasets/Tevatron/browsecomp-plus)** (MIT) | Agentic search over a **fixed offline corpus**; reuses our embedder and reranker | Judge + retrieval metrics | M |
| **[MCPMark](https://github.com/eval-sys/mcpmark)** (Apache-2.0) | MCP tasks with deterministic `verify.py`; Filesystem and Postgres environments run locally | Deterministic | M |
| **[MCP-Bench](https://github.com/Accenture/mcp-bench)** (Apache-2.0) | Already has scores for small local models (gpt-oss-20b 0.65, qwen3-30b-a3b 0.63) | Judge | M |
| MMLU-Pro / GPQA Diamond | Broad knowledge and reasoning; contaminated at the top; GPQA is gated (keep it out of the repo) | Deterministic | S |
| HumanEval+ / LiveCodeBench | A cheaper coding signal than SWE-bench | Unit tests in a sandbox | M |

## How each would map onto this app

The app's test framework already has most of the pieces: cases with deterministic checks, three blind judges,
tools and MCP, file and image inputs, `prepare()`/`cleanup()` hooks, options, and per-session SDK versions.

| Priority | Benchmark | Becomes | What's new |
|---|---|---|---|
| P0 | **OmniDocBench** (quick 5 / full 40 pages, runtime download) | Variant of **Document → Markdown** (page image → Markdown) | Downloader + pinned revision; normalized edit distance; TEDS for tables |
| P0 | **BFCL** single-turn (quick 5 / full 60) | Variant of **tool use**: their tool schemas, our native and MCP paths | Structure-based (AST) argument matcher |
| P0 | **MMMU-Pro** 10-option + vision (quick 5 / full 50) | Variant of **image recognition** | Letter-extraction check; runtime download |
| P1 | **MCP-Atlas** no-key subset (quick 5 / full 30) | Variant of the **MCP** test with real servers | Server launcher (Docker or npx), per-claim judge rubric |
| P1 | **IFEval / IFBench** (quick 5 / full 60) | Variant of **text generation** | Port of the verifier functions |
| P1 | **RULER** (8K / 32K / 64K) | New *long-context* test | Generator (no data to download) |
| P2 | BrowseComp-Plus, τ²-bench, MCPMark | Agentic search / agent tests | Corpus indexing, user simulator, verifiers |
| Skip | SWE-bench, DeepSWE | Not worth it on this hardware and at these model sizes | |

Practices for every imported benchmark:
- Report the benchmark's **own metric** next to our 3-judge score; changing the judge shifts judged benchmarks.
- Keep imported suites as separate test variants with their own suite version, so their history doesn't mix with
  the hand-written cases.
