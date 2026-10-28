import { collections } from "../db/mongo.js";
import type { BenchmarkDoc } from "../db/models.js";
import { chunkAst } from "../ingestion/astChunker.js";
import { strategyForPath } from "../ingestion/languages.js";
import { errorMessage, isAbortError } from "../lib/errors.js";
import { hybridSearch, type SearchMode } from "../search/hybrid.js";
import { scoreRanking, summarize, type BenchmarkItem, type Expected, type QuestionScore } from "./metrics.js";

export const BENCHMARK_MODES = ["bm25", "vector", "hybrid", "hybrid_rerank"] as const;
export type BenchmarkMode = (typeof BENCHMARK_MODES)[number];

const modeConfig: Record<BenchmarkMode, { mode: SearchMode; rerank: boolean }> = {
  bm25: { mode: "bm25", rerank: false },
  vector: { mode: "vector", rerank: false },
  hybrid: { mode: "hybrid", rerank: false },
  hybrid_rerank: { mode: "hybrid", rerank: true },
};

type ResolvedExpected = Expected & { resolvedLines?: [number, number]; resolved: boolean };

/**
 * Resolves `{path, symbol}` expectations to line ranges by parsing the indexed file with the
 * AST chunker. This lets fixed-window indexes be scored by line overlap against the same
 * ground truth, so AST vs. naive chunking is an apples-to-apples comparison.
 */
async function resolveExpectations(repoId: string, items: BenchmarkItem[]): Promise<Map<BenchmarkItem, ResolvedExpected[]>> {
  const { files } = collections();
  const paths = [...new Set(items.flatMap((i) => i.expected.map((e) => e.path)))];
  const docs = await files.find({ repoId, path: { $in: paths } }, { projection: { path: 1, content: 1 } }).toArray();
  const symbolLines = new Map<string, Map<string, [number, number]>>();
  for (const d of docs) {
    const strategy = strategyForPath(d.path);
    if (strategy?.kind !== "ast") continue;
    // A 1-char budget forces every class into member chunks so methods get their own
    // ranges; split parts of one symbol are merged back into its full span.
    const chunks = await chunkAst(strategy.spec, d.content, d.path, { maxChars: 1 }).catch(() => []);
    const ranges = new Map<string, [number, number]>();
    for (const c of chunks) {
      if (c.kind === "file" || c.kind === "module") continue;
      const r = ranges.get(c.symbolPath);
      ranges.set(c.symbolPath, r ? [Math.min(r[0], c.startLine), Math.max(r[1], c.endLine)] : [c.startLine, c.endLine]);
    }
    symbolLines.set(d.path, ranges);
  }
  const present = new Set(docs.map((d) => d.path));
  const out = new Map<BenchmarkItem, ResolvedExpected[]>();
  for (const item of items) {
    out.set(
      item,
      item.expected.map((e) => {
        const lines = e.symbol ? symbolLines.get(e.path)?.get(e.symbol) : undefined;
        return { ...e, ...(lines ? { resolvedLines: lines } : {}), resolved: present.has(e.path) && (!e.symbol || !!lines || !!e.lines) };
      }),
    );
  }
  return out;
}

export interface RunBenchmarkInput {
  benchmarkId: string;
  repoId: string;
  dataset: BenchmarkItem[];
  modes: BenchmarkMode[];
  k: number;
}

export async function runBenchmark(input: RunBenchmarkInput, signal: AbortSignal, progress: (current: number, total: number) => void): Promise<BenchmarkDoc["summary"]> {
  const { benchmarks } = collections();
  const resolved = await resolveExpectations(input.repoId, input.dataset);
  const scores: Record<string, Array<QuestionScore & { latencyMs: number }>> = Object.fromEntries(input.modes.map((m) => [m, []]));
  const perQuestion: unknown[] = [];
  const total = input.dataset.length * input.modes.length;
  let done = 0;

  for (const [qi, item] of input.dataset.entries()) {
    signal.throwIfAborted();
    const expected = resolved.get(item) as ResolvedExpected[];
    const row: Record<string, unknown> = {
      id: item.id ?? `q${qi + 1}`,
      question: item.question,
      expected: expected.map((e) => ({ path: e.path, symbol: e.symbol, lines: e.lines ?? e.resolvedLines, resolved: e.resolved })),
      modes: {},
    };
    for (const mode of input.modes) {
      const cfg = modeConfig[mode];
      const t0 = Date.now();
      try {
        const res = await hybridSearch({ repoId: input.repoId, query: item.question, k: input.k, mode: cfg.mode, rerank: cfg.rerank, signal });
        const latencyMs = Date.now() - t0;
        const hits = res.results.map((r) => r.chunk);
        const s = scoreRanking(hits, expected, input.k);
        scores[mode]!.push({ ...s, latencyMs });
        (row.modes as Record<string, unknown>)[mode] = {
          ...s,
          latencyMs,
          reranked: res.reranked,
          top: hits.slice(0, 5).map((h) => ({ path: h.path, symbol: h.symbolPath, lines: [h.startLine, h.endLine] })),
        };
      } catch (err) {
        if (isAbortError(err)) throw err;
        scores[mode]!.push({ matchedExpected: 0, totalExpected: expected.length, latencyMs: Date.now() - t0 });
        (row.modes as Record<string, unknown>)[mode] = { error: errorMessage(err).slice(0, 300) };
      }
      progress(++done, total);
    }
    perQuestion.push(row);
    const summary = Object.fromEntries(input.modes.map((m) => [m, summarize(scores[m]!)]));
    await benchmarks.updateOne({ _id: input.benchmarkId }, { $set: { summary, perQuestion } });
  }

  const unresolved = [...resolved.values()].flat().filter((e) => !e.resolved).length;
  const summary = {
    ...Object.fromEntries(input.modes.map((m) => [m, summarize(scores[m]!)])),
    meta: { k: input.k, unresolvedExpectations: unresolved, accuracyMetric: `hit@5` },
  };
  await benchmarks.updateOne({ _id: input.benchmarkId }, { $set: { summary, perQuestion, status: "completed", finishedAt: new Date() } });
  return summary;
}
