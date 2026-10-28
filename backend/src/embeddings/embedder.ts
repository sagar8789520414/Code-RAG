import { Binary } from "mongodb";
import { env } from "../config/env.js";
import { collections } from "../db/mongo.js";
import { ProviderError } from "../lib/errors.js";
import { providerFetch, retry, sleep } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { chunkArray, mapLimit, sha1 } from "../lib/text.js";

/** gemini-embedding-001 accepts up to 2048 input tokens; stay safely under it. */
const MAX_INPUT_CHARS = 6000;
/** Conservative chars→tokens for code (denser than prose). Used only for pacing. */
const estimate = (text: string) => Math.ceil(Math.min(text.length, MAX_INPUT_CHARS) / 3);

export type EmbeddingTask = "RETRIEVAL_DOCUMENT" | "CODE_RETRIEVAL_QUERY" | "RETRIEVAL_QUERY";

function normalize(values: number[]): Float32Array {
  const v = Float32Array.from(values);
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  // Truncated (MRL) gemini embeddings are not unit length; cosine/IP scoring needs them to be.
  for (let i = 0; i < v.length; i++) v[i] = (v[i] as number) / norm;
  return v;
}

/** Continuous-refill budget (token bucket) with one minute of burst capacity. */
class MinuteBudget {
  private available: number;
  private last = Date.now();
  constructor(private readonly perMinute: number) {
    this.available = perMinute;
  }
  async take(amount: number, signal?: AbortSignal): Promise<void> {
    const need = Math.min(amount, this.perMinute);
    for (;;) {
      const now = Date.now();
      this.available = Math.min(this.perMinute, this.available + ((now - this.last) / 60_000) * this.perMinute);
      this.last = now;
      if (this.available >= need) {
        this.available -= need;
        return;
      }
      await sleep(Math.ceil(((need - this.available) / this.perMinute) * 60_000), signal);
    }
  }
}

const tokenBudget = new MinuteBudget(env.EMBEDDING_TPM);
const requestBudget = new MinuteBudget(env.EMBEDDING_RPM);

const isRetryable = (err: unknown) => err instanceof ProviderError && err.countsAgainstHealth && err.kind !== "auth";

