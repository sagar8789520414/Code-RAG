import { env } from "../config/env.js";
import { redis } from "../db/redis.js";
import { logger } from "../lib/logger.js";
import { chunkArray } from "../lib/text.js";
import { vectorToBuffer } from "../embeddings/embedder.js";
import type { ChunkKind } from "../db/models.js";

/** Fields stored per chunk hash. `embedding` is binary FLOAT32 and never returned to clients. */
export interface ChunkHashFields {
  repo: string;
  path: string;
  pathTag: string;
  language: string;
  kind: ChunkKind;
  name: string;
  nameTag: string;
  symbol: string;
  parentScope: string;
  signature: string;
  docstring: string;
  content: string;
  tokens: string;
  startLine: number;
  endLine: number;
}

export const HIT_FIELDS = [
  "repo",
  "path",
  "language",
  "kind",
  "name",
  "symbol",
  "parentScope",
  "signature",
  "docstring",
  "content",
  "startLine",
  "endLine",
] as const;

export const keyFor = (chunkId: string) => `${env.REDIS_KEY_PREFIX}${chunkId}`;
export const idFromKey = (key: string) => key.slice(env.REDIS_KEY_PREFIX.length);

/** BM25 scorer name; resolved at startup since older RediSearch only knows "BM25". */
export let bm25Scorer = "BM25STD";

/** Escapes a value for use inside a TAG query `{...}`. */
export function escapeTag(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, (c) => `\\${c}`);
}

function schemaArgs(): string[] {
  return [
    "repo", "TAG",
    "path", "TEXT", "WEIGHT", "2.0",
    "pathTag", "TAG", "SEPARATOR", "\u0001", "CASESENSITIVE",
    "language", "TAG",
    "kind", "TAG",
    "name", "TEXT", "WEIGHT", "4.0", "NOSTEM",
    "nameTag", "TAG", "SEPARATOR", "\u0001", "CASESENSITIVE",
    "symbol", "TEXT", "WEIGHT", "2.0", "NOSTEM",
    "signature", "TEXT", "WEIGHT", "1.5",
    "docstring", "TEXT", "WEIGHT", "1.2",
    "tokens", "TEXT", "WEIGHT", "1.5",
    "content", "TEXT",
    "startLine", "NUMERIC", "NOINDEX",
    "endLine", "NUMERIC", "NOINDEX",
    "embedding", "VECTOR", "HNSW", "10",
      "TYPE", "FLOAT32",
      "DIM", String(env.EMBEDDING_DIM),
      "DISTANCE_METRIC", "COSINE",
      "M", "16",
      "EF_CONSTRUCTION", "200",
  ];
}

function findVectorDim(info: unknown): number | undefined {
  // FT.INFO attributes: [[identifier, embedding, attribute, embedding, type, VECTOR, ..., dim, 768, ...], ...]
  const walk = (node: unknown): number | undefined => {
    if (!Array.isArray(node)) return undefined;
    const flat = node.map((x) => (Buffer.isBuffer(x) ? x.toString() : x));
    if (flat.includes("embedding") && flat.some((x) => String(x).toUpperCase() === "VECTOR")) {
      const i = flat.findIndex((x) => String(x).toLowerCase() === "dim");
      if (i >= 0) return Number(flat[i + 1]);
    }
    for (const child of node) {
      const d = walk(child);
      if (d !== undefined) return d;
    }
    return undefined;
  };
  return walk(info);
}

export async function ensureIndex(): Promise<void> {
  const name = env.REDIS_INDEX_NAME;
  let info: unknown;
  try {
    info = await redis.sendCommand(["FT.INFO", name]);
  } catch (err) {
    if (!/unknown index|no such index|not found/i.test((err as Error).message)) throw err;
  }
  if (info) {
    const dim = findVectorDim(info);
    if (dim !== undefined && dim !== env.EMBEDDING_DIM) {
      throw new Error(
        `Redis index ${name} has DIM ${dim} but EMBEDDING_DIM=${env.EMBEDDING_DIM}. Drop it (FT.DROPINDEX ${name}) and reindex, or use a different REDIS_INDEX_NAME.`,
      );
    }
    logger.info({ index: name }, "RediSearch index ready");
  } else {
    await redis.sendCommand(["FT.CREATE", name, "ON", "HASH", "PREFIX", "1", env.REDIS_KEY_PREFIX, "SCHEMA", ...schemaArgs()]);
    logger.info({ index: name, dim: env.EMBEDDING_DIM }, "RediSearch index created");
  }
  try {
    await redis.sendCommand(["FT.SEARCH", name, "*", "SCORER", "BM25STD", "LIMIT", "0", "0", "DIALECT", "2"]);
  } catch {
    bm25Scorer = "BM25";
  }
}

export interface ChunkWrite {
  id: string;
  fields: ChunkHashFields;
  vector: Float32Array;
}

export async function upsertChunks(writes: ChunkWrite[]): Promise<void> {
  for (const batch of chunkArray(writes, 200)) {
    await Promise.all(
      batch.map((w) => {
        const f = w.fields;
        return redis.hSet(keyFor(w.id), {
          ...f,
          startLine: String(f.startLine),
          endLine: String(f.endLine),
          embedding: vectorToBuffer(w.vector),
        });
      }),
    );
  }
}

/** Line numbers shift when code above a chunk changes; update them without re-embedding. */
export async function updateChunkLines(updates: Array<{ id: string; startLine: number; endLine: number }>): Promise<void> {
  for (const batch of chunkArray(updates, 500)) {
    await Promise.all(batch.map((u) => redis.hSet(keyFor(u.id), { startLine: String(u.startLine), endLine: String(u.endLine) })));
  }
}

export async function deleteChunks(ids: string[]): Promise<void> {
  for (const batch of chunkArray(ids, 500)) {
    if (batch.length) await redis.del(batch.map(keyFor));
  }
}

export async function indexInfo(): Promise<{ numDocs: number; indexing: boolean } | undefined> {
  try {
    const info = (await redis.sendCommand(["FT.INFO", env.REDIS_INDEX_NAME])) as unknown[];
    const get = (k: string) => {
      const i = info.findIndex((x) => String(x) === k);
      return i >= 0 ? info[i + 1] : undefined;
    };
    return { numDocs: Number(get("num_docs") ?? 0), indexing: String(get("indexing") ?? "0") === "1" };
  } catch {
    return undefined;
  }
}
