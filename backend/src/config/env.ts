import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ quiet: true });

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const int = (fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const csv = (fallback: string[]) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === ""
        ? fallback
        : v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
    );

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: int(8080, 1, 65535),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//, "must be a mongodb:// or mongodb+srv:// URI"),
  MONGODB_DB: z.string().min(1).default("code_rag"),

  REDIS_URL: z.string().regex(/^rediss?:\/\//, "must be a redis:// or rediss:// URL"),
  REDIS_INDEX_NAME: z.string().min(1).default("idx:code_chunks"),
  REDIS_KEY_PREFIX: z.string().min(1).default("cr:chunk:"),

  GROQ_API_KEY: z.string().min(20, "GROQ_API_KEY is required"),
  GROQ_BASE_URL: z.string().url().default("https://api.groq.com/openai/v1"),
  GROQ_MODEL: z.string().default("openai/gpt-oss-120b"),
  GROQ_FAST_MODEL: z.string().default("openai/gpt-oss-20b"),
  GROQ_CONTEXT_TOKENS: int(131_072, 4096),
  GROQ_TIMEOUT_MS: int(45_000, 1000),

  GEMINI_API_KEY: z.string().min(20, "GEMINI_API_KEY is required"),
  GEMINI_BASE_URL: z.string().url().default("https://generativelanguage.googleapis.com/v1beta"),
  GEMINI_MODELS: csv(["gemini-flash-latest", "gemini-flash-lite-latest"]),
  GEMINI_FAST_MODELS: csv(["gemini-flash-lite-latest", "gemini-flash-latest"]),
  GEMINI_CONTEXT_TOKENS: int(1_000_000, 4096),
  GEMINI_TIMEOUT_MS: int(60_000, 1000),

  EMBEDDING_MODEL: z.string().default("gemini-embedding-001"),
  EMBEDDING_DIM: int(768, 64, 3072),
  EMBEDDING_BATCH_SIZE: int(50, 1, 100),
  EMBEDDING_CONCURRENCY: int(2, 1, 16),
  // Client-side pacing so indexing stays under the provider quota instead of hitting 429s.
  // Defaults fit the Gemini free tier (30k TPM / 100 RPM); raise them on a paid key.
  EMBEDDING_TPM: int(25_000, 1000),
  EMBEDDING_RPM: int(90, 1),

  CORS_ORIGINS: csv(["http://localhost:5173"]),
  ADMIN_API_KEY: z.string().min(16, "ADMIN_API_KEY must be at least 16 characters").optional().or(z.literal("").transform(() => undefined)),
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),

  DATA_DIR: z.string().default(".data"),
  ALLOW_LOCAL_REPOS: bool(false),
  MAX_FILE_BYTES: int(300_000, 1000),
  MAX_FILES_PER_REPO: int(5000, 1),
  MAX_CHUNK_CHARS: int(3500, 500),

  RRF_K: int(60, 1),
  SEARCH_CANDIDATES: int(50, 5, 500),
  RERANK_TOP_N: int(20, 0, 50),
  RERANK_TIMEOUT_MS: int(10_000, 1000),
  AGENT_MAX_HOPS: int(2, 0, 5),
  AGENT_CONTEXT_CHUNKS: int(14, 2, 60),
  QUERY_RATE_LIMIT_PER_MIN: int(30, 1),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const raw = { ...process.env };
  // Accept the legacy variable name used by the original project.
  raw.REDIS_URL ??= raw.REDIS_URI;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    // Logger depends on env, so this is the one place we write to stderr directly.
    process.stderr.write(`\nInvalid environment configuration:\n${issues}\n\nSee backend/.env.example.\n\n`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = load();

export const paths = {
  data: path.resolve(env.DATA_DIR),
  repos: path.resolve(env.DATA_DIR, "repos"),
};