async function callBatch(texts: string[], task: EmbeddingTask, signal?: AbortSignal, interactive = false): Promise<Float32Array[]> {
  const model = `models/${env.EMBEDDING_MODEL}`;
  const tokens = texts.reduce((n, t) => n + estimate(t), 0);
  // Interactive queries fail fast (search degrades to BM25); bulk indexing waits out quotas.
  const retryPolicy = interactive ? { retries: 2, baseDelayMs: 300, maxDelayMs: 2000 } : { retries: 10, baseDelayMs: 2000, maxDelayMs: 90_000 };
  return retry(
    async () => {
      await requestBudget.take(1, signal);
      await tokenBudget.take(tokens, signal);
      const res = await providerFetch("gemini-embeddings", `${env.GEMINI_BASE_URL}/${model}:batchEmbedContents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
          requests: texts.map((text) => ({
            model,
            content: { parts: [{ text: text.slice(0, MAX_INPUT_CHARS) }] },
            taskType: task,
            outputDimensionality: env.EMBEDDING_DIM,
          })),
        }),
        timeoutMs: 60_000,
        callerSignal: signal,
      });
      const json = (await res.json()) as { embeddings?: Array<{ values: number[] }> };
      if (!json.embeddings || json.embeddings.length !== texts.length) {
        throw new ProviderError("gemini-embeddings", "server_error", `expected ${texts.length} embeddings, got ${json.embeddings?.length ?? 0}`);
      }
      return json.embeddings.map((e) => {
        if (e.values.length !== env.EMBEDDING_DIM) {
          throw new ProviderError("gemini-embeddings", "bad_request", `embedding has ${e.values.length} dims, expected ${env.EMBEDDING_DIM}`);
        }
        return normalize(e.values);
      });
    },
    {
      ...retryPolicy,
      signal,
      shouldRetry: isRetryable,
      onRetry: (err, attempt, delay) => logger.warn({ attempt, delayMs: Math.round(delay), err: (err as Error).message.slice(0, 160) }, "embedding batch retry"),
    },
  );
}

/** Groups texts into batches bounded by item count and by a share of the per-minute token budget. */
function tokenAwareBatches(hashes: string[], texts: Map<string, string>): string[][] {
  const maxTokens = Math.max(2000, Math.floor(env.EMBEDDING_TPM / 3));
  const batches: string[][] = [];
  let current: string[] = [];
  let tokens = 0;
  for (const h of hashes) {
    const t = estimate(texts.get(h) ?? "");
    if (current.length && (current.length >= env.EMBEDDING_BATCH_SIZE || tokens + t > maxTokens)) {
      batches.push(current);
      current = [];
      tokens = 0;
    }
    current.push(h);
    tokens += t;
  }
  if (current.length) batches.push(current);
  return batches;
}

const cacheKey = (hash: string) => `${env.EMBEDDING_MODEL}:${env.EMBEDDING_DIM}:${hash}`;

export const embeddingHash = (text: string) => sha1(text);

export interface EmbedResult {
  vectors: Map<string, Float32Array>;
  computed: number;
  reused: number;
}

/**
 * Embeds documents keyed by content hash. Vectors already in the Mongo cache are reused,
 * so identical embedded text is never sent to the embedding API twice — and an indexing
 * run that dies mid-way resumes where it stopped, since each batch is cached on arrival.
 */
export async function embedDocuments(items: Array<{ hash: string; text: string }>, signal?: AbortSignal, onProgress?: (done: number, total: number) => void): Promise<EmbedResult> {
  const unique = new Map<string, string>();
  for (const it of items) unique.set(it.hash, it.text);
  const vectors = new Map<string, Float32Array>();
  const { embeddings } = collections();

  const hashes = [...unique.keys()];
  for (const group of chunkArray(hashes, 1000)) {
    const cached = await embeddings.find({ _id: { $in: group.map(cacheKey) } }).toArray();
    for (const doc of cached) {
      const buf = doc.vector.buffer;
      const vec = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      if (vec.length === env.EMBEDDING_DIM) vectors.set(doc._id.slice(doc._id.lastIndexOf(":") + 1), vec);
    }
  }

  const missing = hashes.filter((h) => !vectors.has(h));
  const reused = hashes.length - missing.length;
  // One failed batch cancels its siblings instead of letting them keep burning quota.
  const local = new AbortController();
  const batchSignal = signal ? AbortSignal.any([signal, local.signal]) : local.signal;
  let done = 0;
  try {
    await mapLimit(tokenAwareBatches(missing, unique), env.EMBEDDING_CONCURRENCY, async (batch) => {
      batchSignal.throwIfAborted();
      const out = await callBatch(
        batch.map((h) => unique.get(h) as string),
        "RETRIEVAL_DOCUMENT",
        batchSignal,
      );
      const now = new Date();
      await embeddings.bulkWrite(
        batch.map((h, i) => {
          const v = out[i] as Float32Array;
          vectors.set(h, v);
          return {
            replaceOne: {
              filter: { _id: cacheKey(h) },
              replacement: { vector: new Binary(Buffer.from(v.buffer, v.byteOffset, v.byteLength)), createdAt: now },
              upsert: true,
            },
          };
        }),
        { ordered: false },
      );
      done += batch.length;
      onProgress?.(done, missing.length);
    });
  } catch (err) {
    local.abort(err);
    throw err;
  }

  return { vectors, computed: missing.length, reused };
}

const queryCache = new Map<string, Float32Array>();
const QUERY_CACHE_MAX = 500;

export async function embedQuery(text: string, signal?: AbortSignal): Promise<Float32Array> {
  const key = text.trim().toLowerCase();
  const hit = queryCache.get(key);
  if (hit) return hit;
  const [vec] = await callBatch([text], "CODE_RETRIEVAL_QUERY", signal, true);
  if (queryCache.size >= QUERY_CACHE_MAX) queryCache.delete(queryCache.keys().next().value as string);
  queryCache.set(key, vec as Float32Array);
  return vec as Float32Array;
}

export function vectorToBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
