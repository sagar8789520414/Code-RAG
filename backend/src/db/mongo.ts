import { MongoClient, type Collection, type Db } from "mongodb";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import type { BenchmarkDoc, ChunkDoc, CommitDoc, EmbeddingCacheDoc, FileDoc, JobDoc, QueryDoc, RepoDoc } from "./models.js";

const client = new MongoClient(env.MONGODB_URI, {
  serverSelectionTimeoutMS: 15_000,
  appName: "code-rag",
});

let db: Db | undefined;

export interface Collections {
  repos: Collection<RepoDoc>;
  files: Collection<FileDoc>;
  chunks: Collection<ChunkDoc>;
  embeddings: Collection<EmbeddingCacheDoc>;
  commits: Collection<CommitDoc>;
  jobs: Collection<JobDoc>;
  queries: Collection<QueryDoc>;
  benchmarks: Collection<BenchmarkDoc>;
}

let cols: Collections | undefined;

export function collections(): Collections {
  if (!cols) throw new Error("MongoDB not connected; call connectMongo() first");
  return cols;
}

export async function connectMongo(): Promise<void> {
  await client.connect();
  db = client.db(env.MONGODB_DB);
  cols = {
    repos: db.collection<RepoDoc>("repos"),
    files: db.collection<FileDoc>("files"),
    chunks: db.collection<ChunkDoc>("chunks"),
    embeddings: db.collection<EmbeddingCacheDoc>("embedding_cache"),
    commits: db.collection<CommitDoc>("commits"),
    jobs: db.collection<JobDoc>("jobs"),
    queries: db.collection<QueryDoc>("queries"),
    benchmarks: db.collection<BenchmarkDoc>("benchmarks"),
  };
  await Promise.all([
    cols.files.createIndex({ repoId: 1, path: 1 }, { unique: true }),
    cols.chunks.createIndex({ repoId: 1, path: 1 }),
    cols.chunks.createIndex({ repoId: 1, name: 1 }),
    cols.commits.createIndex({ repoId: 1, indexedAt: -1 }),
    cols.jobs.createIndex({ status: 1, createdAt: 1 }),
    cols.jobs.createIndex({ repoId: 1, createdAt: -1 }),
    cols.queries.createIndex({ repoId: 1, createdAt: -1 }),
    cols.benchmarks.createIndex({ repoId: 1, createdAt: -1 }),
  ]);
  logger.info({ db: env.MONGODB_DB }, "MongoDB connected");
}

export async function pingMongo(): Promise<boolean> {
  try {
    await db?.command({ ping: 1 });
    return db !== undefined;
  } catch {
    return false;
  }
}

export async function closeMongo(): Promise<void> {
  await client.close();
}
