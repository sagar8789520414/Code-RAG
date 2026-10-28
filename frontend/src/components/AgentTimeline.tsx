import clsx from "clsx";
import { AlertTriangle, BrainCircuit, CheckCircle2, ChevronDown, GitBranch, ListChecks, PenLine, Search } from "lucide-react";
import { useState } from "react";
import { ms } from "../lib/format";
import type { AgentStep, StepKind } from "../lib/types";
import { Spinner } from "./ui";

const icons: Record<StepKind, typeof Search> = {
  plan: BrainCircuit,
  retrieve: Search,
  expand: GitBranch,
  evaluate: ListChecks,
  synthesize: PenLine,
};

interface RetrieveData {
  hits?: Array<{ path: string; symbol: string; lines: [number, number]; bm25Rank?: number; vectorRank?: number; rerankScore?: number }>;
}
interface PlanData {
  intent?: string;
  sub_queries?: Array<{ query: string; purpose?: string }>;
}

function StepDetail({ step, onOpen }: { step: AgentStep; onOpen?: (path: string, lines: [number, number]) => void }) {
  if (step.kind === "plan") {
    const d = step.data as PlanData | undefined;
    if (!d?.sub_queries?.length) return null;
    return (
      <ol className="mt-1.5 space-y-1 pl-4 text-xs text-slate-400">
        {d.sub_queries.map((q, i) => (
          <li key={i} className="list-decimal">
            <span className="text-slate-200">{q.query}</span>
            {q.purpose && <span className="text-slate-500"> — {q.purpose}</span>}
          </li>
        ))}
      </ol>
    );
  }
  if (step.kind === "retrieve") {
    const d = step.data as RetrieveData | undefined;
    if (!d?.hits?.length) return null;
    return (
      <ul className="mt-1.5 space-y-0.5">
        {d.hits.map((h, i) => (
          <li key={i}>
            <button className="group flex w-full items-center gap-2 rounded px-1 py-0.5 text-left font-mono text-[11px] hover:bg-slate-800/60" onClick={() => onOpen?.(h.path, h.lines)}>
              <span className="w-4 text-right text-slate-600">{i + 1}</span>
              <span className="truncate text-slate-300 group-hover:text-sky-300">
                {h.path}
                <span className="text-slate-500">:{h.lines[0]}</span>
              </span>
              <span className="ml-auto flex shrink-0 gap-2 text-slate-500">
                <span title="BM25 rank">b{h.bm25Rank ?? "–"}</span>
                <span title="Vector rank">v{h.vectorRank ?? "–"}</span>
                {h.rerankScore !== undefined && <span title="Rerank score" className="text-violet-300">r{h.rerankScore}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    );
  }
  return null;
}

export function AgentTimeline({ steps, live, onOpen }: { steps: AgentStep[]; live: boolean; onOpen?: (path: string, lines: [number, number]) => void }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (!steps.length) return null;
  const total = steps.reduce((a, s) => a + (s.durationMs ?? 0), 0);
  const running = steps.find((s) => s.status === "running");

  return (
    <div className="mb-3 rounded-lg border border-slate-800 bg-slate-900/40">
      <button className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-slate-400 hover:text-slate-200" onClick={() => setOpen((v) => !v)} aria-expanded={open || live}>
        {running ? <Spinner className="h-3.5 w-3.5 text-sky-400" /> : <BrainCircuit className="h-3.5 w-3.5 text-violet-400" />}
        <span className="font-medium">{running ? running.title : `Agent reasoning · ${steps.length} steps`}</span>
        {!running && <span className="text-slate-600">· {ms(total)}</span>}
        <ChevronDown className={clsx("ml-auto h-3.5 w-3.5 transition-transform", (open || live) && "rotate-180")} />
      </button>
      {(open || live) && (
        <ol className="space-y-1 border-t border-slate-800 px-3 py-2">
          {steps.map((s) => {
            const Icon = icons[s.kind];
            const hasDetail = s.kind === "plan" || s.kind === "retrieve";
            return (
              <li key={s.id} className="text-xs">
                <div className="flex items-start gap-2">
                  <span className="mt-0.5">
                    {s.status === "running" ? (
                      <Spinner className="h-3.5 w-3.5 text-sky-400" />
                    ) : s.status === "error" ? (
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                    ) : (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400/80" />
                    )}
                  </span>
                  <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500" />
                  <div className="min-w-0 flex-1">
                    <button className={clsx("text-left text-slate-200", hasDetail && "hover:text-sky-300")} onClick={() => hasDetail && setExpanded((e) => ({ ...e, [s.id]: !e[s.id] }))}>
                      {s.title}
                    </button>
                    {s.detail && <div className="text-slate-500">{s.detail}</div>}
                    {expanded[s.id] && <StepDetail step={s} onOpen={onOpen} />}
                  </div>
                  {s.durationMs !== undefined && <span className="shrink-0 tabular-nums text-slate-600">{ms(s.durationMs)}</span>}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
