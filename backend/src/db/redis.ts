import { createClient } from "redis";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

export const redis = createClient({
  url: env.REDIS_URL,
  // FT.* reply parsing in search/ expects RESP2's flat arrays; node-redis v6 defaults to RESP3 maps.
  RESP: 2,
  socket: {
    connectTimeout: 10_000,
    reconnectStrategy: (retries) => Math.min(retries * 200, 5_000),
  },
});

let lastErrorLog = 0;
redis.on("error", (err: Error) => {
  // The client emits on every failed reconnect attempt; throttle to keep logs readable.
  if (Date.now() - lastErrorLog > 10_000) {
    lastErrorLog = Date.now();
    logger.error({ err: err.message }, "Redis client error");
  }
});

export type RedisClient = typeof redis;

export async function connectRedis(): Promise<void> {
  await redis.connect();
  const modules = (await redis.sendCommand(["MODULE", "LIST"]).catch(() => [])) as unknown[];
  const hasSearch =
    JSON.stringify(modules).toLowerCase().includes("search") ||
    (await redis
      .sendCommand(["FT._LIST"])
      .then(() => true)
      .catch(() => false));
  if (!hasSearch) {
    throw new Error(
      "Connected Redis does not support RediSearch (FT.* commands). Use Redis 8+, Redis Stack, or Redis Cloud — Upstash and plain Redis 7 OSS are not supported.",
    );
  }
  logger.info("Redis connected (RediSearch available)");
}

export async function pingRedis(): Promise<boolean> {
  try {
    return (await redis.ping()) === "PONG";
  } catch {
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  if (redis.isOpen) await redis.quit();
}
