import { runBenchmark, type BenchmarkMode } from "../benchmark/runner.js";
import type { BenchmarkItem } from "../benchmark/metrics.js";
import { collections } from "../db/mongo.js";
import { indexRepository } from "../ingestion/indexer.js";
import { errorMessage } from "../lib/errors.js";
import { jobQueue } from "./queue.js";

export function registerJobHandlers(): void {
  const indexHandler = (full: boolean) =>
    jobQueue.register(full ? "index" : "sync", async ({ job, signal, progress }) => {
      const outcome = await indexRepository(job.repoId, { full: full || job.payload.full === true }, { signal, progress });
      return { ...outcome };
    });
  indexHandler(true);
  indexHandler(false);

  jobQueue.register("benchmark", async ({ job, signal, progress }) => {
    const { benchmarks } = collections();
    const p = job.payload as { benchmarkId: string; dataset: BenchmarkItem[]; modes: BenchmarkMode[]; k: number };
    await benchmarks.updateOne({ _id: p.benchmarkId }, { $set: { status: "running" } });
    try {
      const summary = await runBenchmark({ benchmarkId: p.benchmarkId, repoId: job.repoId, dataset: p.dataset, modes: p.modes, k: p.k }, signal, (current, total) =>
        progress({ phase: "benchmarking", current, total, message: `${current}/${total} searches` }),
      );
      return { benchmarkId: p.benchmarkId, summary };
    } catch (err) {
      await benchmarks.updateOne({ _id: p.benchmarkId }, { $set: { status: "failed", error: errorMessage(err), finishedAt: new Date() } });
      throw err;
    }
  });
}
