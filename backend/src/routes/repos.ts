import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { collections } from "../db/mongo.js";
import type { RepoDoc } from "../db/models.js";
import { normalizeRepoUrl } from "../ingestion/git.js";
import { purgeRepository } from "../ingestion/indexer.js";
import { normalizeRepoPath } from "../ingestion/fileFilter.js";
import { jobQueue } from "../jobs/queue.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";
import { parseBody, parseQuery, requireAdmin } from "../middleware/common.js";
import { hydrate } from "../search/hybrid.js";

export const reposRouter = Router();

const createSchema = z.object({
  url: z.string().min(3).max(500),
  branch: z
    .string()
    .max(200)
    .regex(/^[\w./-]+$/, "invalid branch name")
    .refine((b) => !b.startsWith("-") && !b.includes(".."), "invalid branch name")
    .optional(),
  name: z.string().min(1).max(120).optional(),
  chunking: z.enum(["ast", "fixed"]).default("ast"),
});

async function getRepo(id: string): Promise<RepoDoc> {
  const repo = await collections().repos.findOne({ _id: id });
  if (!repo) throw new NotFoundError("Repository");
  return repo;
}

reposRouter.get("/", async (_req, res) => {
  const { repos, jobs } = collections();
  const list = await repos.find().sort({ createdAt: -1 }).toArray();
  const active = await jobs.find({ repoId: { $in: list.map((r) => r._id) }, status: { $in: ["queued", "running"] } }).toArray();
  res.json({ repos: list.map((r) => ({ ...r, activeJob: active.find((j) => j.repoId === r._id && j.type !== "benchmark") ?? null })) });
});

reposRouter.post("/", requireAdmin, async (req, res) => {
  const body = parseBody(createSchema, req);
  const { url, name } = normalizeRepoUrl(body.url);
  const { repos } = collections();
  const dup = await repos.findOne({ url, chunking: body.chunking, ...(body.branch ? { branch: body.branch } : {}) });
  if (dup) throw new ConflictError(`Repository already registered as ${dup._id}`);
  const now = new Date();
  const repo: RepoDoc = {
    _id: crypto.randomBytes(6).toString("hex"),
    name: body.name ?? (body.chunking === "fixed" ? `${name} (fixed chunks)` : name),
    url,
    branch: body.branch ?? "",
    chunking: body.chunking,
    status: "pending",
    stats: { files: 0, chunks: 0, languages: {} },
    createdAt: now,
    updatedAt: now,
  };
  await repos.insertOne(repo);
  const job = await jobQueue.enqueue("index", repo._id);
  res.status(202).json({ repo, job });
});

reposRouter.get("/:id", async (req, res) => {
  const repo = await getRepo(req.params.id);
  const { jobs, commits } = collections();
  const [recentJobs, recentCommits] = await Promise.all([
    jobs.find({ repoId: repo._id }, { projection: { payload: 0 } }).sort({ createdAt: -1 }).limit(10).toArray(),
    commits.find({ repoId: repo._id }, { projection: { files: 0 } }).sort({ indexedAt: -1 }).limit(10).toArray(),
  ]);
  res.json({ repo, jobs: recentJobs, commits: recentCommits });
});

reposRouter.post("/:id/sync", requireAdmin, async (req, res) => {
  const repo = await getRepo(String(req.params.id));
  const { full } = parseBody(z.object({ full: z.boolean().default(false) }), req);
  const job = await jobQueue.enqueue(full ? "index" : "sync", repo._id, { full }, { dedupe: true });
  res.status(202).json({ job });
});

reposRouter.delete("/:id", requireAdmin, async (req, res) => {
  const repo = await getRepo(String(req.params.id));
  const running = await collections().jobs.findOne({ repoId: repo._id, status: "running" });
  if (running) throw new ConflictError("A job is running for this repository; wait for it to finish");
  await collections().jobs.deleteMany({ repoId: repo._id, status: "queued" });
  await purgeRepository(repo._id);
  res.status(204).end();
});

reposRouter.get("/:id/tree", async (req, res) => {
  const repo = await getRepo(req.params.id);
  const files = await collections()
    .files.find({ repoId: repo._id }, { projection: { path: 1, language: 1, size: 1, chunkIds: 1 } })
    .sort({ path: 1 })
    .toArray();
  res.json({ files: files.map((f) => ({ path: f.path, language: f.language, size: f.size, chunks: f.chunkIds.length })) });
});

reposRouter.get("/:id/file", async (req, res) => {
  const repo = await getRepo(req.params.id);
  const { path } = parseQuery(z.object({ path: z.string().min(1).max(1000) }), req);
  const p = normalizeRepoPath(path);
  const { files, chunks } = collections();
  const file = await files.findOne({ repoId: repo._id, path: p });
  if (!file) throw new NotFoundError(`File ${p}`);
  const fileChunks = await chunks
    .find({ repoId: repo._id, path: p }, { projection: { kind: 1, name: 1, symbolPath: 1, startLine: 1, endLine: 1, signature: 1 } })
    .sort({ startLine: 1 })
    .toArray();
  res.json({
    path: file.path,
    language: file.language,
    size: file.size,
    commit: repo.lastIndexedCommit,
    content: file.content,
    chunks: fileChunks.map((c) => ({ id: c._id, kind: c.kind, name: c.name, symbolPath: c.symbolPath, signature: c.signature, startLine: c.startLine, endLine: c.endLine })),
  });
});

reposRouter.get("/:id/chunks/:chunkId", async (req, res) => {
  const repo = await getRepo(req.params.id);
  const meta = await collections().chunks.findOne({ _id: req.params.chunkId, repoId: repo._id });
  if (!meta) throw new NotFoundError("Chunk");
  const hit = (await hydrate([meta._id])).get(meta._id);
  res.json({ ...meta, content: hit?.content ?? null });
});

reposRouter.get("/:id/commits", async (req, res) => {
  const repo = await getRepo(req.params.id);
  const { limit } = parseQuery(z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }), req);
  const list = await collections()
    .commits.find({ repoId: repo._id })
    .sort({ indexedAt: -1 })
    .limit(limit)
    .toArray();
  res.json({
    commits: list.map((c) => ({
      ...c,
      // Hunk-level detail is only needed in the per-commit view.
      files: c.files.slice(0, 200).map((f) => ({ path: f.path, oldPath: f.oldPath, status: f.status, hunks: f.hunks.length, touchedChunks: f.touchedChunkIds.length, chunks: f.chunks })),
      filesTruncated: c.files.length > 200,
    })),
  });
});

reposRouter.get("/:id/commits/:sha", async (req, res) => {
  const repo = await getRepo(req.params.id);
  const commit = await collections().commits.findOne({ repoId: repo._id, sha: req.params.sha });
  if (!commit) throw new NotFoundError("Commit");
  res.json(commit);
});
