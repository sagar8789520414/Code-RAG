import fs from "node:fs/promises";
import path from "node:path";
import { env, paths } from "../config/env.js";
import { collections } from "../db/mongo.js";
import type { ChunkDoc, CommitFileChange, DiffHunk, FileChangeStatus, FileDoc, IndexStats, RepoDoc } from "../db/models.js";
import { embedDocuments, embeddingHash } from "../embeddings/embedder.js";
import { errorMessage, NotFoundError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { chunkArray, identifierTokens, sha1, truncate } from "../lib/text.js";
import { deleteChunks, updateChunkLines, upsertChunks, type ChunkWrite } from "../search/redisIndex.js";
import { chunkAst } from "./astChunker.js";
import type { RawChunk } from "./chunkTypes.js";
import { isBinary, normalizeRepoPath, shouldConsiderPath } from "./fileFilter.js";
import { commitExists, commitInfo, diffHunks, diffNameStatus, listTree, syncClone, type TreeEntry } from "./git.js";
import { strategyForPath } from "./languages.js";
import { chunkFixed, chunkLines, chunkMarkdown } from "./textChunker.js";

export interface IndexProgress {
  phase: string;
  current: number;
  total: number;
  message?: string;
}

export interface IndexContext {
  signal?: AbortSignal;
  progress?: (p: IndexProgress) => void;
}

export interface IndexOutcome {
  mode: "full" | "incremental" | "noop";
  commit: string;
  baseCommit?: string;
  stats: IndexStats;
}

const FILE_GROUP_SIZE = 150;
const MAX_HUNKS_PER_FILE = 300;
const MAX_COMMIT_FILES = 3000;

export const repoDir = (repoId: string) => path.join(paths.repos, repoId);

function emptyStats(): IndexStats {
  return {
    filesScanned: 0,
    filesChanged: 0,
    filesDeleted: 0,
    filesSkipped: 0,
    chunksAdded: 0,
    chunksUpdated: 0,
    chunksRemoved: 0,
    chunksUnchanged: 0,
    embeddingsComputed: 0,
    embeddingsReused: 0,
  };
}

interface PreparedChunk {
  doc: ChunkDoc;
  content: string;
  tokens: string;
  embeddingText: string;
}

/** Text that is embedded. Excludes line numbers so shifted-but-identical code keeps its vector. */
function embeddingTextFor(c: RawChunk, filePath: string, language: string): string {
  const lines = [
    `path: ${filePath}`,
    `language: ${language}`,
    `${c.kind}: ${c.symbolPath}${c.part ? ` (part ${c.part.index}/${c.part.total})` : ""}`,
  ];
  if (c.signature) lines.push(`signature: ${c.signature}`);
  if (c.docstring) lines.push(`doc: ${truncate(c.docstring, 600)}`);
  return `${lines.join("\n")}\n\n${c.content}`;
}

export async function chunkFile(repo: Pick<RepoDoc, "chunking">, filePath: string, source: string): Promise<{ language: string; chunks: RawChunk[] }> {
  const strategy = strategyForPath(filePath);
  if (!strategy) return { language: "unknown", chunks: [] };
  const max = env.MAX_CHUNK_CHARS;
  if (repo.chunking === "fixed") return { language: strategy.language, chunks: chunkFixed(source, filePath, max) };
  if (strategy.kind === "markdown") return { language: strategy.language, chunks: chunkMarkdown(source, filePath, max) };
  if (strategy.kind === "ast") {
    try {
      return { language: strategy.language, chunks: await chunkAst(strategy.spec, source, filePath, { maxChars: max }) };
    } catch (err) {
      logger.warn({ filePath, err: errorMessage(err) }, "AST chunking failed; falling back to line windows");
    }
  }
  return { language: strategy.language, chunks: chunkLines(source, filePath, max) };
}

function prepareChunks(repo: RepoDoc, filePath: string, language: string, raw: RawChunk[], commit: string): PreparedChunk[] {
  const ordinals = new Map<string, number>();
  const now = new Date();
  return raw.map((c) => {
    // Stable identity: same symbol in the same file keeps its id across edits, so a change
    // becomes an in-place upsert. Ordinals disambiguate overloads / repeated module blocks.
    const key = `${c.kind}|${c.symbolPath}|${c.part?.index ?? 0}`;
    const ord = ordinals.get(key) ?? 0;
    ordinals.set(key, ord + 1);
    const id = sha1(`${repo._id}|${filePath}|${key}|${ord}`).slice(0, 24);
    const embeddingText = embeddingTextFor(c, filePath, language);
    return {
      content: c.content,
      tokens: identifierTokens(`${c.symbolPath} ${c.signature} ${c.content}`),
      embeddingText,
      doc: {
        _id: id,
        repoId: repo._id,
        path: filePath,
        language,
        kind: c.kind,
        name: c.name,
        symbolPath: c.symbolPath,
        parentScope: c.parentScope,
        signature: c.signature,
        docstring: c.docstring,
        startLine: c.startLine,
        endLine: c.endLine,
        contentHash: sha1(c.content),
        embeddingHash: embeddingHash(embeddingText),
        commit,
        updatedAt: now,
      },
    };
  });
}

const overlaps = (s: number, e: number, hs: number, he: number) => s <= he && hs <= e;

interface FileWork {
  path: string;
  status: FileChangeStatus;
  oldPath?: string;
  entry?: TreeEntry;
  hunks: DiffHunk[];
}

class RepoIndexer {
  readonly stats = emptyStats();
  readonly changes: CommitFileChange[] = [];
  private readonly dir: string;

  constructor(
    private readonly repo: RepoDoc,
    private readonly commit: string,
    private readonly ctx: IndexContext,
  ) {
    this.dir = repoDir(repo._id);
  }

  private filesDone = 0;
  private filesTotal = 0;

  async process(work: FileWork[]): Promise<void> {
    this.filesTotal = work.length;
    this.ctx.progress?.({ phase: "parsing", current: 0, total: work.length, message: `0/${work.length} files` });
    for (const group of chunkArray(work, FILE_GROUP_SIZE)) {
      this.ctx.signal?.throwIfAborted();
      await this.processGroup(group);
    }
  }

  private async readSource(entry: TreeEntry): Promise<string | undefined> {
    const buf = await fs.readFile(path.join(this.dir, entry.path)).catch(() => undefined);
    if (!buf || isBinary(buf)) return undefined;
    return buf.toString("utf8").replace(/\r\n/g, "\n");
  }

  private async processGroup(group: FileWork[]): Promise<void> {
    const { chunks, files } = collections();
    const removedPaths = group.flatMap((w) => (w.status === "deleted" ? [w.path] : w.status === "renamed" && w.oldPath ? [w.oldPath] : []));
    const livePaths = group.filter((w) => w.status !== "deleted").map((w) => w.path);
    const existing = await chunks.find({ repoId: this.repo._id, path: { $in: [...livePaths, ...removedPaths] } }).toArray();
    const existingByPath = new Map<string, ChunkDoc[]>();
    for (const c of existing) existingByPath.set(c.path, [...(existingByPath.get(c.path) ?? []), c]);

    const toUpsert: PreparedChunk[] = [];
    const lineUpdates: Array<{ id: string; startLine: number; endLine: number }> = [];
    const toDelete: string[] = [];
    const fileDocs: FileDoc[] = [];
    const deletedFilePaths: string[] = [];

    for (const w of group) {
      const change: CommitFileChange = {
        path: w.path,
        ...(w.oldPath ? { oldPath: w.oldPath } : {}),
        status: w.status,
        hunks: w.hunks.slice(0, MAX_HUNKS_PER_FILE),
        touchedChunkIds: [],
        chunks: { added: 0, updated: 0, removed: 0, unchanged: 0 },
      };

      if (w.status === "renamed" && w.oldPath) {
        const old = existingByPath.get(w.oldPath) ?? [];
        toDelete.push(...old.map((c) => c._id));
        change.chunks.removed += old.length;
        deletedFilePaths.push(w.oldPath);
      }

      const prior = existingByPath.get(w.path) ?? [];
      const source = w.status === "deleted" || !w.entry ? undefined : await this.readSource(w.entry);

      if (source === undefined) {
        // Deleted, or no longer indexable (became binary): drop everything for this path.
        if (w.status !== "deleted") this.stats.filesSkipped++;
        else this.stats.filesDeleted++;
        toDelete.push(...prior.map((c) => c._id));
        change.chunks.removed += prior.length;
        change.touchedChunkIds = prior.map((c) => c._id);
        deletedFilePaths.push(w.path);
        this.recordChange(change);
        this.filesDone++;
        continue;
      }

      const { language, chunks: raw } = await chunkFile(this.repo, w.path, source);
      const prepared = prepareChunks(this.repo, w.path, language, raw, this.commit);
      const priorById = new Map(prior.map((c) => [c._id, c]));
      const nextIds = new Set(prepared.map((p) => p.doc._id));

      for (const p of prepared) {
        const before = priorById.get(p.doc._id);
        if (!before) {
          toUpsert.push(p);
          change.chunks.added++;
        } else if (before.embeddingHash !== p.doc.embeddingHash || before.contentHash !== p.doc.contentHash) {
          toUpsert.push(p);
          change.chunks.updated++;
        } else {
          change.chunks.unchanged++;
          if (before.startLine !== p.doc.startLine || before.endLine !== p.doc.endLine) {
            lineUpdates.push({ id: p.doc._id, startLine: p.doc.startLine, endLine: p.doc.endLine });
          }
        }
      }
      const removed = prior.filter((c) => !nextIds.has(c._id));
      toDelete.push(...removed.map((c) => c._id));
      change.chunks.removed += removed.length;

      // Map diff hunks onto chunk ranges: new-side ranges hit current chunks, old-side ranges hit removed ones.
      const touched = new Set<string>();
      for (const h of w.hunks) {
        const ns = h.newStart;
        const ne = h.newStart + Math.max(h.newLines, 1) - 1;
        for (const p of prepared) if (p.doc.kind !== "file" && overlaps(p.doc.startLine, p.doc.endLine, ns, ne)) touched.add(p.doc._id);
        const os = h.oldStart;
        const oe = h.oldStart + Math.max(h.oldLines, 1) - 1;
        for (const c of removed) if (overlaps(c.startLine, c.endLine, os, oe)) touched.add(c._id);
      }
      change.touchedChunkIds = [...touched];

      fileDocs.push({
        _id: `${this.repo._id}:${w.path}`,
        repoId: this.repo._id,
        path: w.path,
        language,
        blobSha: w.entry?.blobSha ?? "",
        size: source.length,
        content: source,
        chunkIds: prepared.map((p) => p.doc._id),
        indexedAt: new Date(),
      });
      this.stats.filesChanged++;
      this.recordChange(change);
      this.filesDone++;
      this.ctx.progress?.({ phase: "parsing", current: this.filesDone, total: this.filesTotal, message: `${this.filesDone}/${this.filesTotal} files · ${w.path}` });
    }

    // Embed only new/changed chunks; the hash cache also absorbs reverts and resumed runs.
    const embedded = await embedDocuments(
      toUpsert.map((p) => ({ hash: p.doc.embeddingHash, text: p.embeddingText })),
      this.ctx.signal,
      (done, total) =>
        this.ctx.progress?.({ phase: "embedding", current: done, total, message: `embedded ${done}/${total} new chunks (files ${this.filesDone}/${this.filesTotal})` }),
    );
    this.stats.embeddingsComputed += embedded.computed;
    this.stats.embeddingsReused += embedded.reused;

    const writes: ChunkWrite[] = toUpsert.map((p) => ({
      id: p.doc._id,
      vector: embedded.vectors.get(p.doc.embeddingHash) as Float32Array,
      fields: {
        repo: this.repo._id,
        path: p.doc.path,
        pathTag: p.doc.path,
        language: p.doc.language,
        kind: p.doc.kind,
        name: p.doc.name,
        nameTag: p.doc.name,
        symbol: p.doc.symbolPath,
        parentScope: p.doc.parentScope,
        signature: p.doc.signature,
        docstring: p.doc.docstring,
        content: p.content,
        tokens: p.tokens,
        startLine: p.doc.startLine,
        endLine: p.doc.endLine,
      },
    }));
    await upsertChunks(writes);
    await updateChunkLines(lineUpdates);
    await deleteChunks(toDelete);

    if (toUpsert.length) {
      await chunks.bulkWrite(
        toUpsert.map((p) => ({ replaceOne: { filter: { _id: p.doc._id }, replacement: p.doc, upsert: true } })),
        { ordered: false },
      );
    }
    if (lineUpdates.length) {
      await chunks.bulkWrite(
        lineUpdates.map((u) => ({ updateOne: { filter: { _id: u.id }, update: { $set: { startLine: u.startLine, endLine: u.endLine, commit: this.commit } } } })),
        { ordered: false },
      );
    }
    if (toDelete.length) await chunks.deleteMany({ _id: { $in: toDelete } });
    if (fileDocs.length) {
      await files.bulkWrite(
        fileDocs.map((f) => ({ replaceOne: { filter: { _id: f._id }, replacement: f, upsert: true } })),
        { ordered: false },
      );
    }
    const stillLive = new Set(fileDocs.map((f) => f.path));
    const gone = deletedFilePaths.filter((p) => !stillLive.has(p));
    if (gone.length) await files.deleteMany({ repoId: this.repo._id, path: { $in: gone } });
  }

  private recordChange(change: CommitFileChange): void {
    this.stats.chunksAdded += change.chunks.added;
    this.stats.chunksUpdated += change.chunks.updated;
    this.stats.chunksRemoved += change.chunks.removed;
    this.stats.chunksUnchanged += change.chunks.unchanged;
    if (this.changes.length < MAX_COMMIT_FILES) this.changes.push(change);
  }
}

function indexableEntries(tree: Map<string, TreeEntry>, stats: IndexStats): TreeEntry[] {
  const out: TreeEntry[] = [];
  for (const entry of tree.values()) {
    const p = normalizeRepoPath(entry.path);
    if (shouldConsiderPath(p, entry.size, env.MAX_FILE_BYTES)) {
      stats.filesSkipped++;
      continue;
    }
    out.push({ ...entry, path: p });
  }
  return out;
}

/**
 * Brings the index for `repoId` up to date with its branch tip.
 *
 * - First run, `full: true`, a force-push that removed the base commit, or a chunking change:
 *   full pass over the tree. Files whose blob sha is unchanged are still skipped.
 * - Otherwise: incremental. `git diff --name-status -M base..head` selects added/modified/
 *   renamed/deleted files and `git diff -U0` supplies hunks; only those files are re-parsed,
 *   and within them only chunks whose content changed are re-embedded and upserted.
 */
export async function indexRepository(repoId: string, opts: { full?: boolean }, ctx: IndexContext = {}): Promise<IndexOutcome> {
  const { repos, files, commits, chunks } = collections();
  const repo = await repos.findOne({ _id: repoId });
  if (!repo) throw new NotFoundError("Repository");
  const started = Date.now();
  await repos.updateOne({ _id: repoId }, { $set: { status: "indexing", updatedAt: new Date() }, $unset: { error: "" } });

  try {
    ctx.progress?.({ phase: "fetching", current: 0, total: 0, message: "Syncing git clone" });
    const dir = repoDir(repoId);
    const { branch, head } = await syncClone(repo.url, dir, repo.branch || undefined);
    if (branch !== repo.branch) await repos.updateOne({ _id: repoId }, { $set: { branch } });

    const base = repo.lastIndexedCommit;
    if (base === head && !opts.full) {
      await repos.updateOne({ _id: repoId }, { $set: { status: "ready", updatedAt: new Date() } });
      return { mode: "noop", commit: head, baseCommit: base, stats: emptyStats() };
    }

    const indexer = new RepoIndexer(repo, head, ctx);
    const tree = await listTree(dir, head);
    const incremental = !opts.full && !!base && (await commitExists(dir, base));
    let work: FileWork[];

    if (incremental) {
      ctx.progress?.({ phase: "diffing", current: 0, total: 0, message: `Diffing ${base!.slice(0, 7)}..${head.slice(0, 7)}` });
      const [changes, hunks] = await Promise.all([diffNameStatus(dir, base!, head), diffHunks(dir, base!, head)]);
      work = [];
      for (const ch of changes) {
        const p = normalizeRepoPath(ch.path);
        const entry = tree.get(ch.path);
        const indexable = entry && !shouldConsiderPath(p, entry.size, env.MAX_FILE_BYTES);
        indexer.stats.filesScanned++;
        if (ch.status === "deleted" || !indexable) {
          // A file that stopped being indexable is treated as deleted from the index.
          work.push({ path: p, status: "deleted", hunks: hunks.get(ch.path) ?? [] });
          if (ch.status === "renamed" && ch.oldPath) work.push({ path: normalizeRepoPath(ch.oldPath), status: "deleted", hunks: [] });
          continue;
        }
        work.push({
          path: p,
          status: ch.status,
          ...(ch.oldPath ? { oldPath: normalizeRepoPath(ch.oldPath) } : {}),
          entry: { ...entry, path: ch.path },
          hunks: hunks.get(ch.path) ?? [],
        });
      }
    } else {
      const entries = indexableEntries(tree, indexer.stats);
      if (entries.length > env.MAX_FILES_PER_REPO) {
        throw new Error(`Repository has ${entries.length} indexable files; limit is MAX_FILES_PER_REPO=${env.MAX_FILES_PER_REPO}`);
      }
      indexer.stats.filesScanned = entries.length;
      const known = await files.find({ repoId }, { projection: { path: 1, blobSha: 1 } }).toArray();
      const knownSha = new Map(known.map((f) => [f.path, f.blobSha]));
      // A forced full pass re-chunks everything (e.g. after a chunker upgrade); otherwise
      // unchanged blobs are skipped, which keeps recovery from a force-push cheap.
      const forceAll = !!opts.full;
      work = entries
        .filter((e) => forceAll || knownSha.get(e.path) !== e.blobSha)
        .map((e) => ({ path: e.path, status: knownSha.has(e.path) ? ("modified" as const) : ("added" as const), entry: e, hunks: [] }));
      const live = new Set(entries.map((e) => e.path));
      for (const f of known) if (!live.has(f.path)) work.push({ path: f.path, status: "deleted", hunks: [] });
    }

    await indexer.process(work);

    const info = await commitInfo(dir, head);
    const [fileCount, chunkCount, langAgg] = await Promise.all([
      files.countDocuments({ repoId }),
      chunks.countDocuments({ repoId }),
      files.aggregate<{ _id: string; n: number }>([{ $match: { repoId } }, { $group: { _id: "$language", n: { $sum: 1 } } }]).toArray(),
    ]);
    const mode = incremental ? "incremental" : "full";
    await commits.replaceOne(
      { _id: `${repoId}:${head}` },
      {
        repoId,
        sha: head,
        ...(base ? { baseSha: base } : {}),
        message: info.message,
        author: info.author,
        committedAt: info.date,
        mode,
        files: indexer.changes,
        stats: indexer.stats,
        durationMs: Date.now() - started,
        indexedAt: new Date(),
      },
      { upsert: true },
    );
    await repos.updateOne(
      { _id: repoId },
      {
        $set: {
          status: "ready",
          lastIndexedCommit: head,
          lastIndexedAt: new Date(),
          stats: { files: fileCount, chunks: chunkCount, languages: Object.fromEntries(langAgg.map((l) => [l._id, l.n])) },
          updatedAt: new Date(),
        },
      },
    );
    logger.info({ repoId, mode, head: head.slice(0, 10), stats: indexer.stats, ms: Date.now() - started }, "repository indexed");
    return { mode, commit: head, ...(base ? { baseCommit: base } : {}), stats: indexer.stats };
  } catch (err) {
    await repos.updateOne({ _id: repoId }, { $set: { status: "error", error: errorMessage(err).slice(0, 1000), updatedAt: new Date() } });
    throw err;
  }
}

/** Removes every trace of a repository from Redis, Mongo, and disk. */
export async function purgeRepository(repoId: string): Promise<void> {
  const { repos, files, chunks, commits, jobs, queries, benchmarks } = collections();
  const ids = await chunks.find({ repoId }, { projection: { _id: 1 } }).map((c) => c._id).toArray();
  await deleteChunks(ids);
  await Promise.all([
    chunks.deleteMany({ repoId }),
    files.deleteMany({ repoId }),
    commits.deleteMany({ repoId }),
    jobs.deleteMany({ repoId, status: { $ne: "running" } }),
    queries.deleteMany({ repoId }),
    benchmarks.deleteMany({ repoId }),
    repos.deleteOne({ _id: repoId }),
  ]);
  await fs.rm(repoDir(repoId), { recursive: true, force: true });
}
