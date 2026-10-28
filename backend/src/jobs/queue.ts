import crypto from "node:crypto";
import os from "node:os";
import { collections } from "../db/mongo.js";
import type { JobDoc, JobType } from "../db/models.js";
import { errorMessage } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

export interface JobContext {
  job: JobDoc;
  signal: AbortSignal;
  progress: (p: JobDoc["progress"]) => void;
}

export type JobHandler = (ctx: JobContext) => Promise<Record<string, unknown>>;

const POLL_MS = 1500;
const HEARTBEAT_MS = 10_000;
const STALE_MS = 2 * 60_000;
const MAX_ATTEMPTS = 3;

/**
 * Durable job queue on MongoDB. Jobs are claimed atomically with findOneAndUpdate, so
 * several API instances can share one queue; at most one job per repository runs at once.
 * Running jobs heartbeat; jobs whose worker died are re-queued (up to MAX_ATTEMPTS).
 */
export class JobQueue {
  private readonly handlers = new Map<JobType, JobHandler>();
  private readonly workerId = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString("hex")}`;
  private timer?: NodeJS.Timeout;
  private running?: { job: JobDoc; abort: AbortController; done: Promise<void> };
  private stopped = true;

  register(type: JobType, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  async enqueue(type: JobType, repoId: string, payload: Record<string, unknown> = {}, opts: { dedupe?: boolean } = {}): Promise<JobDoc> {
    const { jobs } = collections();
    if (opts.dedupe) {
      const pending = await jobs.findOne({ type, repoId, status: "queued" });
      if (pending) return pending;
    }
    const job: JobDoc = {
      _id: crypto.randomUUID(),
      type,
      repoId,
      status: "queued",
      payload,
      progress: { phase: "queued", current: 0, total: 0 },
      attempts: 0,
      createdAt: new Date(),
    };
    await jobs.insertOne(job);
    this.kick();
    return job;
  }

  start(): void {
    this.stopped = false;
    void this.recoverStale();
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.running) {
      this.running.abort.abort(new Error("server shutting down"));
      await this.running.done.catch(() => undefined);
    }
  }

  isBusy(): boolean {
    return !!this.running;
  }

  private kick(): void {
    if (!this.running && !this.stopped) this.schedule(0);
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async recoverStale(): Promise<void> {
    const { jobs } = collections();
    const cutoff = new Date(Date.now() - STALE_MS);
    const stale = await jobs.find({ status: "running", heartbeatAt: { $lt: cutoff } }).toArray();
    for (const j of stale) {
      const exhausted = j.attempts >= MAX_ATTEMPTS;
      await jobs.updateOne(
        { _id: j._id, status: "running" },
        exhausted
          ? { $set: { status: "failed", error: "worker died repeatedly", finishedAt: new Date() } }
          : { $set: { status: "queued", progress: { phase: "requeued", current: 0, total: 0 } }, $unset: { lockedBy: "" } },
      );
      logger.warn({ jobId: j._id, exhausted }, "recovered stale job");
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.running) return;
    try {
      const { jobs } = collections();
      const busyRepos = await jobs.distinct("repoId", { status: "running" });
      const job = await jobs.findOneAndUpdate(
        { status: "queued", repoId: { $nin: busyRepos }, type: { $in: [...this.handlers.keys()] } },
        { $set: { status: "running", lockedBy: this.workerId, startedAt: new Date(), heartbeatAt: new Date() }, $inc: { attempts: 1 } },
        { sort: { createdAt: 1 }, returnDocument: "after" },
      );
      if (job) {
        const abort = new AbortController();
        const done = this.execute(job, abort.signal);
        this.running = { job, abort, done };
        await done;
        this.running = undefined;
        return this.schedule(0);
      }
    } catch (err) {
      logger.error({ err: errorMessage(err) }, "job queue tick failed");
    }
    this.schedule(POLL_MS);
  }

  private async execute(job: JobDoc, signal: AbortSignal): Promise<void> {
    const { jobs } = collections();
    const handler = this.handlers.get(job.type) as JobHandler;
    let lastWrite = 0;
    let pending: JobDoc["progress"] | undefined;
    const flush = async () => {
      if (!pending) return;
      const p = pending;
      pending = undefined;
      lastWrite = Date.now();
      await jobs.updateOne({ _id: job._id }, { $set: { progress: p, heartbeatAt: new Date() } }).catch(() => undefined);
    };
    const heartbeat = setInterval(() => {
      void jobs.updateOne({ _id: job._id }, { $set: { heartbeatAt: new Date() } }).catch(() => undefined);
    }, HEARTBEAT_MS);

    logger.info({ jobId: job._id, type: job.type, repoId: job.repoId }, "job started");
    try {
      const result = await handler({
        job,
        signal,
        progress: (p) => {
          pending = p;
          if (Date.now() - lastWrite > 500) void flush();
        },
      });
      await flush();
      await jobs.updateOne(
        { _id: job._id },
        { $set: { status: "completed", result, finishedAt: new Date(), progress: { phase: "done", current: 1, total: 1 } } },
      );
      logger.info({ jobId: job._id, type: job.type }, "job completed");
    } catch (err) {
      const shuttingDown = signal.aborted && this.stopped;
      await jobs.updateOne(
        { _id: job._id },
        shuttingDown
          ? { $set: { status: "queued", progress: { phase: "requeued", current: 0, total: 0 } }, $unset: { lockedBy: "" } }
          : { $set: { status: "failed", error: errorMessage(err).slice(0, 2000), finishedAt: new Date() } },
      );
      if (!shuttingDown) logger.error({ jobId: job._id, err: errorMessage(err) }, "job failed");
    } finally {
      clearInterval(heartbeat);
    }
  }
}

export const jobQueue = new JobQueue();
