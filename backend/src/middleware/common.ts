import crypto from "node:crypto";
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import { ZodError, type ZodType } from "zod";
import { env } from "../config/env.js";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

/** Mutating endpoints (index, sync, delete, benchmark) require `x-api-key` when ADMIN_API_KEY is set. */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!env.ADMIN_API_KEY) return next();
  const given = req.header("x-api-key") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(env.ADMIN_API_KEY);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  next(new AppError("Missing or invalid x-api-key", 401, "unauthorized"));
};

export function parseBody<T>(schema: ZodType<T>, req: Request): T {
  return schema.parse(req.body ?? {});
}

export function parseQuery<T>(schema: ZodType<T>, req: Request): T {
  return schema.parse(req.query ?? {});
}

export const notFound: RequestHandler = (req, _res, next) => next(new AppError(`No route for ${req.method} ${req.path}`, 404, "not_found"));

export const errorHandler: ErrorRequestHandler = (err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return;
  if (err instanceof ZodError) {
    res.status(400).json({ error: { code: "validation_error", message: "Invalid request", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } });
    return;
  }
  if (err instanceof AppError) {
    if (err.status >= 500) logger.error({ err: err.message, path: req.path }, "request failed");
    res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    return;
  }
  if (err instanceof SyntaxError && "body" in (err as object)) {
    res.status(400).json({ error: { code: "invalid_json", message: "Malformed JSON body" } });
    return;
  }
  logger.error({ err: err instanceof Error ? { message: err.message, stack: err.stack } : err, path: req.path }, "unhandled error");
  res.status(500).json({ error: { code: "internal_error", message: env.NODE_ENV === "production" ? "Internal server error" : String((err as Error)?.message ?? err) } });
};

/** Server-Sent Events over a POST response (EventSource is GET-only, so clients read the stream with fetch). */
export class SseStream {
  private closed = false;
  private readonly keepAlive: NodeJS.Timeout;

  constructor(private readonly res: Response) {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // disable proxy buffering (Render / nginx)
    res.flushHeaders();
    this.keepAlive = setInterval(() => this.comment("keep-alive"), 15_000);
    res.on("close", () => this.close());
  }

  send(event: string, data: unknown): void {
    if (this.closed) return;
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  comment(text: string): void {
    if (!this.closed) this.res.write(`: ${text}\n\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.keepAlive);
    this.res.end();
  }
}
