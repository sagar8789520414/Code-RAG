import { useMutation } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowDown, ArrowUp, Minus, ScanSearch } from "lucide-react";
import { useState } from "react";
import { Breadcrumb } from "../components/Breadcrumb";
import { Button, Card, EmptyState, ErrorNote, inputClass, KindBadge, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { ms } from "../lib/format";
import type { StageHit } from "../lib/types";
import { useApp } from "../state/AppContext";

function Movement({ from, to }: { from: number; to: number }) {
  if (from === to) return <Minus className="h-3 w-3 text-slate-600" />;
  return from > to ? (
    <span className="inline-flex items-center text-[10px] text-emerald-400">
      <ArrowUp className="h-3 w-3" />
      {from - to}
    </span>
  ) : (
    <span className="inline-flex items-center text-[10px] text-rose-400">
      <ArrowDown className="h-3 w-3" />
      {to - from}
    </span>
  );
}

function StageList({ title, hits, onOpen, highlight }: { title: string; hits: StageHit[]; onOpen: (h: StageHit) => void; highlight: Set<string> }) {
  return (
    <Card className="min-w-0">
      <div className="border-b border-slate-800 px-3 py-2 text-xs font-semibold text-slate-300">{title}</div>
      <ol className="max-h-[28rem] divide-y divide-slate-800/60 overflow-y-auto">
        {hits.map((h) => (
          <li key={h.id}>
            <button onClick={() => onOpen(h)} className={clsx("flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-800/50", highlight.has(h.id) && "bg-sky-500/5")}>
              <span className="w-5 text-right font-mono text-[11px] text-slate-500">{h.rank}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-300">
                {h.chunk ? `${h.chunk.path}` : h.id}
                {h.chunk && <span className="text-sky-300/80"> {h.chunk.kind !== "file" ? h.chunk.symbolPath : ""}</span>}
              </span>
              <span className="font-mono text-[10px] text-slate-500">{h.score.toFixed(3)}</span>
            </button>
          </li>
        ))}
        {!hits.length && <li className="px-3 py-6 text-center text-xs text-slate-500">no candidates</li>}
      </ol>
    </Card>
  );
}

export function SearchPage() {
  const { repoId, openPreview } = useApp();
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"hybrid" | "bm25" | "vector">("hybrid");
  const [rerank, setRerank] = useState(true);
  const [k, setK] = useState(10);
  const [pathPrefix, setPathPrefix] = useState("");

  const search = useMutation({
    mutationFn: () => api.search({ repoId: repoId!, query, k, mode, rerank, ...(pathPrefix ? { filters: { pathPrefix } } : {}) }),
  });

  if (!repoId) return <EmptyState icon={<ScanSearch className="h-10 w-10" />} title="Select a repository first" />;
  const data = search.data;
  const finalIds = new Set(data?.results.map((r) => r.chunk.id));

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-5 py-6">
      <div>
        <h1 className="text-lg font-semibold">Retrieval inspector</h1>
        <p className="text-sm text-slate-400">See each stage: BM25 (sparse) and HNSW (dense) candidates, Reciprocal Rank Fusion, then the LLM reranker.</p>
      </div>

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim().length >= 2) search.mutate();
        }}
      >
        <input className={clsx(inputClass, "min-w-[18rem] flex-1")} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search query, e.g. verify jwt session token" aria-label="Query" />
        <input className={clsx(inputClass, "w-40")} value={pathPrefix} onChange={(e) => setPathPrefix(e.target.value)} placeholder="path prefix (opt.)" aria-label="Path prefix filter" />
        <select className={clsx(inputClass, "w-28")} value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} aria-label="Mode">
          <option value="hybrid">hybrid</option>
          <option value="bm25">bm25</option>
          <option value="vector">vector</option>
        </select>
        <select className={clsx(inputClass, "w-20")} value={k} onChange={(e) => setK(Number(e.target.value))} aria-label="Top k">
          {[5, 10, 20].map((n) => (
            <option key={n} value={n}>
              k={n}
            </option>
          ))}
        </select>
        <label className="flex h-9 items-center gap-1.5 px-1 text-sm text-slate-300">
          <input type="checkbox" checked={rerank} onChange={(e) => setRerank(e.target.checked)} className="accent-sky-500" /> rerank
        </label>
        <Button type="submit" variant="primary" disabled={search.isPending || query.trim().length < 2}>
          {search.isPending ? <Spinner /> : <ScanSearch className="h-4 w-4" />} Search
        </Button>
      </form>

      <ErrorNote error={search.error} />

      {data && (
        <>
          <div className="flex flex-wrap gap-2 text-xs">
            {Object.entries(data.timings).map(([k2, v]) => (
              <span key={k2} className="rounded-md bg-slate-900 px-2 py-1 text-slate-400 ring-1 ring-slate-800">
                {k2.replace(/Ms$/, "")} <b className="text-slate-200">{ms(v)}</b>
              </span>
            ))}
            <span className="rounded-md bg-slate-900 px-2 py-1 text-slate-400 ring-1 ring-slate-800">
              RRF k=<b className="text-slate-200">{data.rrfK}</b>
            </span>
            <span className="rounded-md bg-slate-900 px-2 py-1 text-slate-400 ring-1 ring-slate-800">
              BM25 terms: <b className="font-mono text-slate-200">{data.terms.join(" | ") || "—"}</b>
            </span>
            {data.degraded && <span className="rounded-md bg-amber-500/10 px-2 py-1 text-amber-300 ring-1 ring-amber-500/30">degraded: {data.degraded}</span>}
            {data.rerankError && <span className="rounded-md bg-amber-500/10 px-2 py-1 text-amber-300 ring-1 ring-amber-500/30">rerank skipped: {data.rerankError.slice(0, 100)}</span>}
            {data.llmCalls.map((c, i) => (
              <span key={i} className={clsx("rounded-md px-2 py-1 ring-1", c.ok ? "bg-slate-900 text-slate-400 ring-slate-800" : "bg-rose-500/10 text-rose-300 ring-rose-500/30")}>
                {c.purpose}: {c.provider}
                {c.fallbackReason ? ` (fallback: ${c.fallbackReason})` : ""} {ms(c.latencyMs)}
              </span>
            ))}
          </div>

          <Card>
            <div className="border-b border-slate-800 px-4 py-2.5 text-sm font-semibold">Final ranking {data.reranked ? "(reranked)" : "(RRF)"}</div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-[11px] uppercase tracking-wider text-slate-500">
                  <tr className="border-b border-slate-800">
                    <th className="px-3 py-2">#</th>
                    <th className="px-3 py-2">Chunk</th>
                    <th className="px-3 py-2 text-right">BM25</th>
                    <th className="px-3 py-2 text-right">Vector</th>
                    <th className="px-3 py-2 text-right">RRF</th>
                    <th className="px-3 py-2 text-right">Rerank</th>
                    <th className="px-3 py-2">Δ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {data.results.map((r) => (
                    <tr key={r.chunk.id} className="cursor-pointer hover:bg-slate-800/40" onClick={() => openPreview({ repoId, path: r.chunk.path, startLine: r.chunk.startLine, endLine: r.chunk.endLine })}>
                      <td className="px-3 py-2 font-mono text-slate-400">{r.rank}</td>
                      <td className="max-w-0 px-3 py-2">
                        <div className="flex items-center gap-2">
                          <KindBadge kind={r.chunk.kind} />
                          <span className="truncate">
                            <Breadcrumb path={r.chunk.path} symbol={r.chunk.kind === "file" ? undefined : r.chunk.symbolPath} startLine={r.chunk.startLine} endLine={r.chunk.endLine} compact />
                          </span>
                        </div>
                        {r.chunk.signature && <div className="mt-1 truncate font-mono text-[11px] text-slate-500">{r.chunk.signature}</div>}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-400">{r.bm25Rank ?? "–"}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-400">{r.vectorRank ?? "–"}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-400">
                        {r.rrfRank} <span className="text-slate-600">({r.rrfScore.toFixed(4)})</span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-violet-300">{r.rerankScore ?? "–"}</td>
                      <td className="px-3 py-2">
                        <Movement from={r.rrfRank} to={r.rank} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!data.results.length && <div className="px-4 py-8 text-center text-sm text-slate-500">No results.</div>}
            </div>
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            <StageList
              title={`BM25 · top ${data.stages.bm25.length}`}
              hits={data.stages.bm25}
              highlight={finalIds}
              onOpen={(h) => h.chunk && openPreview({ repoId, path: h.chunk.path, startLine: h.chunk.startLine, endLine: h.chunk.endLine })}
            />
            <StageList
              title={`Vector (HNSW cosine) · top ${data.stages.vector.length}`}
              hits={data.stages.vector}
              highlight={finalIds}
              onOpen={(h) => h.chunk && openPreview({ repoId, path: h.chunk.path, startLine: h.chunk.startLine, endLine: h.chunk.endLine })}
            />
          </div>
        </>
      )}
    </div>
  );
}
