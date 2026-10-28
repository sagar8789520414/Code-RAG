import fs from "node:fs/promises";
import type { Server } from "node:http";
import { env, paths } from "./config/env.js";
import { closeMongo, connectMongo } from "./db/mongo.js";
import { closeRedis, connectRedis } from "./db/redis.js";
import { AST_LANGUAGES } from "./ingestion/languages.js";
import { warmUpParsers } from "./ingestion/parser.js";
import { registerJobHandlers } from "./jobs/handlers.js";
import { jobQueue } from "./jobs/queue.js";
import { errorMessage } from "./lib/errors.js";
import { logger } from "./lib/logger.js";
import { ensureIndex } from "./search/redisIndex.js";
import { createApp } from "./app.js";

let server: Server | undefined;

async function main(): Promise<void> {
  await fs.mkdir(paths.repos, { recursive: true });
  await Promise.all([connectMongo(), connectRedis()]);
  await ensureIndex();
  const grammars = await warmUpParsers(Object.values(AST_LANGUAGES));
  logger.info({ grammars }, "tree-sitter grammars loaded");

  registerJobHandlers();
  jobQueue.start();

  server = createApp().listen(env.PORT, () => logger.info({ port: env.PORT, env: env.NODE_ENV }, "Code RAG API listening"));
  // SSE answers can stream for a while; don't let Node's default timeouts cut them off.
  server.requestTimeout = 0;
  server.headersTimeout = 65_000;
  server.keepAliveTimeout = 61_000;
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  const force = setTimeout(() => process.exit(1), 20_000);
  force.unref();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await jobQueue.stop();
  await Promise.allSettled([closeMongo(), closeRedis()]);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => logger.error({ err: errorMessage(reason) }, "unhandled rejection"));

main().catch((err) => {
  logger.fatal({ err: errorMessage(err) }, "failed to start");
  process.exit(1);
});
