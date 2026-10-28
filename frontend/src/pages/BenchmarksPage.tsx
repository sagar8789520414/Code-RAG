import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { FlaskConical, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Card, EmptyState, ErrorNote, Field, inputClass, ProgressBar, Spinner, StatusBadge } from "../components/ui";
import { api } from "../lib/api";
import { ms, pct, timeAgo } from "../lib/format";
import type { Benchmark, BenchmarkItem, ModeSummary } from "../lib/types";
import { useApp } from "../state/AppContext";

const MODES = [
  { id: "bm25", label: "BM25 only" },
  { id: "vector", label: "Vector only" },
  { id: "hybrid", label: "Hybrid (RRF)" },
  { id: "hybrid_rerank", label: "Hybrid + rerank" },
];

const METRICS: Array<keyof ModeSummary> = ["hit@1", "hit@3", "hit@5", "hit@10", "mrr", "recall@k"];

function SummaryTable({ b }: { b: Benchmark }) {
  const modes = b.modes.filter((m) => b.summary[m]);
  if (!modes.length) return <div className="px-4 py-6 text-sm text-slate-500">No results yet.</div>;
  const best = Object.fromEntries(METRICS.map((k) => [k, Math.max(...modes.map((m) => Number(b.summary[m]![k])))]));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-[11px] uppercase tracking-wider text-slate-500">
          <tr className="border-b border-slate-800">
            <th className="px-3 py-2">Mode</th>
            {METRICS.map((k) => (
              <th key={k} className="px-3 py-2 text-right">
                {k}
              </th>
            ))}
            <th className="px-3 py-2 text-right">avg latency</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/60">
          {modes.map((m) => {
            const s = b.summary[m]!;
            return (
              <tr key={m}>
                <td className="px-3 py-2 font-medium text-slate-200">{MODES.find((x) => x.id === m)?.label ?? m}</td>
                {METRICS.map((k) => {
                  const v = Number(s[k]);
                  return (
                    <td key={k} className="px-3 py-2 text-right">
                      <div className={clsx("font-mono", v === best[k] && v > 0 ? "font-semibold text-emerald-300" : "text-slate-300")}>{k === "mrr" ? v.toFixed(3) : pct(v)}</div>
                      <div className="ml-auto mt-1 h-1 w-16 overflow-hidden rounded bg-slate-800">
                        <div className="h-full bg-sky-500/70" style={{ width: `${Math.min(100, v * 100)}%` }} />
                      </div>
                    </td>
                  );
                })}
                <td className="px-3 py-2 text-right font-mono text-slate-400">{ms(s.avgLatencyMs)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function BenchmarkDetail({ id }: { id: string }) {
  const b = useQuery({
    queryKey: ["benchmark", id],
    queryFn: () => api.benchmark(id),
    refetchInterval: (q) => (q.state.data && ["queued", "running"].includes(q.state.data.status) ? 2000 : false),
  });
  const job = useQuery({
    queryKey: ["job", b.data?.jobId],
    queryFn: () => api.job(b.data!.jobId),
    enabled: !!b.data && ["queued", "running"].includes(b.data.status) && b.data.jobId !== "cli",
    refetchInterval: 2000,
  });
  if (!b.data) return <Spinner className="m-4 text-slate-500" />;
  const d = b.data;
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-4 py-3">
        <span className="font-semibold">{d.name}</span>
        <StatusBadge status={d.status} />
        <span className="text-xs text-slate-500">
          {d.datasetSize} questions · k={d.k} · {timeAgo(d.createdAt)}
        </span>
        {d.summary.meta && d.summary.meta.unresolvedExpectations > 0 && (
          <span className="text-xs text-amber-300">{d.summary.meta.unresolvedExpectations} expected targets not found in index</span>
        )}
      </div>
      {job.data && ["queued", "running"].includes(job.data.status) && (
        <div className="space-y-1 px-4 pt-3">
          <div className="text-[11px] text-slate-400">{job.data.progress.message ?? job.data.progress.phase}</div>
          <ProgressBar value={job.data.progress.current} total={job.data.progress.total} />
        </div>
      )}
      {d.error && (
        <div className="px-4 pt-3">
          <ErrorNote error={d.error} />
        </div>
      )}
      <SummaryTable b={d} />
      {!!d.perQuestion?.length && (
        <details className="border-t border-slate-800 px-4 py-3">
          <summary className="cursor-pointer text-xs font-medium text-slate-300">Per-question results (first relevant rank per mode)</summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-[11px]">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-1 pr-3">Question</th>
                  {d.modes.map((m) => (
                    <th key={m} className="px-2 py-1 text-right">
                      {m}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {d.perQuestion.map((q) => (
                  <tr key={q.id}>
                    <td className="max-w-md py-1.5 pr-3 text-slate-300" title={q.expected.map((e) => `${e.path}${e.symbol ? `#${e.symbol}` : ""}`).join(", ")}>
                      {q.question}
                    </td>
                    {d.modes.map((m) => {
                      const r = q.modes[m];
                      const rank = r?.firstHitRank;
                      return (
                        <td key={m} className={clsx("px-2 py-1.5 text-right font-mono", r?.error ? "text-rose-300" : rank === undefined ? "text-slate-600" : rank <= 3 ? "text-emerald-300" : "text-amber-300")}>
                          {r?.error ? "err" : (rank ?? "miss")}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </Card>
  );
}

export function BenchmarksPage() {
  const { repoId, repo } = useApp();
  const qc = useQueryClient();
  const [datasetText, setDatasetText] = useState("");
  const [name, setName] = useState("ground-truth");
  const [modes, setModes] = useState(MODES.map((m) => m.id));
  const [k, setK] = useState(10);
  const [selected, setSelected] = useState<string | undefined>();
  const [parseError, setParseError] = useState<string | undefined>();

  const samples = useQuery({ queryKey: ["benchmark-samples"], queryFn: api.benchmarkSamples, staleTime: Infinity });
  const list = useQuery({ queryKey: ["benchmarks", repoId], queryFn: () => api.benchmarks(repoId!), enabled: !!repoId, refetchInterval: 5000 });

  useEffect(() => {
    if (!selected && list.data?.[0]) setSelected(list.data[0]._id);
  }, [list.data, selected]);

  const run = useMutation({
    mutationFn: (dataset: BenchmarkItem[]) => api.runBenchmark({ repoId: repoId!, name, dataset, modes, k }),
    onSuccess: ({ benchmark }) => {
      setSelected(benchmark._id);
      void qc.invalidateQueries({ queryKey: ["benchmarks", repoId] });
    },
  });

  if (!repoId) return <EmptyState icon={<FlaskConical className="h-10 w-10" />} title="Select a repository first" />;

  const submit = () => {
    setParseError(undefined);
    try {
      const parsed = JSON.parse(datasetText) as unknown;
      const items = (Array.isArray(parsed) ? parsed : (parsed as { items?: unknown }).items) as BenchmarkItem[] | undefined;
      if (!Array.isArray(items) || !items.length) throw new Error("Dataset must be a non-empty array of { question, expected: [{ path, symbol? }] }");
      run.mutate(items);
    } catch (e) {
      setParseError((e as Error).message);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-5 py-6">
      <div>
        <h1 className="text-lg font-semibold">Retrieval benchmarks</h1>
        <p className="text-sm text-slate-400">
          Score retrieval against a ground-truth set of questions → expected files/symbols. Compare BM25, vector, hybrid RRF and reranked hybrid on <b>{repo?.name}</b>. Accuracy is hit@5: a relevant
          chunk appears in the top 5.
        </p>
      </div>

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-slate-300">Dataset</span>
          {samples.data?.map((s) => (
            <Button key={s.file} size="sm" variant="ghost" onClick={() => setDatasetText(JSON.stringify(s.items, null, 2))} title={s.description}>
              Load sample: {s.repo ?? s.file} ({s.size})
            </Button>
          ))}
        </div>
        <textarea
          className={clsx(inputClass, "h-56 w-full py-2 font-mono text-xs")}
          value={datasetText}
          onChange={(e) => setDatasetText(e.target.value)}
          placeholder={'[\n  { "question": "Where is the session token validated?", "expected": [{ "path": "src/auth/middleware.ts", "symbol": "verifySession" }] }\n]'}
          spellCheck={false}
        />
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Name">
            <input className={clsx(inputClass, "w-48")} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="k">
            <input className={clsx(inputClass, "w-20")} type="number" min={1} max={50} value={k} onChange={(e) => setK(Number(e.target.value))} />
          </Field>
          <div className="flex flex-wrap gap-3 pb-2">
            {MODES.map((m) => (
              <label key={m.id} className="flex items-center gap-1.5 text-sm text-slate-300">
                <input
                  type="checkbox"
                  className="accent-sky-500"
                  checked={modes.includes(m.id)}
                  onChange={(e) => setModes((prev) => (e.target.checked ? [...prev, m.id] : prev.filter((x) => x !== m.id)))}
                />
                {m.label}
              </label>
            ))}
          </div>
          <Button variant="primary" className="ml-auto" onClick={submit} disabled={run.isPending || !datasetText.trim() || !modes.length}>
            {run.isPending ? <Spinner /> : <Play className="h-4 w-4" />} Run benchmark
          </Button>
        </div>
        <ErrorNote error={parseError ?? run.error} />
      </Card>

      <div className="grid gap-5 lg:grid-cols-[16rem_1fr]">
        <Card className="h-fit">
          <div className="border-b border-slate-800 px-3 py-2 text-xs font-semibold text-slate-400">Runs</div>
          <ul className="max-h-[32rem] divide-y divide-slate-800/60 overflow-y-auto">
            {(list.data ?? []).map((b) => (
              <li key={b._id}>
                <button onClick={() => setSelected(b._id)} className={clsx("flex w-full flex-col gap-1 px-3 py-2 text-left hover:bg-slate-800/50", selected === b._id && "bg-slate-800/70")}>
                  <span className="flex items-center gap-2 text-sm text-slate-200">
                    <span className="truncate">{b.name}</span>
                    <StatusBadge status={b.status} />
                  </span>
                  <span className="text-[11px] text-slate-500">
                    {b.datasetSize} q · {timeAgo(b.createdAt)}
                    {b.summary.hybrid_rerank ? ` · hit@5 ${pct(b.summary.hybrid_rerank["hit@5"])}` : ""}
                  </span>
                </button>
              </li>
            ))}
            {list.data && !list.data.length && <li className="px-3 py-6 text-center text-xs text-slate-500">No runs yet</li>}
          </ul>
        </Card>
        <div>{selected ? <BenchmarkDetail id={selected} /> : <EmptyState title="Run a benchmark to see results" />}</div>
      </div>
    </div>
  );
}
