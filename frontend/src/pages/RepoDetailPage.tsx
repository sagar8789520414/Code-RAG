import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeft, ChevronRight, FileCode2, GitCommit } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { Badge, Card, ErrorNote, inputClass, Spinner, StatusBadge } from "../components/ui";
import { api } from "../lib/api";
import { ms, shortSha, timeAgo } from "../lib/format";
import type { Commit } from "../lib/types";
import { useApp } from "../state/AppContext";

const statusColor: Record<string, string> = {
  added: "text-emerald-300",
  modified: "text-sky-300",
  deleted: "text-rose-300",
  renamed: "text-amber-300",
};

function CommitCard({ c }: { c: Commit }) {
  const [open, setOpen] = useState(false);
  const s = c.stats;
  return (
    <Card>
      <button className="flex w-full items-start gap-3 px-4 py-3 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <GitCommit className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-sky-300">{shortSha(c.sha)}</span>
            {c.baseSha && <span className="font-mono text-[11px] text-slate-500">from {shortSha(c.baseSha)}</span>}
            <Badge className={c.mode === "incremental" ? "bg-violet-500/10 text-violet-300 ring-violet-500/30" : undefined}>{c.mode}</Badge>
            <span className="truncate text-sm text-slate-200">{c.message}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
            <span>{s.filesChanged} files re-parsed</span>
            {s.filesDeleted > 0 && <span>{s.filesDeleted} deleted</span>}
            <span className="text-emerald-300/80">+{s.chunksAdded} chunks</span>
            <span className="text-sky-300/80">~{s.chunksUpdated} updated</span>
            <span className="text-rose-300/80">−{s.chunksRemoved} removed</span>
            <span>{s.chunksUnchanged} unchanged</span>
            <span>
              {s.embeddingsComputed} embedded / {s.embeddingsReused} reused
            </span>
            <span>{ms(c.durationMs)}</span>
            <span>
              {c.author} · {timeAgo(c.indexedAt)}
            </span>
          </div>
        </div>
        <ChevronRight className={clsx("h-4 w-4 text-slate-500 transition-transform", open && "rotate-90")} />
      </button>
      {open && c.files && (
        <div className="border-t border-slate-800 px-4 py-2">
          {!c.files.length && <div className="py-2 text-xs text-slate-500">No indexable files changed.</div>}
          <ul className="divide-y divide-slate-800/60">
            {c.files.map((f) => (
              <li key={`${f.status}:${f.path}`} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5 font-mono text-[11px]">
                <span className={clsx("w-16", statusColor[f.status])}>{f.status}</span>
                <span className="min-w-0 flex-1 truncate text-slate-300">
                  {f.oldPath ? `${f.oldPath} → ` : ""}
                  {f.path}
                </span>
                <span className="text-slate-500">{f.hunks} hunks</span>
                <span className="text-slate-500">{f.touchedChunks} chunks touched</span>
                <span className="text-slate-500">
                  +{f.chunks.added} ~{f.chunks.updated} −{f.chunks.removed} ={f.chunks.unchanged}
                </span>
              </li>
            ))}
          </ul>
          {c.filesTruncated && <div className="pt-1 text-[11px] text-slate-500">List truncated.</div>}
        </div>
      )}
    </Card>
  );
}

export function RepoDetailPage() {
  const { id = "" } = useParams();
  const { openPreview } = useApp();
  const [filter, setFilter] = useState("");
  const detail = useQuery({ queryKey: ["repo", id], queryFn: () => api.repo(id), refetchInterval: 5000 });
  const commits = useQuery({ queryKey: ["commits", id], queryFn: () => api.commits(id, 30), refetchInterval: 10_000 });
  const tree = useQuery({ queryKey: ["tree", id, detail.data?.repo.lastIndexedCommit], queryFn: () => api.tree(id), enabled: !!detail.data });

  const files = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (tree.data ?? []).filter((x) => !f || x.path.toLowerCase().includes(f)).slice(0, 400);
  }, [tree.data, filter]);

  if (detail.isLoading) return <Spinner className="m-8 h-5 w-5 text-slate-500" />;
  if (detail.error) return <div className="p-6"><ErrorNote error={detail.error} /></div>;
  const repo = detail.data!.repo;

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-5 py-6">
      <div>
        <Link to="/repos" className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200">
          <ArrowLeft className="h-3 w-3" /> Repositories
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">{repo.name}</h1>
          <StatusBadge status={repo.status} />
        </div>
        <div className="font-mono text-xs text-slate-500">
          {repo.url} · {repo.branch} @ {shortSha(repo.lastIndexedCommit)} · {repo.chunking} chunking
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-300">Indexed commits</h2>
          <p className="text-xs text-slate-500">
            Each sync diffs the last indexed commit against the branch tip: only changed files are re-parsed, and only chunks whose content changed are re-embedded.
          </p>
          <ErrorNote error={commits.error} />
          {(commits.data ?? []).map((c) => (
            <CommitCard key={c._id} c={c} />
          ))}
          {commits.data && !commits.data.length && <div className="text-sm text-slate-500">No commits indexed yet.</div>}
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-300">Files ({tree.data?.length ?? 0})</h2>
          <input className={clsx(inputClass, "w-full")} placeholder="Filter files…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <Card className="max-h-[36rem] overflow-y-auto">
            <ul className="divide-y divide-slate-800/60">
              {files.map((f) => (
                <li key={f.path}>
                  <button className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-800/50" onClick={() => openPreview({ repoId: id, path: f.path })}>
                    <FileCode2 className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-300">{f.path}</span>
                    <span className="text-[10px] text-slate-500">{f.chunks}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          <h2 className="pt-2 text-sm font-semibold text-slate-300">Recent jobs</h2>
          <Card>
            <ul className="divide-y divide-slate-800/60 text-xs">
              {detail.data!.jobs.map((j) => (
                <li key={j._id} className="flex items-center gap-2 px-3 py-2">
                  <StatusBadge status={j.status} />
                  <span className="text-slate-300">{j.type}</span>
                  <span className="ml-auto text-slate-500">{timeAgo(j.createdAt)}</span>
                  {j.error && <span className="w-full truncate text-rose-300" title={j.error}>{j.error}</span>}
                </li>
              ))}
            </ul>
          </Card>
        </section>
      </div>
    </div>
  );
}
