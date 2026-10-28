import clsx from "clsx";
import { ChevronLeft, ChevronRight, GalleryHorizontal, GitBranch, LayoutGrid } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SourceRef } from "../lib/types";
import { KindBadge } from "./ui";

const PAGE_SIZE = 4;
const SWIPE_PX = 40;

function SourceCard({ s, active, onOpen }: { s: SourceRef; active: boolean; onOpen: (s: SourceRef) => void }) {
  const parts = s.path.split("/");
  const file = parts.pop();
  const dir = parts.join("/");
  return (
    <button
      onClick={() => onOpen(s)}
      title={`${s.path}:${s.startLine}-${s.endLine}`}
      className={clsx(
        "group flex h-full min-w-0 flex-col gap-1 rounded-xl border bg-slate-900/70 p-3 text-left transition-colors",
        active ? "border-sky-400/60 ring-1 ring-sky-400/40" : "border-slate-800 hover:border-sky-500/40 hover:bg-slate-900",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md bg-sky-500/15 px-1 font-mono text-[10.5px] font-semibold text-sky-300">{s.n}</span>
        <span className="truncate font-mono text-xs font-medium text-slate-100 group-hover:text-sky-200">{file}</span>
      </span>
      {dir && <span className="truncate font-mono text-[10.5px] text-slate-500">{dir}/</span>}
      {s.kind !== "file" && <span className="truncate font-mono text-[11px] text-sky-300/90">{s.symbolPath}</span>}
      <span className="mt-auto flex flex-wrap items-center gap-1.5 pt-1.5">
        <KindBadge kind={s.kind} />
        <span className="font-mono text-[10px] text-slate-500">
          L{s.startLine}–{s.endLine}
        </span>
        {s.via.includes("call-graph") && (
          <span className="inline-flex items-center gap-0.5 text-[10px] text-violet-300">
            <GitBranch className="h-3 w-3" /> call graph
          </span>
        )}
      </span>
    </button>
  );
}

function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 ring-1 ring-slate-800 transition-colors hover:bg-slate-800 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-30"
    >
      {children}
    </button>
  );
}

/**
 * Shows four sources at a time as a slider (arrows, dots, swipe, arrow keys), with a toggle
 * to expand into a full grid. Jumps to the page holding `activeN` when a citation is clicked.
 */
export function SourceList({ sources, onOpen, activeN }: { sources: SourceRef[]; onOpen: (s: SourceRef) => void; activeN?: number }) {
  const [page, setPage] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const touchX = useRef<number | null>(null);
  const pages = Math.max(1, Math.ceil(sources.length / PAGE_SIZE));

  useEffect(() => {
    if (activeN) setPage(Math.floor((activeN - 1) / PAGE_SIZE));
  }, [activeN]);
  useEffect(() => {
    if (page > pages - 1) setPage(pages - 1);
  }, [page, pages]);

  if (!sources.length) return null;
  const go = (p: number) => setPage(Math.min(pages - 1, Math.max(0, p)));
  const from = page * PAGE_SIZE + 1;
  const to = Math.min(sources.length, (page + 1) * PAGE_SIZE);
  const sliding = !showAll && pages > 1;

  return (
    <section className="mt-5" aria-label="Sources">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Sources</span>
        <span className="rounded-full bg-slate-800 px-1.5 py-px text-[10px] font-medium text-slate-400">{sources.length}</span>
        <div className="ml-auto flex items-center gap-1.5">
          {sliding && (
            <>
              <span className="mr-0.5 whitespace-nowrap font-mono text-[11px] text-slate-500" aria-live="polite">
                {from}–{to} of {sources.length}
              </span>
              <IconButton label="Previous sources" disabled={page === 0} onClick={() => go(page - 1)}>
                <ChevronLeft className="h-4 w-4" />
              </IconButton>
              <IconButton label="Next sources" disabled={page === pages - 1} onClick={() => go(page + 1)}>
                <ChevronRight className="h-4 w-4" />
              </IconButton>
            </>
          )}
          {sources.length > PAGE_SIZE && (
            <button
              onClick={() => setShowAll((v) => !v)}
              aria-label={showAll ? "Show sources as slider" : "Show all sources"}
              title={showAll ? "Slider" : "Show all"}
              className="inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-lg px-2 text-[11px] text-slate-400 ring-1 ring-slate-800 transition-colors hover:bg-slate-800 hover:text-slate-100"
            >
              {showAll ? <GalleryHorizontal className="h-3.5 w-3.5" /> : <LayoutGrid className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">{showAll ? "Slider" : "Show all"}</span>
            </button>
          )}
        </div>
      </div>

      {showAll ? (
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {sources.map((s) => (
            <SourceCard key={s.chunkId} s={s} active={s.n === activeN} onOpen={onOpen} />
          ))}
        </div>
      ) : (
        <div
          className="overflow-hidden rounded-xl p-px focus-visible:outline-2 focus-visible:outline-sky-500"
          tabIndex={sliding ? 0 : -1}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") go(page + 1);
            if (e.key === "ArrowLeft") go(page - 1);
          }}
          onTouchStart={(e) => (touchX.current = e.touches[0]?.clientX ?? null)}
          onTouchEnd={(e) => {
            const start = touchX.current;
            const end = e.changedTouches[0]?.clientX;
            touchX.current = null;
            if (start === null || end === undefined || Math.abs(end - start) < SWIPE_PX) return;
            go(end < start ? page + 1 : page - 1);
          }}
        >
          <div className="flex transition-transform duration-300 ease-out" style={{ transform: `translateX(-${page * 100}%)` }}>
            {Array.from({ length: pages }, (_, p) => (
              <div key={p} className="grid w-full shrink-0 grid-cols-2 gap-2 lg:grid-cols-4" inert={p !== page} aria-hidden={p !== page}>
                {sources.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE).map((s) => (
                  <SourceCard key={s.chunkId} s={s} active={s.n === activeN} onOpen={onOpen} />
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {sliding && (
        <div className="mt-2.5 flex justify-center gap-1.5">
          {Array.from({ length: pages }, (_, p) => (
            <button
              key={p}
              aria-label={`Sources page ${p + 1}`}
              aria-current={p === page}
              onClick={() => go(p)}
              className={clsx("h-1.5 rounded-full transition-all", p === page ? "w-5 bg-sky-400" : "w-1.5 bg-slate-700 hover:bg-slate-500")}
            />
          ))}
        </div>
      )}
    </section>
  );
}
