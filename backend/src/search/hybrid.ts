import { env } from "../config/env.js";
import { redis } from "../db/redis.js";
import type { ChunkKind } from "../db/models.js";
import { embedQuery, vectorToBuffer } from "../embeddings/embedder.js";
import { errorMessage, isAbortError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import type { LLMCallRecord } from "../llm/types.js";
import { buildTextQuery, filterClause, type SearchFilters } from "./queryBuilder.js";
import { HIT_FIELDS, bm25Scorer, escapeTag, idFromKey, keyFor } from "./redisIndex.js";
import { rerankWithLlm } from "./rerank.js";
import { reciprocalRankFusion } from "./rrf.js";

export type SearchMode = "hybrid" | "bm25" | "vector";

export interface ChunkHit {
  id: string;
  repoId: string;
  path: string;
  language: string;
  kind: ChunkKind;
  name: string;
  symbolPath: string;
  parentScope: string;
  signature: string;
  docstring: string;
  content: string;
  startLine: number;
  endLine: number;
}

export interface ScoredHit {
  chunk: ChunkHit;
  rank: number;
  bm25Rank?: number;
  bm25Score?: number;
  vectorRank?: number;
  vectorScore?: number;
  rrfScore: number;
  rrfRank: number;
  rerankScore?: number;
}

export interface SearchOptions {
  repoId: string;
  query: string;
  k?: number;
  mode?: SearchMode;
  rerank?: boolean;
  candidates?: number;
  filters?: SearchFilters;
  signal?: AbortSignal;
  trace?: LLMCallRecord[];
}

export interface SearchResponse {
  query: string;
  mode: SearchMode;
  results: ScoredHit[];
  bm25: Array<{ id: string; score: number }>;
  vector: Array<{ id: string; score: number }>;
  reranked: boolean;
  rerankError?: string;
  /** Set when a retriever failed and results come from the remaining one. */
  degraded?: string;
  timings: Record<string, number>;
}

interface ListHit {
  id: string;
  score: number;
}

const str = (v: unknown) => (Buffer.isBuffer(v) ? v.toString("utf8") : String(v ?? ""));

async function bm25Search(repoId: string, query: string, n: number, filters?: SearchFilters): Promise<ListHit[]> {
  const q = buildTextQuery(repoId, query, filters);
  if (!q) return [];
  const reply = (await redis.sendCommand([
    "FT.SEARCH", env.REDIS_INDEX_NAME, q,
    "NOCONTENT", "WITHSCORES", "SCORER", bm25Scorer,
    "LIMIT", "0", String(n),
    "DIALECT", "2",
  ])) as unknown[];
  const out: ListHit[] = [];
  for (let i = 1; i + 1 < reply.length; i += 2) out.push({ id: idFromKey(str(reply[i])), score: Number(str(reply[i + 1])) });
  return out;
}

async function vectorSearch(repoId: string, vector: Float32Array, n: number, filters?: SearchFilters): Promise<ListHit[]> {
  const q = `(${filterClause(repoId, filters)})=>[KNN ${n} @embedding $vec EF_RUNTIME ${Math.max(n * 2, 64)} AS vdist]`;
  const reply = (await redis.sendCommand([
    "FT.SEARCH", env.REDIS_INDEX_NAME, q,
    "PARAMS", "2", "vec", vectorToBuffer(vector),
    "SORTBY", "vdist", "ASC",
    "RETURN", "1", "vdist",
    "LIMIT", "0", String(n),
    "DIALECT", "2",
  ])) as unknown[];
  const out: ListHit[] = [];
  for (let i = 1; i + 1 < reply.length; i += 2) {
    const fields = reply[i + 1] as unknown[];
    const dist = Number(str(fields[1]));
    // cosine distance in [0, 2] → similarity in [-1, 1]
    out.push({ id: idFromKey(str(reply[i])), score: 1 - dist });
  }
  return out;
}

export async function hydrate(ids: string[]): Promise<Map<string, ChunkHit>> {
  const rows = await Promise.all(ids.map((id) => redis.hmGet(keyFor(id), [...HIT_FIELDS])));
  const map = new Map<string, ChunkHit>();
  rows.forEach((row, i) => {
    const id = ids[i] as string;
    const [repo, path, language, kind, name, symbol, parentScope, signature, docstring, content, startLine, endLine] = row.map((v) => (v == null ? undefined : str(v)));
    if (!repo || !path) return; // deleted between search and hydrate
    map.set(id, {
      id,
      repoId: repo,
      path,
      language: language ?? "",
      kind: (kind ?? "block") as ChunkKind,
      name: name ?? "",
      symbolPath: symbol ?? "",
      parentScope: parentScope ?? "",
      signature: signature ?? "",
      docstring: docstring ?? "",
      content: content ?? "",
      startLine: Number(startLine ?? 0),
      endLine: Number(endLine ?? 0),
    });
  });
  return map;
}

/**
 * Hybrid retrieval: BM25 and HNSW KNN run concurrently against the same RediSearch index,
 * are fused with Reciprocal Rank Fusion, and the head of the fused list is optionally
 * reranked by an LLM judge.
 */
export async function hybridSearch(opts: SearchOptions): Promise<SearchResponse> {
  const t0 = Date.now();
  const mode = opts.mode ?? "hybrid";
  const k = opts.k ?? 10;
  const n = opts.candidates ?? env.SEARCH_CANDIDATES;
  const timings: Record<string, number> = {};

  const bm25P =
    mode === "vector"
      ? Promise.resolve<ListHit[]>([])
      : bm25Search(opts.repoId, opts.query, n, opts.filters).finally(() => (timings.bm25Ms = Date.now() - t0));
  let degraded: string | undefined;
  const vectorP =
    mode === "bm25"
      ? Promise.resolve<ListHit[]>([])
      : embedQuery(opts.query, opts.signal)
          .then((vec) => {
            timings.embedMs = Date.now() - t0;
            const t1 = Date.now();
            return vectorSearch(opts.repoId, vec, n, opts.filters).finally(() => (timings.vectorMs = Date.now() - t1));
          })
          .catch((err: unknown) => {
            // In hybrid mode an embedding outage (quota, 5xx) degrades to keyword-only search.
            if (mode === "vector" || isAbortError(err)) throw err;
            degraded = `vector search unavailable: ${errorMessage(err).slice(0, 160)}`;
            logger.warn({ err: degraded }, "hybrid search degraded to BM25");
            return [] as ListHit[];
          });
  const [bm25, vector] = await Promise.all([bm25P, vectorP]);

  const fused = reciprocalRankFusion(
    [
      { name: "bm25", ids: bm25.map((h) => h.id) },
      { name: "vector", ids: vector.map((h) => h.id) },
    ],
    env.RRF_K,
  );

  const rerankN = opts.rerank ? Math.min(env.RERANK_TOP_N, fused.length) : 0;
  const headIds = fused.slice(0, Math.max(k, rerankN)).map((f) => f.id);
  const t2 = Date.now();
  const chunks = await hydrate(headIds);
  timings.hydrateMs = Date.now() - t2;

  const bm25ById = new Map(bm25.map((h, i) => [h.id, { rank: i + 1, score: h.score }]));
  const vecById = new Map(vector.map((h, i) => [h.id, { rank: i + 1, score: h.score }]));
  let scored: ScoredHit[] = fused
    .filter((f) => chunks.has(f.id))
    .map((f, i) => ({
      chunk: chunks.get(f.id) as ChunkHit,
      rank: i + 1,
      rrfScore: f.score,
      rrfRank: i + 1,
      bm25Rank: bm25ById.get(f.id)?.rank,
      bm25Score: bm25ById.get(f.id)?.score,
      vectorRank: vecById.get(f.id)?.rank,
      vectorScore: vecById.get(f.id)?.score,
    }));

  let reranked = false;
  let rerankError: string | undefined;
  if (rerankN > 1 && scored.length > 1) {
    const head = scored.slice(0, rerankN);
    const t3 = Date.now();
    // Reranking is an optimisation: past its deadline we keep the RRF order rather than stall the answer.
    const deadline = AbortSignal.timeout(env.RERANK_TIMEOUT_MS);
    const rerankSignal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
    try {
      const outcome = await rerankWithLlm(opts.query, head.map((h) => h.chunk), rerankSignal, opts.trace);
      head.forEach((h, i) => (h.rerankScore = outcome.scores[i]));
      // Primary key: judge score; unscored candidates sink; RRF order breaks ties.
      head.sort((a, b) => (b.rerankScore ?? -1) - (a.rerankScore ?? -1) || a.rrfRank - b.rrfRank);
      scored = [...head, ...scored.slice(rerankN)];
      reranked = true;
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      rerankError = deadline.aborted ? `rerank exceeded ${env.RERANK_TIMEOUT_MS}ms` : errorMessage(err);
      logger.warn({ err: rerankError }, "rerank failed; using RRF order");
    }
    timings.rerankMs = Date.now() - t3;
  }

  const results = scored.slice(0, k).map((h, i) => ({ ...h, rank: i + 1 }));
  timings.totalMs = Date.now() - t0;
  return { query: opts.query, mode, results, bm25, vector, reranked, ...(rerankError ? { rerankError } : {}), ...(degraded ? { degraded } : {}), timings };
}

/** Exact symbol lookup used for call-graph expansion during multi-hop reasoning. */
export async function findSymbols(repoId: string, names: string[], limit = 10): Promise<ChunkHit[]> {
  if (!names.length) return [];
  const q = `${filterClause(repoId, { kinds: ["function", "method", "class", "interface", "type"] })} @nameTag:{${names.map(escapeTag).join("|")}}`;
  const reply = (await redis.sendCommand(["FT.SEARCH", env.REDIS_INDEX_NAME, q, "NOCONTENT", "LIMIT", "0", String(limit), "DIALECT", "2"])) as unknown[];
  const ids = reply.slice(1).map((k) => idFromKey(str(k)));
  const map = await hydrate(ids);
  return ids.map((id) => map.get(id)).filter((h): h is ChunkHit => !!h);
}
