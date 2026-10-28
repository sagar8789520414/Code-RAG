/**
 * CLI benchmark runner (no HTTP server needed):
 *   npm run bench -- --repo <repoId> --file benchmarks/requests.sample.json [--modes bm25,vector,hybrid,hybrid_rerank] [--k 10]
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { parseArgs } from "node:util";
import { datasetSchema } from "../benchmark/metrics.js";
import { BENCHMARK_MODES, runBenchmark, type BenchmarkMode } from "../benchmark/runner.js";
import { closeMongo, collections, connectMongo } from "../db/mongo.js";
import { closeRedis, connectRedis } from "../db/redis.js";
import { ensureIndex } from "../search/redisIndex.js";

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    file: { type: "string" },
    modes: { type: "string", default: BENCHMARK_MODES.join(",") },
    k: { type: "string", default: "10" },
  },
});

if (!values.repo || !values.file) {
  console.error("usage: npm run bench -- --repo <repoId> --file <dataset.json> [--modes ...] [--k 10]");
  process.exit(2);
}

const raw = JSON.parse(await fs.readFile(values.file, "utf8")) as unknown;
const dataset = datasetSchema.parse(Array.isArray(raw) ? raw : (raw as { items: unknown }).items);
const modes = values.modes!.split(",").map((m) => m.trim()) as BenchmarkMode[];
for (const m of modes) if (!BENCHMARK_MODES.includes(m)) throw new Error(`unknown mode ${m}`);

await Promise.all([connectMongo(), connectRedis()]);
await ensureIndex();
const benchmarkId = crypto.randomUUID();
await collections().benchmarks.insertOne({
  _id: benchmarkId,
  repoId: values.repo,
  name: `cli:${values.file}`,
  jobId: "cli",
  status: "running",
  k: Number(values.k),
  modes,
  datasetSize: dataset.length,
  summary: {},
  perQuestion: [],
  createdAt: new Date(),
});

const summary = await runBenchmark({ benchmarkId, repoId: values.repo, dataset, modes, k: Number(values.k) }, new AbortController().signal, (c, t) =>
  process.stderr.write(`\r${c}/${t} searches`),
);
process.stderr.write("\n");
console.table(Object.fromEntries(Object.entries(summary).filter(([k]) => k !== "meta")));
console.log(JSON.stringify((summary as { meta?: unknown }).meta));
console.log(`benchmark id: ${benchmarkId}`);
await Promise.allSettled([closeMongo(), closeRedis()]);
