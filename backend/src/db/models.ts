import type { Binary } from "mongodb";

export type ChunkingStrategy = "ast" | "fixed";
export type RepoStatus = "pending" | "indexing" | "ready" | "error";

export interface RepoDoc {
  _id: string;
  name: string;
  /** Clone URL with any credentials stripped. */
  url: string;
  branch: string;
  chunking: ChunkingStrategy;
  status: RepoStatus;
  lastIndexedCommit?: string;
  lastIndexedAt?: Date;
  stats: { files: number; chunks: number; languages: Record<string, number> };
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface FileDoc {
  _id: string; // `${repoId}:${path}`
  repoId: string;
  path: string;
  language: string;
  /** git blob sha; a file whose blob is unchanged never needs re-parsing. */
  blobSha: string;
  size: number;
  content: string;
  chunkIds: string[];
  indexedAt: Date;
}

export type ChunkKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "module"
  | "imports"
  | "file"
  | "section"
  | "block";

export interface ChunkDoc {
  _id: string;
  repoId: string;
  path: string;
  language: string;
  kind: ChunkKind;
  name: string;
  symbolPath: string;
  parentScope: string;
  signature: string;
  docstring: string;
  startLine: number;
  endLine: number;
  contentHash: string;
  embeddingHash: string;
  commit: string;
  updatedAt: Date;
}

export interface EmbeddingCacheDoc {
  _id: string; // `${model}:${dim}:${embeddingHash}`
  vector: Binary;
  createdAt: Date;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export type FileChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface CommitFileChange {
  path: string;
  oldPath?: string;
  status: FileChangeStatus;
  hunks: DiffHunk[];
  /** Chunk ids whose line ranges intersect the diff hunks. */
  touchedChunkIds: string[];
  chunks: { added: number; updated: number; removed: number; unchanged: number };
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

export interface CommitDoc {
  _id: string; // `${repoId}:${sha}`
  repoId: string;
  sha: string;
  baseSha?: string;
  message: string;
  author: string;
  committedAt: Date;
  mode: "full" | "incremental";
  files: CommitFileChange[];
  stats: IndexStats;
  durationMs: number;
  indexedAt: Date;
}

export type JobType = "index" | "sync" | "benchmark";
export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface JobDoc {
  _id: string;
  type: JobType;
  repoId: string;
  status: JobStatus;
  payload: Record<string, unknown>;
  progress: { phase: string; current: number; total: number; message?: string };
  result?: Record<string, unknown>;
  error?: string;
  attempts: number;
  lockedBy?: string;
  heartbeatAt?: Date;
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
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

export interface QueryDoc {
  _id: string;
  repoId: string;
  question: string;
  plan?: unknown;
  steps: unknown[];
  sources: SourceRef[];
  answer: string;
  llmCalls: unknown[];
  timings: Record<string, number>;
  status: "completed" | "failed" | "cancelled";
  error?: string;
  createdAt: Date;
}

export interface BenchmarkDoc {
  _id: string;
  repoId: string;
  name: string;
  jobId: string;
  status: JobStatus;
  k: number;
  modes: string[];
  datasetSize: number;
  summary: Record<string, unknown>;
  perQuestion: unknown[];
  createdAt: Date;
  finishedAt?: Date;
  error?: string;
}
