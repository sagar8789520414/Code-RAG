import crypto from "node:crypto";
import express, { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { collections, pingMongo } from "../db/mongo.js";
import { pingRedis } from "../db/redis.js";
import { jobQueue } from "../jobs/queue.js";
import { AppError, NotFoundError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { llm } from "../llm/router.js";
import { parseQuery } from "../middleware/common.js";
import { indexInfo } from "../search/redisIndex.js";

export const systemRouter = Router();

systemRouter.get("/health", async (_req, res) => {
  const [mongo, redis, index] = await Promise.all([pingMongo(), pingRedis(), indexInfo()]);
  const ok = mongo && redis;
  res.status(ok ? 200 : 503).json({
    ok,
    services: { mongo, redis },
    index: index ?? null,
    llm: llm.health(),
    models: {
      groq: { reasoning: env.GROQ_MODEL, fast: env.GROQ_FAST_MODEL },
      gemini: { reasoning: env.GEMINI_MODELS, fast: env.GEMINI_FAST_MODELS },
      embedding: { model: env.EMBEDDING_MODEL, dim: env.EMBEDDING_DIM },
    },
    worker: { busy: jobQueue.isBusy() },
    adminKeyRequired: !!env.ADMIN_API_KEY,
  });
});

systemRouter.get("/jobs", async (req, res) => {
  const { repoId, limit } = parseQuery(z.object({ repoId: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }), req);
  const jobs = await collections()
    .jobs.find(repoId ? { repoId } : {}, { projection: { payload: 0 } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
  res.json({ jobs });
});

systemRouter.get("/jobs/:id", async (req, res) => {
  const job = await collections().jobs.findOne({ _id: req.params.id }, { projection: { payload: 0 } });
  if (!job) throw new NotFoundError("Job");
  res.json(job);
});

/**
 * GitHub push webhook → incremental sync of every registered repo tracking that branch.
 * Mounted with a raw body parser so the HMAC is computed over the exact payload bytes.
 */
systemRouter.post("/webhooks/github", express.raw({ type: "*/*", limit: "5mb" }), async (req, res) => {
  if (!env.GITHUB_WEBHOOK_SECRET) throw new AppError("Webhook secret not configured", 404, "not_found");
  const sig = req.header("x-hub-signature-256") ?? "";
  const body = req.body as Buffer;
  const expected = `sha256=${crypto.createHmac("sha256", env.GITHUB_WEBHOOK_SECRET).update(body).digest("hex")}`;
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new AppError("Invalid webhook signature", 401, "unauthorized");
  }
  const event = req.header("x-github-event");
  if (event === "ping") return void res.json({ ok: true });
  if (event !== "push") return void res.status(202).json({ ignored: event });

  const payload = JSON.parse(body.toString("utf8")) as { ref?: string; repository?: { clone_url?: string; html_url?: string } };
  const branch = payload.ref?.replace(/^refs\/heads\//, "");
  const urls = [payload.repository?.clone_url, payload.repository?.html_url]
    .filter((u): u is string => !!u)
    .flatMap((u) => [u.replace(/\.git$/, ""), u]);
  const repos = await collections()
    .repos.find({ url: { $in: urls } })
    .toArray();
  const targets = repos.filter((r) => !branch || !r.branch || r.branch === branch);
  const jobs = await Promise.all(targets.map((r) => jobQueue.enqueue("sync", r._id, { trigger: "webhook" }, { dedupe: true })));
  logger.info({ branch, repos: targets.map((r) => r._id) }, "webhook push received");
  res.status(202).json({ queued: jobs.map((j) => ({ jobId: j._id, repoId: j.repoId })) });
});
