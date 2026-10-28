import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { collections } from "../db/mongo.js";
import { NotFoundError } from "../lib/errors.js";
import { parseBody } from "../middleware/common.js";
import { hydrate, hybridSearch } from "../search/hybrid.js";
import { extractTerms } from "../search/queryBuilder.js";
import type { LLMCallRecord } from "../llm/types.js";

export const searchRouter = Router();

const searchSchema = z.object({
  repoId: z.string().min(1),
  query: z.string().trim().min(2).max(2000),
  k: z.number().int().min(1).max(50).default(10),
  mode: z.enum(["hybrid", "bm25", "vector"]).default("hybrid"),
  rerank: z.boolean().default(true),
  filters: z
    .object({
      language: z.string().max(40).optional(),
      pathPrefix: z.string().max(300).optional(),
      kinds: z.array(z.string().max(20)).max(10).optional(),
    })
    .optional(),
});

/**
 * Retrieval inspection: returns each stage (BM25 list, vector list, RRF fusion, rerank)
 * so ranking behaviour can be debugged and compared side by side.
 */
searchRouter.post("/search", async (req, res) => {
  const body = parseBody(searchSchema, req);
  const repo = await collections().repos.findOne({ _id: body.repoId }, { projection: { _id: 1 } });
  if (!repo) throw new NotFoundError("Repository");
  const trace: LLMCallRecord[] = [];
  const result = await hybridSearch({ ...body, trace });

  const STAGE_N = 20;
  const stageIds = [...new Set([...result.bm25.slice(0, STAGE_N), ...result.vector.slice(0, STAGE_N)].map((h) => h.id))];
  const meta = await hydrate(stageIds);
  const label = (id: string) => {
    const c = meta.get(id);
    return c ? { path: c.path, symbolPath: c.symbolPath, kind: c.kind, startLine: c.startLine, endLine: c.endLine } : null;
  };
  res.json({
    query: result.query,
    mode: result.mode,
    terms: extractTerms(body.query),
    rrfK: env.RRF_K,
    reranked: result.reranked,
    rerankError: result.rerankError,
    degraded: result.degraded,
    timings: result.timings,
    llmCalls: trace,
    results: result.results,
    stages: {
      bm25: result.bm25.slice(0, STAGE_N).map((h, i) => ({ id: h.id, rank: i + 1, score: h.score, chunk: label(h.id) })),
      vector: result.vector.slice(0, STAGE_N).map((h, i) => ({ id: h.id, rank: i + 1, score: h.score, chunk: label(h.id) })),
    },
  });
});
