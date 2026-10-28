import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";
import { AppError, BadRequestError } from "../lib/errors.js";
import type { DiffHunk, FileChangeStatus } from "../db/models.js";

const MAX_BUFFER = 256 * 1024 * 1024;

export interface GitRunOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Extra `-c` config for this invocation only (never persisted to .git/config). */
  config?: string[];
}

function baseConfig(): string[] {
  // Only allow transports we expect; blocks `ext::` and other command-executing remotes.
  const cfg = ["protocol.allow=never", "protocol.https.allow=always", "core.quotePath=false", "advice.detachedHead=false"];
  if (env.ALLOW_LOCAL_REPOS) cfg.push("protocol.file.allow=always");
  return cfg;
}

export function git(args: string[], opts: GitRunOptions = {}): Promise<string> {
  const cfg = [...baseConfig(), ...(opts.config ?? [])].flatMap((c) => ["-c", c]);
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...cfg, ...args],
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 10 * 60_000,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo", LC_ALL: "C" },
      },
      (err, stdout, stderr) => {
        if (err) {
          const msg = redactSecrets(String(stderr || err.message).trim()).slice(0, 800);
          reject(new AppError(`git ${args[0]} failed: ${msg}`, 502, "git_error"));
        } else resolve(stdout);
      },
    );
  });
}

function redactSecrets(s: string): string {
  return s.replace(/(https?:\/\/)[^@/\s]+@/g, "$1***@").replace(/(Authorization: Basic )\S+/gi, "$1***");
}

/** Auth header for private GitHub repos; passed per-command so the token never lands on disk. */
function authConfig(url: string): string[] {
  if (!env.GITHUB_TOKEN || !/^https:\/\/github\.com\//i.test(url)) return [];
  const basic = Buffer.from(`x-access-token:${env.GITHUB_TOKEN}`).toString("base64");
  return [`http.https://github.com/.extraHeader=Authorization: Basic ${basic}`];
}

export interface NormalizedRepoUrl {
  url: string;
  name: string;
  isLocal: boolean;
}

export function normalizeRepoUrl(input: string): NormalizedRepoUrl {
  const raw = input.trim();
  if (/^https:\/\//i.test(raw)) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new BadRequestError("Invalid repository URL");
    }
    u.username = "";
    u.password = "";
    u.hash = "";
    u.search = "";
    const clean = u.toString().replace(/\/+$/, "");
    const name = u.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "") || u.hostname;
    return { url: clean, name, isLocal: false };
  }
  if (path.isAbsolute(raw)) {
    if (!env.ALLOW_LOCAL_REPOS) throw new BadRequestError("Local repository paths are disabled (set ALLOW_LOCAL_REPOS=true for development)");
    return { url: path.resolve(raw), name: path.basename(raw), isLocal: true };
  }
  throw new BadRequestError("Repository URL must be an https:// git URL");
}

async function exists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

/**
 * Ensures a partial (blobless) clone exists and is fetched up to the branch tip.
 * Blobless clones keep full history for diffs while only downloading blobs on demand.
 */
export async function syncClone(url: string, dir: string, branch: string | undefined): Promise<{ branch: string; head: string }> {
  const auth = authConfig(url);
  if (!(await exists(path.join(dir, ".git")))) {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(dir), { recursive: true });
    const args = ["clone", "--filter=blob:none", "--no-checkout", "--single-branch"];
    if (branch) args.push("--branch", branch);
    await git([...args, "--", url, dir], { config: auth });
  }
  if (!branch) {
    const ref = (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: dir }).catch(() => "")).trim();
    branch = ref.replace(/^origin\//, "") || (await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir })).trim();
  }
  await git(["fetch", "--prune", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd: dir, config: auth });
  const head = (await git(["rev-parse", `refs/remotes/origin/${branch}^{commit}`], { cwd: dir })).trim();
  await git(["checkout", "--force", "--detach", head], { cwd: dir, config: auth });
  return { branch, head };
}

