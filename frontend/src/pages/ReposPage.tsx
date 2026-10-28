import { useMutation, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { GitBranch, Plus, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { Button, Card, EmptyState, ErrorNote, Field, inputClass, ProgressBar, Spinner, StatusBadge } from "../components/ui";
import { api } from "../lib/api";
import { shortSha, timeAgo } from "../lib/format";
import type { Repo } from "../lib/types";
import { useApp } from "../state/AppContext";

function AddRepoForm() {
  const qc = useQueryClient();
  const { selectRepo } = useApp();
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [chunking, setChunking] = useState<"ast" | "fixed">("ast");
  const add = useMutation({
    mutationFn: () => api.addRepo({ url: url.trim(), chunking, ...(branch.trim() ? { branch: branch.trim() } : {}) }),
    onSuccess: ({ repo }) => {
      setUrl("");
      setBranch("");
      selectRepo(repo._id);
      void qc.invalidateQueries({ queryKey: ["repos"] });
    },
  });

  return (
    <Card className="p-4">
      <form
        className="grid gap-3 md:grid-cols-[1fr_10rem_10rem_auto] md:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) add.mutate();
        }}
      >
        <Field label="Git repository URL">
          <input className={inputClass} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/psf/requests" required />
        </Field>
        <Field label="Branch">
          <input className={inputClass} value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="default branch" />
        </Field>
        <Field label="Chunking">
          <select className={inputClass} value={chunking} onChange={(e) => setChunking(e.target.value as "ast" | "fixed")}>
            <option value="ast">AST (Tree-sitter)</option>
            <option value="fixed">Fixed windows (baseline)</option>
          </select>
        </Field>
        <Button type="submit" variant="primary" disabled={add.isPending || !url.trim()}>
          {add.isPending ? <Spinner /> : <Plus className="h-4 w-4" />} Index
        </Button>
      </form>
      <p className="mt-2 text-xs text-slate-500">Index the same repo with both strategies to benchmark AST chunking against the naive baseline.</p>
      {add.error && (
        <div className="mt-3">
          <ErrorNote error={add.error} />
        </div>
      )}
    </Card>
  );
}

function RepoRow({ repo }: { repo: Repo }) {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ["repos"] });
  const sync = useMutation({ mutationFn: (full: boolean) => api.syncRepo(repo._id, full), onSuccess: refresh });
  const del = useMutation({ mutationFn: () => api.deleteRepo(repo._id), onSuccess: refresh });
  const job = repo.activeJob;
  const busy = !!job || repo.status === "indexing";

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`/repos/${repo._id}`} className="truncate font-semibold text-slate-100 hover:text-sky-300">
              {repo.name}
            </Link>
            <StatusBadge status={repo.status} />
            <span className={clsx("rounded px-1.5 py-0.5 text-[10px] font-medium ring-1", repo.chunking === "ast" ? "text-sky-300 ring-sky-500/30" : "text-amber-300 ring-amber-500/30")}>
              {repo.chunking === "ast" ? "AST chunks" : "fixed chunks"}
            </span>
          </div>
          <div className="mt-1 truncate font-mono text-xs text-slate-500">
            {repo.url} <GitBranch className="inline h-3 w-3" /> {repo.branch || "default"} @ {shortSha(repo.lastIndexedCommit)}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
            <span>{repo.stats.files.toLocaleString()} files</span>
            <span>{repo.stats.chunks.toLocaleString()} chunks</span>
            <span>indexed {timeAgo(repo.lastIndexedAt)}</span>
            <span className="truncate">
              {Object.entries(repo.stats.languages)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([l, n]) => `${l} ${n}`)
                .join(" · ")}
            </span>
          </div>
        </div>
        <div className="flex gap-1.5">
          <Button size="sm" onClick={() => sync.mutate(false)} disabled={busy || sync.isPending} title="Incremental sync via git diff">
            <RefreshCw className={clsx("h-3.5 w-3.5", busy && "animate-spin")} /> Sync
          </Button>
          <Button size="sm" variant="ghost" onClick={() => sync.mutate(true)} disabled={busy || sync.isPending} title="Re-chunk every file (embeddings are reused when content is unchanged)">
            <RotateCcw className="h-3.5 w-3.5" /> Full
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={busy || del.isPending}
            onClick={() => {
              if (confirm(`Delete ${repo.name} and all of its indexed data?`)) del.mutate();
            }}
            aria-label="Delete repository"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {job && (
        <div className="mt-3 space-y-1">
          <div className="flex justify-between text-[11px] text-slate-400">
            <span>
              {job.type} · {job.progress.phase}
              {job.progress.message ? ` — ${job.progress.message}` : ""}
            </span>
            <span>{job.status}</span>
          </div>
          <ProgressBar value={job.progress.current} total={job.progress.total} />
        </div>
      )}
      {repo.status === "error" && repo.error && (
        <div className="mt-3">
          <ErrorNote error={repo.error} />
        </div>
      )}
      <ErrorNote error={sync.error ?? del.error} />
    </Card>
  );
}

export function ReposPage() {
  const { repos, reposLoading, reposError } = useApp();
  return (
    <div className="mx-auto max-w-5xl space-y-5 px-5 py-6">
      <div>
        <h1 className="text-lg font-semibold">Repositories</h1>
        <p className="text-sm text-slate-400">Clone, AST-chunk, embed and index a repository. Syncs re-index only what changed since the last indexed commit.</p>
      </div>
      <AddRepoForm />
      <ErrorNote error={reposError} />
      {reposLoading && <Spinner className="h-5 w-5 text-slate-500" />}
      {!reposLoading && !repos.length && !reposError && <EmptyState icon={<GitBranch className="h-10 w-10" />} title="No repositories yet">Add a public GitHub repository above to get started.</EmptyState>}
      <div className="space-y-3">
        {repos.map((r) => (
          <RepoRow key={r._id} repo={r} />
        ))}
      </div>
    </div>
  );
}
