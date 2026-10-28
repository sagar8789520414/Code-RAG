import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Activity, Database, FlaskConical, GitBranch, MessageSquareCode, ScanSearch, Settings as SettingsIcon } from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet } from "react-router";
import { api } from "../lib/api";
import { useApp } from "../state/AppContext";
import { CodePreviewDrawer } from "./CodePreviewDrawer";
import { SettingsDialog } from "./SettingsDialog";
import { StatusBadge } from "./ui";

const nav = [
  { to: "/", label: "Ask", icon: MessageSquareCode, end: true },
  { to: "/search", label: "Retrieval inspector", icon: ScanSearch },
  { to: "/repos", label: "Repositories", icon: GitBranch },
  { to: "/benchmarks", label: "Benchmarks", icon: FlaskConical },
];

function HealthIndicator() {
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 30_000, retry: false });
  const h = health.data;
  const dot = (ok: boolean | undefined) => <span className={clsx("inline-block h-1.5 w-1.5 rounded-full", ok === undefined ? "bg-slate-600" : ok ? "bg-emerald-400" : "bg-rose-400")} />;
  if (health.isError) {
    return <div className="rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300 ring-1 ring-rose-500/20">API unreachable</div>;
  }
  return (
    <div className="space-y-1.5 rounded-lg bg-slate-900/80 px-3 py-2 text-[11px] text-slate-400 ring-1 ring-slate-800">
      <div className="flex items-center gap-1.5 font-medium text-slate-300">
        <Activity className="h-3 w-3" /> System
      </div>
      <div className="grid grid-cols-2 gap-x-2 gap-y-1">
        <span className="flex items-center gap-1.5">{dot(h?.services.mongo)} MongoDB</span>
        <span className="flex items-center gap-1.5">{dot(h?.services.redis)} Redis</span>
        {h?.llm.map((b) => (
          <span key={b.name} className="flex items-center gap-1.5" title={b.lastError ?? `circuit ${b.state}`}>
            {dot(b.state === "closed" ? true : b.state === "half_open" ? undefined : false)} {b.name}
          </span>
        ))}
      </div>
      {h?.index && (
        <div className="flex items-center gap-1.5 text-slate-500">
          <Database className="h-3 w-3" /> {h.index.numDocs.toLocaleString()} chunks indexed
        </div>
      )}
    </div>
  );
}

export function Layout() {
  const { repos, repoId, selectRepo, repo } = useApp();
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className="flex h-dvh overflow-hidden text-slate-100">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-slate-800/80 bg-slate-950/80 backdrop-blur md:flex">
        <div className="flex items-center gap-2.5 px-4 py-4">
          <img src="/favicon.svg" alt="" className="h-8 w-8 rounded-lg ring-1 ring-sky-400/30" />
          <div>
            <div className="text-sm font-semibold tracking-tight">CodeRAG</div>
            <div className="text-[11px] text-slate-500">codebase onboarding</div>
          </div>
        </div>

        <div className="px-3 pb-3">
          <label className="mb-1 block px-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500" htmlFor="repo-select">
            Repository
          </label>
          <select
            id="repo-select"
            value={repoId ?? ""}
            onChange={(e) => selectRepo(e.target.value)}
            className="h-9 w-full rounded-lg border border-slate-700 bg-slate-900 px-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none"
          >
            {!repos.length && <option value="">No repositories yet</option>}
            {repos.map((r) => (
              <option key={r._id} value={r._id}>
                {r.name}
                {r.status !== "ready" ? ` (${r.status})` : ""}
              </option>
            ))}
          </select>
          {repo && (
            <div className="mt-1.5 flex items-center gap-2 px-1 text-[11px] text-slate-500">
              <StatusBadge status={repo.status} />
              <span>
                {repo.stats.files} files · {repo.stats.chunks} chunks
              </span>
            </div>
          )}
        </div>

        <nav className="flex flex-col gap-0.5 px-2">
          {nav.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                clsx(
                  "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
                  isActive ? "bg-sky-500/10 text-white shadow-[inset_2px_0_0_#38bdf8]" : "text-slate-400 hover:bg-slate-900 hover:text-slate-100",
                )
              }
            >
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto space-y-2 p-3">
          <HealthIndicator />
          <button onClick={() => setSettingsOpen(true)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-slate-900 hover:text-slate-100">
            <SettingsIcon className="h-4 w-4" /> Settings
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Compact top bar on small screens */}
        <header className="flex items-center gap-2 overflow-x-auto border-b border-slate-800 px-3 py-2 md:hidden">
          <img src="/favicon.svg" alt="" className="h-6 w-6" />
          <select value={repoId ?? ""} onChange={(e) => selectRepo(e.target.value)} className="h-8 max-w-[40vw] rounded-md border border-slate-700 bg-slate-900 px-2 text-xs">
            {repos.map((r) => (
              <option key={r._id} value={r._id}>
                {r.name}
              </option>
            ))}
          </select>
          {nav.map(({ to, icon: Icon, end, label }) => (
            <NavLink key={to} to={to} end={end} aria-label={label} className={({ isActive }) => clsx("rounded-md p-1.5", isActive ? "bg-slate-800 text-white" : "text-slate-400")}>
              <Icon className="h-4 w-4" />
            </NavLink>
          ))}
          <button onClick={() => setSettingsOpen(true)} className="ml-auto rounded-md p-1.5 text-slate-400" aria-label="Settings">
            <SettingsIcon className="h-4 w-4" />
          </button>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>

      <CodePreviewDrawer />
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
