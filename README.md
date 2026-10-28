# CodeRAG — codebase Q&A for developer onboarding

Ask questions about a Git repository and get cited answers. The repo is parsed with **Tree-sitter** into functions, classes, and methods. Those chunks are embedded and indexed in **Redis (RediSearch)** for hybrid **BM25 + HNSW** search, fused with **Reciprocal Rank Fusion**, and reranked by an LLM. A **multi-hop agent** (Groq primary, Gemini fallback) then answers with clickable file:line citations. Syncs re-index only what a **git diff** says changed.

```
frontend/  React 19 + TypeScript + Tailwind v4 (Vite) → Netlify
backend/   Node 22 + Express 5 + TypeScript              → Render
legacy/    the previous PDF-RAG prototype (kept for reference, not used)
```

## Architecture

```
                   ┌───────────── ingestion (job queue in MongoDB) ─────────────┐
 git clone/fetch → │ git diff --name-status -M  +  git diff -U0 (hunks)          │
 (blobless)        │   → changed files only → Tree-sitter AST → semantic chunks  │
                   │   → content-hash compare → embed only new/changed chunks    │
                   │   → HSET into Redis (TEXT fields + FLOAT32 HNSW vector)     │
                   │   → Mongo: files, chunk metadata, commit/diff records       │
                   └─────────────────────────────────────────────────────────────┘
 question → planner (Groq fast, JSON) → sub-queries
          → per sub-query: [ BM25 (FT.SEARCH) ‖ KNN (HNSW cosine) ] → RRF (k=60) → LLM rerank
          → call-graph hop (resolve called-but-undefined symbols by exact name)
          → evaluator: "is evidence sufficient?" → follow-up queries (≤ AGENT_MAX_HOPS)
          → synthesis (Groq reasoning model, streamed over SSE, [n] citations)
 every LLM call → LLMRouter: circuit breaker per provider; fallback to Gemini on 429 / 5xx /
                  timeout / context overflow / invalid JSON; Gemini walks a model chain
```

### Key pieces

| Concern | Where | Notes |
|---|---|---|
| Env validation | `backend/src/config/env.ts` | zod; the process exits with a list of every invalid variable |
| AST chunking | `backend/src/ingestion/astChunker.ts`, `languages.ts` | JS/TS/TSX, Python, C/C++, Java, Go, Rust, C#, Ruby, PHP, Bash via `web-tree-sitter` + `@vscode/tree-sitter-wasm` (no native builds). Small classes stay whole; large ones become a skeleton chunk plus member chunks; oversized functions split on statement boundaries; leading comments and docstrings are attached; each file also gets an outline chunk |
| Other files | `textChunker.ts` | Markdown split by heading breadcrumb; line windows for languages without a grammar; `fixed` naive strategy kept as a benchmark baseline |
| Incremental indexing | `indexer.ts`, `git.ts` | Stable chunk ids (`repo/path/kind/symbol/ordinal`). Unchanged chunks whose lines shifted only get line updates. Diff hunks are mapped to touched chunk ids and stored per commit. Embeddings are cached by the hash of the embedded text, so reverted edits, forced re-indexes, and runs resumed after a failure skip the API. A renamed file is re-embedded, because its path is part of the embedded text |
| Hybrid search | `search/hybrid.ts`, `queryBuilder.ts`, `rrf.ts` | BM25STD over name/symbol/signature/doc/content plus split-identifier `tokens`; KNN with `EF_RUNTIME`; both run concurrently |
| Reranking | `search/rerank.ts` | Listwise LLM judge (cross-encoder style); falls back to RRF order on failure |
| Agent | `agent/agent.ts` | plan → retrieve → call-graph expand → evaluate/hop → synthesize; every step streamed |
| LLM resilience | `llm/router.ts`, `lib/circuitBreaker.ts`, `lib/http.ts` | Breakers honour `Retry-After`; streams have header and idle timeouts; fallback only before the first token |
| Benchmarks | `benchmark/*` | hit@1/3/5/10, MRR, recall@k, latency for `bm25`, `vector`, `hybrid`, `hybrid_rerank`; expected symbols are resolved to line ranges so `fixed` chunk indexes are scored fairly |

## Run locally

Prerequisites: Node 22+, git, MongoDB (local or Atlas), and a RediSearch-capable Redis.

