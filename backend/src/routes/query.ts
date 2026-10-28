import { Router } from "express";
import { z } from "zod";
import { AgentRun, type AgentEvent } from "../agent/agent.js";
import { collections } from "../db/mongo.js";
import { NotFoundError } from "../lib/errors.js";
import { parseBody, parseQuery, SseStream } from "../middleware/common.js";

export const queryRouter = Router();

const querySchema = z.object({
  repoId: z.string().min(1),
  question: z.string().trim().min(2).max(4000),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(20_000) }))
    .max(20)
    .optional(),
  rerank: z.boolean().optional(),
  maxHops: z.number().int().min(0).max(5).optional(),
});

async function assertRepoReady(repoId: string): Promise<void> {
  const repo = await collections().repos.findOne({ _id: repoId }, { projection: { status: 1, lastIndexedCommit: 1 } });
  if (!repo) throw new NotFoundError("Repository");
}

/** Conversational query over SSE: `step`, `sources`, `token`, then `done` (or `error`). */
queryRouter.post("/query/stream", async (req, res) => {
  const input = parseBody(querySchema, req);
  await assertRepoReady(input.repoId);
  const abort = new AbortController();
  const sse = new SseStream(res);
  res.on("close", () => abort.abort(new Error("client disconnected")));
  const emit = (e: AgentEvent) => {
    const { type, ...data } = e;
    sse.send(type, data);
  };
  try {
    await new AgentRun(input, emit, abort.signal).run();
  } catch (err) {
    sse.send("error", { message: (err as Error).message });
  } finally {
    sse.close();
  }
});

/** Same agent, buffered into one JSON response. */
queryRouter.post("/query", async (req, res) => {
  const input = parseBody(querySchema, req);
  await assertRepoReady(input.repoId);
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort(new Error("client disconnected"));
  });
  const doc = await new AgentRun(input, () => undefined, abort.signal).run();
  res.status(doc.status === "failed" ? 502 : 200).json(doc);
});

queryRouter.get("/queries", async (req, res) => {
  const { repoId, limit } = parseQuery(z.object({ repoId: z.string().min(1), limit: z.coerce.number().int().min(1).max(100).default(20) }), req);
  const list = await collections()
    .queries.find({ repoId }, { projection: { question: 1, status: 1, createdAt: 1, timings: 1, "sources.path": 1 } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
  res.json({ queries: list });
});

queryRouter.get("/queries/:id", async (req, res) => {
  const doc = await collections().queries.findOne({ _id: req.params.id });
  if (!doc) throw new NotFoundError("Query");
  res.json(doc);
});
