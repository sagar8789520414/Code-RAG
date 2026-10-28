import { ChevronRight, FileCode2 } from "lucide-react";

/** `src › auth › middleware.ts › AuthService.validate · L10–42` */
export function Breadcrumb({ path, symbol, startLine, endLine, compact }: { path: string; symbol?: string; startLine?: number; endLine?: number; compact?: boolean }) {
  const parts = path.split("/");
  const shown = compact && parts.length > 3 ? ["…", ...parts.slice(-2)] : parts;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-0.5 font-mono text-xs text-slate-400">
      <FileCode2 className="mr-1 h-3.5 w-3.5 shrink-0 text-slate-500" />
      {shown.map((p, i) => (
        <span key={i} className="inline-flex items-center gap-0.5">
          {i > 0 && <ChevronRight className="h-3 w-3 text-slate-600" />}
          <span className={i === shown.length - 1 ? "text-slate-200" : ""}>{p}</span>
        </span>
      ))}
      {symbol && symbol !== path && (
        <span className="inline-flex items-center gap-0.5">
          <ChevronRight className="h-3 w-3 text-slate-600" />
          <span className="text-sky-300">{symbol}</span>
        </span>
      )}
      {startLine !== undefined && (
        <span className="ml-1.5 text-slate-500">
          L{startLine}
          {endLine && endLine !== startLine ? `–${endLine}` : ""}
        </span>
      )}
    </span>
  );
}