```bash
docker compose up -d redis
```

```bash
npm run install:all
```

```bash
cp backend/.env.example backend/.env
```

Fill in `GROQ_API_KEY` and `GEMINI_API_KEY` in `backend/.env`, then start both servers (two terminals):

```bash
npm run dev:backend
```

```bash
npm run dev:frontend
```

Open http://localhost:5173, go to **Repositories**, add e.g. `https://github.com/psf/requests`, and ask away once it's `ready`.

> **Redis must support RediSearch.** Redis 8+ (the compose file), Redis Stack, or Redis Cloud all work. Upstash and plain Redis OSS 7 do not support `FT.*` commands, and the server refuses to start against them.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Mongo/Redis status, index size, circuit-breaker states, models |
| GET/POST | `/api/repos` | list / register a repo (`{url, branch?, chunking: "ast"\|"fixed"}`) and queue a full index |
| GET/DELETE | `/api/repos/:id` | details + recent jobs/commits / purge everything |
| POST | `/api/repos/:id/sync` | incremental git-diff sync (`{full: true}` re-chunks everything) |
| GET | `/api/repos/:id/tree`, `/file?path=`, `/commits`, `/commits/:sha`, `/chunks/:chunkId` | file browser, previews, diff history |
| POST | `/api/query/stream` | SSE: `step`, `sources`, `token`, `done` \| `error` |
| POST | `/api/query` | same agent, one JSON response |
| POST | `/api/search` | retrieval inspection: BM25 list, vector list, RRF, rerank, timings |
| GET/POST | `/api/benchmarks` | list / run a benchmark (`{repoId, dataset, modes?, k?}`) |
| GET | `/api/benchmarks/samples` | bundled ground-truth datasets |
| POST | `/api/webhooks/github` | push webhook → incremental sync (needs `GITHUB_WEBHOOK_SECRET`) |

When `ADMIN_API_KEY` is set, mutating endpoints require the `x-api-key` header; enter it in the UI under **Settings**.

## Benchmarks

The benchmark measures **retrieval** quality: does a chunk from the expected file/symbol appear in the top-k? Accuracy is reported as **hit@5**. A dataset looks like this:

```json
[{ "question": "Where is the session token validated?", "expected": [{ "path": "src/auth/middleware.ts", "symbol": "verifySession" }] }]
```

Run it from the UI (**Benchmarks**) or from the CLI:

```bash
npm --prefix backend run bench -- --repo <repoId> --file benchmarks/requests.sample.json
```

`backend/benchmarks/requests.sample.json` has 25 questions for `psf/requests`. To compare chunking strategies, register the same repo twice (`ast` and `fixed`) and run the same dataset against both. Build your own 50-question set for your repo to get numbers you can quote.

## Deploy

**Backend → Render.** Create a Blueprint from `render.yaml`, then set `MONGODB_URI` (Atlas), `REDIS_URL` (Redis Cloud), `GROQ_API_KEY`, `GEMINI_API_KEY`, and `CORS_ORIGINS` (your Netlify URL). Render generates `ADMIN_API_KEY`; copy it into the frontend Settings dialog. Clones live on ephemeral disk and are re-created on the next sync after a restart. Free instances sleep, so the first request after idle is slow.

**Frontend → Netlify.** Connect the repo; `netlify.toml` builds `frontend/`. Set `VITE_API_URL=https://<your-render-service>.onrender.com`.

**Free-tier limits to know:**
- Gemini embeddings: ~30k tokens/min. Indexing is paced by `EMBEDDING_TPM`/`EMBEDDING_RPM`, so a ~600 KB repo takes several minutes. Raise both on a paid key.
- Redis Cloud free (30 MB) holds roughly 1,500–2,000 chunks at 768 dims (measured: psf/requests' 746 chunks used ~11 MB, about 15 KB per chunk including text and the full-text index). Lower `EMBEDDING_DIM` or upgrade for larger repos.
- Run the API in the same region as Redis Cloud and Atlas: against a distant Redis, BM25 took 319 ms instead of 35 ms locally.

## Tests

```bash
npm test
```

There are 26 unit tests: the chunker across 6 grammars, RRF math, BM25 query building and tag escaping, the circuit breaker, failure classification, diff parsing, benchmark metrics, and call-graph extraction.
