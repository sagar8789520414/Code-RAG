import cors from "cors";
import express, { type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { errorHandler, notFound } from "./middleware/common.js";
import { benchmarksRouter } from "./routes/benchmarks.js";
import { queryRouter } from "./routes/query.js";
import { reposRouter } from "./routes/repos.js";
import { searchRouter } from "./routes/search.js";
import { systemRouter } from "./routes/system.js";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1); // Render / Netlify sit behind one proxy hop
  app.disable("x-powered-by");

  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  const allowAll = env.CORS_ORIGINS.includes("*");
  app.use(
    cors({
      origin: allowAll ? true : env.CORS_ORIGINS,
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "x-api-key"],
      maxAge: 86_400,
    }),
  );
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === "/api/health" },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"),
      serializers: { req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url }), res: (res: { statusCode: number }) => ({ status: res.statusCode }) },
    }),
  );

  // Webhooks need the raw body for HMAC verification, so JSON parsing skips them.
  const json = express.json({ limit: "4mb" });
  const jsonUnlessWebhook: RequestHandler = (req, res, next) => (req.path.startsWith("/api/webhooks/") ? next() : json(req, res, next));
  app.use(jsonUnlessWebhook);

  const llmLimiter = rateLimit({
    windowMs: 60_000,
    limit: env.QUERY_RATE_LIMIT_PER_MIN,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: { code: "rate_limited", message: "Too many requests, slow down." } },
  });

  app.get("/", (_req, res) => res.json({ name: "code-rag-api", docs: "/api/health" }));
  app.use("/api", systemRouter);
  app.use("/api/repos", reposRouter);
  app.use("/api", llmLimiter, queryRouter);
  app.use("/api", llmLimiter, searchRouter);
  app.use("/api/benchmarks", benchmarksRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
