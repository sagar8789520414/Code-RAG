import clsx from "clsx";
import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { kindColor } from "../lib/format";

export function Button({
  variant = "secondary",
  size = "md",
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md" }) {
  return (
    <button
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
        variant === "primary" && "bg-sky-500 text-slate-950 hover:bg-sky-400",
        variant === "secondary" && "bg-slate-800 text-slate-100 ring-1 ring-slate-700 hover:bg-slate-700",
        variant === "ghost" && "text-slate-300 hover:bg-slate-800 hover:text-slate-100",
        variant === "danger" && "bg-rose-500/10 text-rose-300 ring-1 ring-rose-500/30 hover:bg-rose-500/20",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={clsx("rounded-xl border border-slate-800 bg-slate-900/60", className)}>{children}</div>;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx("animate-spin", className ?? "h-4 w-4")} aria-label="Loading" />;
}

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={clsx("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset", className ?? "bg-slate-800 text-slate-300 ring-slate-700")}>{children}</span>;
}

export function KindBadge({ kind }: { kind: string }) {
  return <Badge className={kindColor[kind] ?? kindColor.block}>{kind}</Badge>;
}

const statusStyles: Record<string, string> = {
  ready: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/30",
  completed: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/30",
  indexing: "bg-sky-500/10 text-sky-300 ring-sky-500/30",
  running: "bg-sky-500/10 text-sky-300 ring-sky-500/30",
  pending: "bg-amber-500/10 text-amber-300 ring-amber-500/30",
  queued: "bg-amber-500/10 text-amber-300 ring-amber-500/30",
  error: "bg-rose-500/10 text-rose-300 ring-rose-500/30",
  failed: "bg-rose-500/10 text-rose-300 ring-rose-500/30",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge className={statusStyles[status]}>
      {(status === "indexing" || status === "running") && <Spinner className="h-3 w-3" />}
      {status}
    </Badge>
  );
}

export function ProgressBar({ value, total }: { value: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
      <div className={clsx("h-full rounded-full bg-sky-400 transition-all", total === 0 && "w-1/3 animate-pulse")} style={total > 0 ? { width: `${pct}%` } : undefined} />
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      {icon && <div className="text-slate-500">{icon}</div>}
      <h3 className="text-base font-semibold text-slate-200">{title}</h3>
      {children && <div className="max-w-md text-sm text-slate-400">{children}</div>}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error instanceof Error ? error.message : String(error)}</div>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium text-slate-300">{label}</span>
      {children}
      {hint && <span className="text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "h-9 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500";
