import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { z } from "zod";
import { datasetSchema } from "../benchmark/metrics.js";
import { BENCHMARK_MODES } from "../benchmark/runner.js";
import { collections } from "../db/mongo.js";
import type { BenchmarkDoc } from "../db/models.js";
import { jobQueue } from "../jobs/queue.js";
import { NotFoundError } from "../lib/errors.js";
import { parseBody, parseQuery, requireAdmin } from "../middleware/common.js";

export const benchmarksRouter = Router();

const SAMPLES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../benchmarks");

const runSchema = z.object({
  repoId: z.string().min(1),
  name: z.string().min(1).max(120).default("benchmark"),
  dataset: datasetSchema,
  modes: z.array(z.enum(BENCHMARK_MODES)).min(1).default([...BENCHMARK_MODES]),
  k: z.number().int().min(1).max(50).default(10),
});

benchmarksRouter.get("/samples", async (_req, res) => {
  const files = (await fs.readdir(SAMPLES_DIR).catch(() => [])).filter((f) => f.endsWith(".json"));
  const samples = await Promise.all(
    files.map(async (f) => {
      const data = JSON.parse(await fs.readFile(path.join(SAMPLES_DIR, f), "utf8")) as { repo?: string; description?: string; items: unknown[] };
      return { file: f, repo: data.repo, description: data.description, size: data.items.length, items: data.items };
    }),
  );
  res.json({ samples });
});

benchmarksRouter.post("/", requireAdmin, async (req, res) => {
  const body = parseBody(runSchema, req);
  const repo = await collections().repos.findOne({ _id: body.repoId });
  if (!repo) throw new NotFoundError("Repository");
  const benchmarkId = crypto.randomUUID();
  const job = await jobQueue.enqueue("benchmark", repo._id, { benchmarkId, dataset: body.dataset, modes: body.modes, k: body.k });
  const doc: BenchmarkDoc = {
    _id: benchmarkId,
    repoId: repo._id,
    name: body.name,
    jobId: job._id,
    status: "queued",
    k: body.k,
    modes: body.modes,
    datasetSize: body.dataset.length,
    summary: {},
    perQuestion: [],
    createdAt: new Date(),
  };
  await collections().benchmarks.insertOne(doc);
  res.status(202).json({ benchmark: doc, job });
});

benchmarksRouter.get("/", async (req, res) => {
  const { repoId } = parseQuery(z.object({ repoId: z.string().min(1) }), req);
  const list = await collections()
    .benchmarks.find({ repoId }, { projection: { perQuestion: 0 } })
    .sort({ createdAt: -1 })
    .limit(50)
    .toArray();
  res.json({ benchmarks: list });
});

benchmarksRouter.get("/:id", async (req, res) => {
  const doc = await collections().benchmarks.findOne({ _id: req.params.id });
  if (!doc) throw new NotFoundError("Benchmark");
  res.json(doc);
});
