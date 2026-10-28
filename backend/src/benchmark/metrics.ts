import { z } from "zod";

export const expectedSchema = z.object({
  path: z.string().min(1),
  /** Dotted symbol path, e.g. "Session.request" or "authMiddleware". */
  symbol: z.string().optional(),
  /** 1-based inclusive line range. */
  lines: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
});

export const benchmarkItemSchema = z.object({
  id: z.string().optional(),
  question: z.string().min(3),
  expected: z.array(expectedSchema).min(1),
});

export const datasetSchema = z.array(benchmarkItemSchema).min(1).max(500);

export type Expected = z.infer<typeof expectedSchema>;
export type BenchmarkItem = z.infer<typeof benchmarkItemSchema>;

export interface HitLike {
  path: string;
  kind: string;
  name: string;
  symbolPath: string;
  startLine: number;
  endLine: number;
}

const normPath = (p: string) => p.replace(/\\/g, "/").replace(/^\.?\//, "").toLowerCase();

/**
 * A retrieved chunk satisfies an expectation when it is in the expected file and either
 * names the expected symbol (itself, its enclosing class, or one of its members) or covers
 * at least half of the expected line range (or the range covers half of the chunk — needed
 * to score fixed-window chunks fairly). File-outline chunks only satisfy path-only targets.
 */
export function matchesExpected(hit: HitLike, exp: Expected & { resolvedLines?: [number, number] }): boolean {
  if (normPath(hit.path) !== normPath(exp.path)) return false;
  const lines = exp.lines ?? exp.resolvedLines;
  if (!exp.symbol && !lines) return true;
  if (hit.kind === "file") return false;
  if (exp.symbol) {
    const s = exp.symbol;
    const sp = hit.symbolPath;
    if (sp === s || sp.endsWith(`.${s}`) || hit.name === s || s.startsWith(`${sp}.`) || sp.startsWith(`${s}.`)) return true;
  }
  if (lines) {
    const [es, ee] = lines;
    const inter = Math.min(ee, hit.endLine) - Math.max(es, hit.startLine) + 1;
    if (inter <= 0) return false;
    return inter / (ee - es + 1) >= 0.5 || inter / (hit.endLine - hit.startLine + 1) >= 0.5;
  }
  return false;
}

export interface QuestionScore {
  firstHitRank?: number;
  matchedExpected: number;
  totalExpected: number;
}

export function scoreRanking(hits: HitLike[], expected: Array<Expected & { resolvedLines?: [number, number] }>, k: number): QuestionScore {
  const top = hits.slice(0, k);
  let firstHitRank: number | undefined;
  top.forEach((h, i) => {
    if (firstHitRank === undefined && expected.some((e) => matchesExpected(h, e))) firstHitRank = i + 1;
  });
  const matchedExpected = expected.filter((e) => top.some((h) => matchesExpected(h, e))).length;
  return { ...(firstHitRank !== undefined ? { firstHitRank } : {}), matchedExpected, totalExpected: expected.length };
}

export interface ModeSummary {
  questions: number;
  "hit@1": number;
  "hit@3": number;
  "hit@5": number;
  "hit@10": number;
  mrr: number;
  "recall@k": number;
  avgLatencyMs: number;
  p95LatencyMs: number;
}

export function summarize(scores: Array<QuestionScore & { latencyMs: number }>): ModeSummary {
  const n = scores.length || 1;
  const hitAt = (k: number) => scores.filter((s) => s.firstHitRank !== undefined && s.firstHitRank <= k).length / n;
  const lat = scores.map((s) => s.latencyMs).sort((a, b) => a - b);
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return {
    questions: scores.length,
    "hit@1": round(hitAt(1)),
    "hit@3": round(hitAt(3)),
    "hit@5": round(hitAt(5)),
    "hit@10": round(hitAt(10)),
    mrr: round(scores.reduce((a, s) => a + (s.firstHitRank ? 1 / s.firstHitRank : 0), 0) / n),
    "recall@k": round(scores.reduce((a, s) => a + s.matchedExpected / s.totalExpected, 0) / n),
    avgLatencyMs: Math.round(lat.reduce((a, b) => a + b, 0) / n),
    p95LatencyMs: Math.round(lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))] ?? 0),
  };
}