export async function commitExists(dir: string, sha: string): Promise<boolean> {
  return git(["cat-file", "-e", `${sha}^{commit}`], { cwd: dir })
    .then(() => true)
    .catch(() => false);
}

export interface TreeEntry {
  path: string;
  blobSha: string;
  size: number;
}

/** All blobs in the commit tree (submodules and symlinks excluded). */
export async function listTree(dir: string, sha: string): Promise<Map<string, TreeEntry>> {
  const out = await git(["ls-tree", "-r", "-l", "-z", "--full-tree", sha], { cwd: dir });
  const entries = new Map<string, TreeEntry>();
  for (const rec of out.split("\0")) {
    if (!rec) continue;
    const tab = rec.indexOf("\t");
    const [mode, type, blobSha, size] = rec.slice(0, tab).split(/\s+/);
    if (type !== "blob" || mode === "120000" || !blobSha) continue;
    const p = rec.slice(tab + 1);
    entries.set(p, { path: p, blobSha, size: Number(size) || 0 });
  }
  return entries;
}

export interface CommitInfo {
  sha: string;
  author: string;
  date: Date;
  message: string;
}

export async function commitInfo(dir: string, sha: string): Promise<CommitInfo> {
  const out = await git(["log", "-1", "--format=%H%x00%an%x00%aI%x00%s", sha], { cwd: dir });
  const [full, author, date, message] = out.trim().split("\0");
  return { sha: full ?? sha, author: author ?? "", date: new Date(date ?? Date.now()), message: message ?? "" };
}

export interface FileChange {
  status: FileChangeStatus;
  path: string;
  oldPath?: string;
}

export async function diffNameStatus(dir: string, base: string, head: string): Promise<FileChange[]> {
  return parseNameStatus(await git(["diff", "--name-status", "-z", "-M", base, head], { cwd: dir }));
}

export function parseNameStatus(out: string): FileChange[] {
  const parts = out.split("\0").filter((p) => p !== "");
  const changes: FileChange[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++] as string;
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const oldPath = parts[i++] as string;
      const newPath = parts[i++] as string;
      if (letter === "R") changes.push({ status: "renamed", path: newPath, oldPath });
      else changes.push({ status: "added", path: newPath });
    } else {
      const p = parts[i++] as string;
      if (letter === "A") changes.push({ status: "added", path: p });
      else if (letter === "D") changes.push({ status: "deleted", path: p });
      else changes.push({ status: "modified", path: p }); // M, T, U
    }
  }
  return changes;
}

/** Per-file hunks of `git diff -U0`, keyed by new path (old path for deletions). */
export async function diffHunks(dir: string, base: string, head: string): Promise<Map<string, DiffHunk[]>> {
  const out = await git(["diff", "-U0", "--no-color", "--no-ext-diff", "-M", base, head], { cwd: dir });
  return parseUnifiedDiff(out);
}

export function parseUnifiedDiff(diff: string): Map<string, DiffHunk[]> {
  const result = new Map<string, DiffHunk[]>();
  let oldPath: string | undefined;
  let current: DiffHunk[] | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = undefined;
      oldPath = undefined;
    } else if (line.startsWith("--- ")) {
      oldPath = line === "--- /dev/null" ? undefined : line.slice(4).replace(/^a\//, "");
    } else if (line.startsWith("+++ ")) {
      const newPath = line === "+++ /dev/null" ? oldPath : line.slice(4).replace(/^b\//, "");
      if (newPath) {
        current = result.get(newPath) ?? [];
        result.set(newPath, current);
      }
    } else if (line.startsWith("@@") && current) {
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (m) {
        current.push({
          oldStart: Number(m[1]),
          oldLines: m[2] === undefined ? 1 : Number(m[2]),
          newStart: Number(m[3]),
          newLines: m[4] === undefined ? 1 : Number(m[4]),
        });
      }
    }
  }
  return result;
}
