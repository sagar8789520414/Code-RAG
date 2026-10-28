import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Check, Copy, ListTree, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { shortSha } from "../lib/format";
import { useApp } from "../state/AppContext";
import { Breadcrumb } from "./Breadcrumb";
import { CodeViewer } from "./CodeViewer";
import { ErrorNote, KindBadge, Spinner } from "./ui";

/** Right-hand drawer showing a whole indexed file with the cited range highlighted. */
export function CodePreviewDrawer() {
  const { preview, closePreview } = useApp();
  const [range, setRange] = useState<[number, number] | undefined>();
  const [copied, setCopied] = useState(false);
  const [showOutline, setShowOutline] = useState(true);

  useEffect(() => {
    setRange(preview?.startLine ? [preview.startLine, preview.endLine ?? preview.startLine] : undefined);
  }, [preview]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closePreview();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closePreview]);

  const file = useQuery({
    queryKey: ["file", preview?.repoId, preview?.path],
    queryFn: () => api.file(preview!.repoId, preview!.path),
    enabled: !!preview,
    staleTime: 60_000,
  });

  if (!preview) return null;
  const ref = `${preview.path}${range ? `:${range[0]}${range[1] !== range[0] ? `-${range[1]}` : ""}` : ""}`;
  const outline = (file.data?.chunks ?? []).filter((c) => c.kind !== "file");

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-950/50 backdrop-blur-[2px]" onClick={closePreview}>
      <aside
        className="flex h-full w-full max-w-5xl flex-col border-l border-slate-800 bg-slate-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Preview of ${preview.path}`}
      >
        <header className="flex items-center gap-3 border-b border-slate-800 px-4 py-3">
          <div className="min-w-0 flex-1">
            <Breadcrumb path={preview.path} startLine={range?.[0]} endLine={range?.[1]} />
            {file.data && (
              <div className="mt-1 text-[11px] text-slate-500">
                {file.data.language} · {file.data.content.split("\n").length} lines · {outline.length} chunks · indexed at {shortSha(file.data.commit)}
              </div>
            )}
          </div>
          <button
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
            title="Copy path:line"
            onClick={() => {
              void navigator.clipboard?.writeText(ref);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
          >
            {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
          </button>
          <button className={clsx("rounded-md p-1.5 hover:bg-slate-800", showOutline ? "text-sky-300" : "text-slate-400")} title="Toggle chunk outline" onClick={() => setShowOutline((v) => !v)}>
            <ListTree className="h-4 w-4" />
          </button>
          <button className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100" onClick={closePreview} aria-label="Close preview">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 overflow-hidden p-3">
            {file.isLoading && (
              <div className="flex h-full items-center justify-center">
                <Spinner className="h-6 w-6 text-slate-500" />
              </div>
            )}
            <ErrorNote error={file.error} />
            {file.data && <CodeViewer code={file.data.content} language={file.data.language} highlight={range} scrollToHighlight className="h-full" />}
          </div>
          {showOutline && outline.length > 0 && (
            <nav className="hidden w-72 shrink-0 overflow-y-auto border-l border-slate-800 p-2 lg:block" aria-label="AST chunks in file">
              <div className="px-2 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">AST chunks</div>
              {outline.map((c) => {
                const active = range && c.startLine === range[0] && c.endLine === range[1];
                return (
                  <button
                    key={c.id}
                    onClick={() => setRange([c.startLine, c.endLine])}
                    className={clsx("flex w-full flex-col gap-1 rounded-md px-2 py-1.5 text-left hover:bg-slate-800/70", active && "bg-sky-500/10 ring-1 ring-sky-500/30")}
                  >
                    <span className="flex items-center gap-1.5">
                      <KindBadge kind={c.kind} />
                      <span className="truncate font-mono text-xs text-slate-200">{c.symbolPath || c.name}</span>
                    </span>
                    <span className="font-mono text-[10px] text-slate-500">
                      L{c.startLine}–{c.endLine}
                    </span>
                  </button>
                );
              })}
            </nav>
          )}
        </div>
      </aside>
    </div>
  );
}
