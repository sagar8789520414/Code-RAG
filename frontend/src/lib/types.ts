export type ChunkKind = "function" | "method" | "class" | "interface" | "type" | "enum" | "module" | "imports" | "file" | "section" | "block";
export type RepoStatus = "pending" | "indexing" | "ready" | "error";
export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface Job {
  _id: string;
  type: "index" | "sync" | "benchmark";
  repoId: string;
  status: JobStatus;
  progress: { phase: string; current: number; total: number; message?: string };
  result?: Record<string, unknown>;
  error?: string;
  attempts: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface Repo {
  _id: string;
  name: string;
  url: string;
  branch: string;
  chunking: "ast" | "fixed";
  status: RepoStatus;
  lastIndexedCommit?: string;
  lastIndexedAt?: string;
  stats: { files: number; chunks: number; languages: Record<string, number> };
  error?: string;
  createdAt: string;
  updatedAt: string;
  activeJob?: Job | null;
}

export interface IndexStats {
  filesScanned: number;
  filesChanged: number;
  filesDeleted: number;
  filesSkipped: number;
  chunksAdded: number;
  chunksUpdated: number;
  chunksRemoved: number;
  chunksUnchanged: number;
  embeddingsComputed: number;
  embeddingsReused: number;
}

export interface CommitFileSummary {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  hunks: number;
  touchedChunks: number;
  chunks: { added: number; updated: number; removed: number; unchanged: number };
}

export interface Commit {
  _id: string;
  sha: string;
  baseSha?: string;
  message: string;
  author: string;
  committedAt: string;
  mode: "full" | "incremental";
  files?: CommitFileSummary[];
  filesTruncated?: boolean;
  stats: IndexStats;
  durationMs: number;
  indexedAt: string;
}

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

export interface StageHit {
  id: string;
  rank: number;
  score: number;
  chunk: { path: string; symbolPath: string; kind: ChunkKind; startLine: number; endLine: number } | null;
}

export interface SearchInspection {
  query: string;
  mode: "hybrid" | "bm25" | "vector";
  terms: string[];
  rrfK: number;
  reranked: boolean;
  rerankError?: string;
  degraded?: string;
  timings: Record<string, number>;
  results: ScoredHit[];
  stages: { bm25: StageHit[]; vector: StageHit[] };
  llmCalls: LLMCall[];
}

export interface LLMCall {
  purpose: string;
  provider: string;
  model?: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
  fallbackFrom?: string;
  fallbackReason?: string;
}

export interface SourceRef {
  n: number;
  chunkId: string;
  path: string;
  name: string;
  symbolPath: string;
  kind: ChunkKind;
  language: string;
  startLine: number;
  endLine: number;
  score: number;
  via: string[];
}

export type StepKind = "plan" | "retrieve" | "expand" | "evaluate" | "synthesize";

export interface AgentStep {
  id: string;
  kind: StepKind;
  status: "running" | "done" | "error" | "skipped";
  title: string;
  detail?: string;
  data?: unknown;
  startedAt: number;
  durationMs?: number;
}

export interface FileView {
  path: string;
  language: string;
  size: number;
  commit?: string;
  content: string;
  chunks: Array<{ id: string; kind: ChunkKind; name: string; symbolPath: string; signature: string; startLine: number; endLine: number }>;
}

export interface Health {
  ok: boolean;
  services: { mongo: boolean; redis: boolean };
  index: { numDocs: number; indexing: boolean } | null;
  llm: Array<{ name: string; state: "closed" | "open" | "half_open"; consecutiveFailures: number; reopensInMs: number; lastError?: string }>;
  models: { groq: { reasoning: string; fast: string }; gemini: { reasoning: string[]; fast: string[] }; embedding: { model: string; dim: number } };
  worker: { busy: boolean };
  adminKeyRequired: boolean;
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

export interface BenchmarkExpected {
  path: string;
  symbol?: string;
  lines?: [number, number];
}

export interface BenchmarkItem {
  id?: string;
  question: string;
  expected: BenchmarkExpected[];
}

export interface BenchmarkQuestionResult {
  id: string;
  question: string;
  expected: Array<BenchmarkExpected & { resolved: boolean }>;
  modes: Record<string, { firstHitRank?: number; matchedExpected?: number; totalExpected?: number; latencyMs?: number; error?: string; top?: Array<{ path: string; symbol: string; lines: [number, number] }> }>;
}

export interface Benchmark {
  _id: string;
  repoId: string;
  name: string;
  jobId: string;
  status: JobStatus;
  k: number;
  modes: string[];
  datasetSize: number;
  summary: Record<string, ModeSummary> & { meta?: { k: number; unresolvedExpectations: number; accuracyMetric: string } };
  perQuestion?: BenchmarkQuestionResult[];
  createdAt: string;
  finishedAt?: string;
  error?: string;
}
